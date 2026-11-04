import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CAPACITY_CACHE_MS,
  CAPACITY_LIMITS,
  computeCapacity,
  createCapacityProvider,
} from '../src/capacity.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

// Reference deployment: 2 vCPU / 2GB VPS that is healthy but small.
const stats2c2g = (overrides = {}) => ({
  cpuCores: 2,
  load1: 0.35,
  memoryFreeMb: 900,
  memoryTotalMb: 2048,
  activeRooms: 0,
  ...overrides,
});
const capacity2c2g = (overrides) => computeCapacity(stats2c2g(overrides));

test('2C2G VPS never advertises 1080p60 but keeps 1080p30 available', () => {
  const capacity = capacity2c2g();
  assert.equal(capacity.cpuCores, 2);
  assert.equal(capacity.memoryTotalMb, 2048);
  assert.equal(capacity.allow1080p60, false);
  assert.equal(capacity.allow1080p, true);
  assert.deepEqual(capacity.recommended, { w: 1920, h: 1080, fps: 30, bitrate: 4000000 });
  assert.match(capacity.reason, /1080p 60fps 暂不可用/);
  assert.match(capacity.reason, /4 核/);
  assert.match(capacity.reason, /1\.5GB/);
});

test('capacity response carries every field the clients rely on', () => {
  const capacity = capacity2c2g();
  assert.deepEqual(Object.keys(capacity).sort(), [
    'activeRooms',
    'allow1080p',
    'allow1080p60',
    'cpuCores',
    'load1',
    'memoryFreeMb',
    'memoryTotalMb',
    'reason',
    'recommended',
  ]);
  assert.equal(typeof capacity.cpuCores, 'number');
  assert.equal(typeof capacity.load1, 'number');
  assert.equal(typeof capacity.memoryFreeMb, 'number');
  assert.equal(typeof capacity.memoryTotalMb, 'number');
  assert.equal(typeof capacity.activeRooms, 'number');
  assert.equal(typeof capacity.allow1080p, 'boolean');
  assert.equal(typeof capacity.allow1080p60, 'boolean');
  assert.equal(typeof capacity.reason, 'string');
  assert.equal(typeof capacity.recommended.w, 'number');
  assert.equal(typeof capacity.recommended.h, 'number');
  assert.equal(typeof capacity.recommended.fps, 'number');
  assert.equal(typeof capacity.recommended.bitrate, 'number');
});

test('an idle 4C/8G host unlocks 1080p60', () => {
  const capacity = computeCapacity({ cpuCores: 4, load1: 1, memoryFreeMb: 4096, memoryTotalMb: 8192, activeRooms: 0 });
  assert.equal(capacity.allow1080p, true);
  assert.equal(capacity.allow1080p60, true);
  assert.deepEqual(capacity.recommended, { w: 1920, h: 1080, fps: 60, bitrate: 6000000 });
  assert.match(capacity.reason, /1080p 60fps/);
  assert.doesNotMatch(capacity.reason, /暂不可用/);
});

test('1080p60 requires at least four CPU cores', () => {
  for (const cpuCores of [2, 3]) {
    const capacity = computeCapacity({ ...stats2c2g(), cpuCores, load1: 0.1, memoryFreeMb: 8192 });
    assert.equal(capacity.allow1080p60, false, `${cpuCores} cores must not allow 1080p60`);
    assert.match(capacity.reason, new RegExp(`≥${CAPACITY_LIMITS.allow1080p60.minCores} 核`));
  }
  // A single-core box cannot even keep 1080p30, so its reason explains that gate.
  const oneCore = computeCapacity({ cpuCores: 1, load1: 0.1, memoryFreeMb: 8192, memoryTotalMb: 8192, activeRooms: 0 });
  assert.equal(oneCore.allow1080p60, false);
  assert.match(oneCore.reason, /≥2 核/);
  const fourCores = computeCapacity({ cpuCores: 4, load1: 0.1, memoryFreeMb: 8192, memoryTotalMb: 8192, activeRooms: 0 });
  assert.equal(fourCores.allow1080p60, true);
});

test('1080p60 requires load1/cores below 0.65', () => {
  const base = { cpuCores: 4, memoryFreeMb: 8192, memoryTotalMb: 8192, activeRooms: 0 };
  assert.equal(computeCapacity({ ...base, load1: 2.6 }).allow1080p60, false); // exactly 0.65
  assert.equal(computeCapacity({ ...base, load1: 2.59 }).allow1080p60, true);
  assert.equal(computeCapacity({ ...base, load1: 3.4 }).allow1080p60, false);
});

test('1080p60 requires more than 1.5GB free memory', () => {
  const base = { cpuCores: 4, load1: 0.5, memoryTotalMb: 4096, activeRooms: 0 };
  assert.equal(computeCapacity({ ...base, memoryFreeMb: 1536 }).allow1080p60, false); // exactly 1.5GB
  assert.equal(computeCapacity({ ...base, memoryFreeMb: 1537 }).allow1080p60, true);
  assert.equal(computeCapacity({ ...base, memoryFreeMb: 1200 }).allow1080p60, false);
});

