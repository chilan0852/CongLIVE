import { readFileSync } from 'node:fs';
import os from 'node:os';

// The capacity endpoint is polled by every client that opens the publish
// settings page, so the host sample is cached for a short window. 2s keeps the
// advice responsive without adding /proc reads or DB queries per request.
export const CAPACITY_CACHE_MS = 2000;

// Single source of truth for the quality gates. The API response, the
// recommended profile and the human readable reason all derive from here.
export const CAPACITY_LIMITS = Object.freeze({
  allow1080p: Object.freeze({ minCores: 2, minFreeMb: 512, maxLoadPerCore: 0.9 }),
  allow1080p60: Object.freeze({ minCores: 4, minFreeMb: 1536, maxLoadPerCore: 0.65, maxActiveRooms: 2 }),
});

// Bitrates are bits per second, matching the Android/Web publish settings.
const PROFILES = Object.freeze({
  '1080p60': Object.freeze({ w: 1920, h: 1080, fps: 60, bitrate: 6000000 }),
  '1080p30': Object.freeze({ w: 1920, h: 1080, fps: 30, bitrate: 4000000 }),
  '720p30': Object.freeze({ w: 1280, h: 720, fps: 30, bitrate: 2500000 }),
  '540p24': Object.freeze({ w: 960, h: 540, fps: 24, bitrate: 1200000 }),
});

const MIB = 1024 * 1024;
const loadPerCoreLimit1080p = CAPACITY_LIMITS.allow1080p.maxLoadPerCore;
const loadPerCoreLimit1080p60 = CAPACITY_LIMITS.allow1080p60.maxLoadPerCore;

const numberOf = (value, fallback = 0) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Read host memory in MiB.
 *
 * os.freemem() reports MemFree, which on Linux looks tiny even on a healthy
 * box because page cache is counted as used. MemAvailable is the number a
 * capacity decision actually wants; fall back to os.freemem() if /proc is not
 * readable (e.g. non-Linux dev machines or restricted sandboxes).
 */
function readHostMemoryMb() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const read = (key) => {
      const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
      return match ? Number(match[1]) : null;
    };
    const totalKb = read('MemTotal');
    const freeKb = read('MemAvailable') ?? read('MemFree');
    if (Number.isFinite(totalKb) && totalKb > 0) {
      return {
        totalMb: Math.round(totalKb / 1024),
        freeMb: Math.round(Math.max(0, Number.isFinite(freeKb) ? freeKb : 0) / 1024),
      };
    }
  } catch { /* fall through to os.* */ }
  return {
    totalMb: Math.round(os.totalmem() / MIB),
    freeMb: Math.round(os.freemem() / MIB),
  };
}

/** Sample the host the API is running on (the VPS, not the cgroup). */
export function sampleHostStats() {
  const memory = readHostMemoryMb();
  const load = os.loadavg();
  return {
    cpuCores: os.cpus().length || 1,
    load1: Number.isFinite(load[0]) ? load[0] : 0,
    memoryFreeMb: memory.freeMb,
    memoryTotalMb: memory.totalMb,
  };
}

function shortfall1080p({ cpuCores, loadPerCore, memoryFreeMb }) {
  const limits = CAPACITY_LIMITS.allow1080p;
  const reasons = [];
  if (cpuCores < limits.minCores) reasons.push(`需要 ≥${limits.minCores} 核 CPU（当前 ${cpuCores} 核）`);
  if (loadPerCore >= limits.maxLoadPerCore) reasons.push(`需要单核负载 <${limits.maxLoadPerCore}（当前 ${round2(loadPerCore)}）`);
  if (memoryFreeMb <= limits.minFreeMb) reasons.push(`需要可用内存 >${limits.minFreeMb}MB（当前 ${memoryFreeMb}MB）`);
  return reasons;
}

function shortfall1080p60({ cpuCores, loadPerCore, memoryFreeMb, activeRooms }) {
  const limits = CAPACITY_LIMITS.allow1080p60;
  const reasons = [];
  if (cpuCores < limits.minCores) reasons.push(`需要 ≥${limits.minCores} 核 CPU（当前 ${cpuCores} 核）`);
  if (loadPerCore >= limits.maxLoadPerCore) reasons.push(`需要单核负载 <${limits.maxLoadPerCore}（当前 ${round2(loadPerCore)}）`);
  if (memoryFreeMb <= limits.minFreeMb) reasons.push(`需要可用内存 >1.5GB（当前 ${memoryFreeMb}MB）`);
  if (activeRooms >= limits.maxActiveRooms) reasons.push(`需要活跃直播间 <${limits.maxActiveRooms}（当前 ${activeRooms} 个）`);
  return reasons;
}