test('1080p60 requires fewer than two active live rooms', () => {
  const base = { cpuCores: 4, load1: 0.5, memoryFreeMb: 8192, memoryTotalMb: 8192 };
  assert.equal(computeCapacity({ ...base, activeRooms: 0 }).allow1080p60, true);
  assert.equal(computeCapacity({ ...base, activeRooms: 1 }).allow1080p60, true);
  assert.equal(computeCapacity({ ...base, activeRooms: 2 }).allow1080p60, false);
  assert.match(computeCapacity({ ...base, activeRooms: 2 }).reason, /活跃直播间 <2/);
});

test('overloaded hosts fall back to 720p or 540p with a shorter bitrate', () => {
  const overloaded = computeCapacity({ cpuCores: 2, load1: 3, memoryFreeMb: 400, memoryTotalMb: 2048, activeRooms: 1 });
  assert.equal(overloaded.allow1080p, false);
  assert.equal(overloaded.allow1080p60, false);
  assert.equal(overloaded.recommended.fps, 30);
  assert.equal(overloaded.recommended.h, 720);
  assert.ok(overloaded.recommended.bitrate < 4000000);

  const tiny = computeCapacity({ cpuCores: 4, load1: 5, memoryFreeMb: 200, memoryTotalMb: 2048, activeRooms: 0 });
  assert.equal(tiny.allow1080p, false);
  assert.deepEqual(tiny.recommended, { w: 960, h: 540, fps: 24, bitrate: 1200000 });
  assert.match(tiny.reason, /960×540 24fps/);
});

test('computeCapacity tolerates missing or malformed stats', () => {
  for (const stats of [undefined, null, {}, { cpuCores: 'x', load1: 'y', memoryFreeMb: -5 }]) {
    const capacity = computeCapacity(stats);
    assert.equal(capacity.cpuCores >= 1, true);
    assert.equal(capacity.load1 >= 0, true);
    assert.equal(capacity.memoryFreeMb >= 0, true);
    assert.equal(capacity.allow1080p60, false);
    assert.equal(typeof capacity.reason, 'string');
    assert.ok(capacity.reason.length > 0);
  }
});

test('capacity cache reuses the host sample for two seconds', async () => {
  let clock = 1000;
  let samples = 0;
  let roomReads = 0;
  const provider = createCapacityProvider({
    sample: () => { samples += 1; return { cpuCores: 2, load1: 0.2, memoryFreeMb: 800, memoryTotalMb: 2048 }; },
    readActiveRooms: async () => { roomReads += 1; return 1; },
    now: () => clock,
  });

  const first = await provider.get();
  clock += CAPACITY_CACHE_MS - 1;
  const cached = await provider.get();
  assert.equal(cached, first); // same object: no new sample/DB query
  assert.equal(samples, 1);
  assert.equal(roomReads, 1);
  assert.equal(first.activeRooms, 1);

  clock += 1; // exactly CAPACITY_CACHE_MS later -> stale
  const refreshed = await provider.get();
  assert.notEqual(refreshed, first);
  assert.equal(samples, 2);
  assert.equal(roomReads, 2);
  assert.equal(CAPACITY_CACHE_MS, 2000);
});

test('concurrent cache misses share one host sample and DB count', async () => {
  let samples = 0;
  let roomReads = 0;
  const provider = createCapacityProvider({
    sample: () => { samples += 1; return { cpuCores: 2, load1: 0.2, memoryFreeMb: 800, memoryTotalMb: 2048 }; },
    readActiveRooms: async () => { roomReads += 1; return 1; },
  });
  const [a, b, c] = await Promise.all([provider.get(), provider.get(), provider.get()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(samples, 1);
  assert.equal(roomReads, 1);
});

test('capacity provider reports active rooms from the database count', async () => {
  const provider = createCapacityProvider({
    sample: () => ({ cpuCores: 4, load1: 0.2, memoryFreeMb: 4096, memoryTotalMb: 8192 }),
    readActiveRooms: async () => 1,
  });
  assert.equal((await provider.get()).activeRooms, 1);
  assert.equal((await provider.get()).allow1080p60, true);
});

test('index.js exposes GET /api/capacity through the cached provider', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /app\.get\('\/api\/capacity', asyncRoute\(async \(_req, res\) => \{[\s\S]*?capacityProvider\.get\(\)/);
  assert.match(source, /const capacityProvider = createCapacityProvider\(\{/);
  assert.match(source, /readActiveRooms: async \(\) => \{[\s\S]*?SELECT COUNT\(\*\) AS n FROM streams WHERE is_live=TRUE/);
  assert.match(source, /res\.setHeader\('Cache-Control', 'public, max-age=2'\)/);
});

test('index.js migrates a composite is_live index for lobby queries', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /async function ensureIndex\(table, indexName, columns\)/);
  assert.match(source, /ensureIndex\('streams', 'idx_streams_live_created', 'is_live, created_at'\)/);
  assert.match(source, /information_schema\.STATISTICS/);
});