/**
 * Pure capacity decision used by GET /api/capacity and its unit tests.
 * Never throws: malformed/missing stats collapse to the safest profile.
 */
export function computeCapacity(stats = {}) {
  const source = stats && typeof stats === 'object' ? stats : {};
  const cpuCores = Math.max(1, Math.trunc(numberOf(source.cpuCores, 1)));
  const load1 = Math.max(0, numberOf(source.load1, 0));
  const memoryFreeMb = Math.max(0, Math.round(numberOf(source.memoryFreeMb, 0)));
  const memoryTotalMb = Math.max(0, Math.round(numberOf(source.memoryTotalMb, 0)));
  const activeRooms = Math.max(0, Math.trunc(numberOf(source.activeRooms, 0)));
  const loadPerCore = load1 / cpuCores;

  const allow1080p = cpuCores >= CAPACITY_LIMITS.allow1080p.minCores
    && memoryFreeMb > CAPACITY_LIMITS.allow1080p.minFreeMb
    && loadPerCore < loadPerCoreLimit1080p;
  // 2C2G servers must never advertise 60fps: it needs four cores and real
  // headroom (the reference 2C2G VPS therefore always gets allow1080p60=false).
  const allow1080p60 = cpuCores >= CAPACITY_LIMITS.allow1080p60.minCores
    && loadPerCore < loadPerCoreLimit1080p60
    && memoryFreeMb > CAPACITY_LIMITS.allow1080p60.minFreeMb
    && activeRooms < CAPACITY_LIMITS.allow1080p60.maxActiveRooms;

  let recommended;
  if (allow1080p60) {
    recommended = PROFILES['1080p60'];
  } else if (allow1080p) {
    recommended = PROFILES['1080p30'];
  } else if (memoryFreeMb > 256 && cpuCores >= 2) {
    recommended = PROFILES['720p30'];
  } else {
    recommended = PROFILES['540p24'];
  }

  let reason;
  if (allow1080p60) {
    reason = `服务器余量充足（${cpuCores} 核 CPU，可用内存 ${memoryFreeMb}MB，活跃直播间 ${activeRooms} 个），可以开启 1080p 60fps`;
  } else {
    const missing60 = shortfall1080p60({ cpuCores, loadPerCore, memoryFreeMb, activeRooms });
    if (allow1080p) {
      reason = `1080p 60fps 暂不可用：${missing60.join('；')}。建议使用 1080p 30fps`;
    } else {
      const missing30 = shortfall1080p({ cpuCores, loadPerCore, memoryFreeMb });
      reason = `当前服务器资源不足，建议使用 ${recommended.w}×${recommended.h} ${recommended.fps}fps；1080p 30fps 需要：${missing30.join('；')}`;
    }
  }

  return {
    cpuCores,
    load1: round2(load1),
    memoryFreeMb,
    memoryTotalMb,
    activeRooms,
    allow1080p,
    allow1080p60,
    recommended: { ...recommended },
    reason,
  };
}

/**
 * Creates the cached capacity getter.
 *
 * `sample` and `readActiveRooms` are injectable so tests can pin the host
 * profile without touching the machine running the test suite.
 */
export function createCapacityProvider({
  sample = sampleHostStats,
  readActiveRooms,
  cacheMs = CAPACITY_CACHE_MS,
  now = Date.now,
} = {}) {
  if (typeof readActiveRooms !== 'function') throw new TypeError('readActiveRooms must be a function');
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  async function refresh(timestamp) {
    try {
      const stats = sample() || {};
      const activeRooms = Math.max(0, Math.trunc(numberOf(await readActiveRooms(), 0)));
      cached = computeCapacity({ ...stats, activeRooms });
      cachedAt = timestamp;
      return cached;
    } finally {
      pending = null;
    }
  }

  async function get() {
    const timestamp = now();
    const age = timestamp - cachedAt;
    if (cached && age >= 0 && age < cacheMs) return cached;
    // Collapse concurrent cache misses (several clients open the publish card at
    // once) into a single sample + DB count.
    if (!pending) pending = refresh(timestamp);
    return pending;
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  return { get, invalidate };
}
