/**
 * Real-media regression for the refactored WHIP publisher + WHEP player.
 *
 * Uses a build made with `VITE_API_URL` pointing at a real CongLive deployment
 * (`npm run build:remote` equivalent): the broadcast studio publishes through
 * the real backend + SRS, a second browser joins the standalone room page and
 * verifies WHEP audio/video playback, latency sampling, chat and end-of-stream.
 *
 * Usage:
 *   VITE_API_URL=http://YOUR_SERVER:3000 npx vite build --outDir dist-remote
 *   npx vite preview --outDir dist-remote --port 4174 &
 *   REAL_API=http://YOUR_SERVER:3000 REAL_WEB=http://127.0.0.1:4174 node e2e/real-whep.mjs
 *
 * Env: REAL_API, REAL_WEB, REAL_ADMIN_PW (optional cleanup), PLAYWRIGHT_PATH, E2E_CHROME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/root/workspace/browser/node_modules/playwright/index.js',
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try { return await import(candidate); } catch (error) { lastError = error; }
  }
  throw lastError;
}
const pw = await loadPlaywright();
const { chromium } = pw.default ?? pw;

const API = (process.env.REAL_API || 'http://38.246.244.139:3000').replace(/\/$/, '');
const WEB = (process.env.REAL_WEB || 'http://127.0.0.1:4174').replace(/\/$/, '');
const CHROME = process.env.E2E_CHROME || '/root/workspace/browser/chrome/chrome-linux-arm64/chrome';
const ARTIFACTS = process.env.E2E_ARTIFACTS || path.join(here, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 20000, interval = 300, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  let body = '';
  try { body = await response.text(); } catch { /* ignore */ }
  return {
    status: response.status,
    body,
    json: () => { try { return JSON.parse(body); } catch { return null; } },
  };
}

async function register(username, password) {
  const result = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return result;
}

async function login(username, password) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return result.status === 200 ? result.json()?.token || '' : '';
}

async function newPage(browser, { token, username, viewport }) {
  const context = await browser.newContext({
    viewport: viewport || { width: 1440, height: 1000 },
    locale: 'zh-CN',
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript((auth) => {
    try {
      localStorage.setItem('token', auth.token);
      localStorage.setItem('username', auth.username);
    } catch { /* ignore */ }
  }, { token, username });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 200)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource/.test(text)) return;
    if (/whep|whip|WebRTC/i.test(text)) return;
    errors.push(`console: ${text.slice(0, 200)}`);
  });
  return { context, page, errors };
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });
  } catch { /* best-effort */ }
}

async function main() {
  const stamp = Date.now().toString().slice(-6);
  const publisherName = `wsrealpub${stamp}`;
  const viewerName = `wsrealview${stamp}`;
  const password = 'Passw0rd!wsreal';
  await register(publisherName, password);
  await register(viewerName, password);
  const publisherToken = await login(publisherName, password);
  const viewerToken = await login(viewerName, password);
  record('real: register + login publisher/viewer', !!publisherToken && !!viewerToken,
    `${publisherName} / ${viewerName}`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const contexts = [];
  const closeAll = async () => {
    for (const context of contexts) {
      try { await context.close(); } catch { /* already closed */ }
    }
    try { await browser.close(); } catch { /* already closed */ }
  };

  try {
    const publisher = await newPage(browser, { token: publisherToken, username: publisherName });
    contexts.push(publisher.context);
    const viewer = await newPage(browser, { token: viewerToken, username: viewerName });
    contexts.push(viewer.context);

    // ---- studio: real WHIP publish ----
    await publisher.page.goto(`${WEB}/studio`, { waitUntil: 'networkidle' });
    await publisher.page.getByRole('button', { name: '检测设备并预览' }).click();
    await waitFor(async () => publisher.page.locator('.studio-preview video').evaluate((element) => (
      element.videoWidth > 0 && element.readyState >= 2
    )), { label: 'studio preview', timeout: 25000 });
    record('real: studio captures the fake camera/mic', true);

    await publisher.page.getByRole('button', { name: '下一步' }).click();
    await publisher.page.getByRole('button', { name: '下一步' }).click();
    await publisher.page.getByLabel('直播标题').fill(`Real WHEP ${stamp}`);
    await publisher.page.getByRole('button', { name: '下一步' }).click();
    await publisher.page.getByRole('button', { name: '开始 WHIP 开播' }).click();

    const live = await waitFor(async () => {
      const list = (await api('/api/streams')).json();
      return Array.isArray(list) ? list.find((stream) => stream.username === publisherName) : null;
    }, { label: 'published room is live', timeout: 60000 });
    record('real: WHIP publish creates a live room', !!live?.whepPath, JSON.stringify({ id: live?.id, whepPath: live?.whepPath }));

    // ---- viewer: real WHEP playback ----
    await viewer.page.goto(`${WEB}/room/${live.id}`, { waitUntil: 'networkidle' });
    const playback = await waitFor(async () => {
      return viewer.page.evaluate(() => {
        const video = document.querySelector('.room-player-panel video');
        if (!video || !video.srcObject) return null;
        const tracks = video.srcObject.getTracks().map((track) => track.kind);
        if (video.readyState < 2 || video.currentTime < 0.5) return null;
        return { readyState: video.readyState, currentTime: video.currentTime, tracks, paused: video.paused };
      });
    }, { label: 'WHEP playback', timeout: 60000 });
    record('real: WHEP playback receives audio + video and advances',
      playback.tracks.includes('video') && playback.tracks.includes('audio') && playback.currentTime > 0.5,
      JSON.stringify(playback));
    await shot(viewer.page, 'real-room-whep');

    const latency = await waitFor(async () => {
      const text = await viewer.page.locator('.room-chip.latency').innerText();
      return /延迟≈\d+ms/.test(text) ? text : null;
    }, { label: 'latency chip', timeout: 20000 });
    record('real: latency chip is sampled from WHEP getStats', true, latency);
    const viewerChip = await viewer.page.locator('.room-chip.viewers').innerText();
    record('real: viewer count chip is populated', /\d+\s*人观看/.test(viewerChip), viewerChip);

    // ---- chat over the real /ws/chat ----
    // Wait for the room WS handshake before sending: the input is enabled as
    // soon as the room is live, but the socket may still be connecting.
    await waitFor(async () => (await viewer.page.locator('.chat-panel .hint').first().innerText()).includes('实时弹幕已连接'),
      { label: 'chat websocket ready', timeout: 30000 });
    const message = `real-whep-${stamp}`;
    const chatInput = viewer.page.locator('.chat-form input');
    await chatInput.fill(message);
    await chatInput.press('Enter');
    await waitFor(async () => (await viewer.page.locator('.chat-messages').innerText()).includes(message),
      { label: 'chat message rendered', timeout: 20000 });
    record('real: chat message is delivered and rendered', true);

    // ---- stop publishing: room goes offline for the viewer ----
    await publisher.page.locator('.studio-topbar').getByRole('button', { name: '停止开播' }).click();
    await waitFor(async () => {
      const list = (await api('/api/streams')).json();
      return Array.isArray(list) && !list.some((stream) => stream.id === live.id);
    }, { label: 'room unpublished', timeout: 30000 });
    record('real: stopping the studio session unpublishes the room', true);
    await waitFor(async () => {
      const body = await viewer.page.locator('body').innerText();
      return /已下播|主播已停止直播|直播已结束/.test(body);
    }, { label: 'viewer sees ended state', timeout: 30000 }).catch(() => undefined);
    const endedText = await viewer.page.locator('body').innerText();
    record('real: viewer page reflects end of stream', /已下播|主播已停止直播|直播已结束/.test(endedText));
    await shot(publisher.page, 'real-studio-publish');
    await shot(viewer.page, 'real-room-ended');

    // ---- lobby publish card uses the same refactored WHIP engine ----
    await publisher.page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
    await publisher.page.locator('#publish').scrollIntoViewIfNeeded();
    await publisher.page.locator('#publish').getByRole('button', { name: '开始开播' }).click();
    const lobbyLive = await waitFor(async () => {
      const list = (await api('/api/streams')).json();
      return Array.isArray(list) ? list.filter((stream) => stream.username === publisherName && stream.id !== live.id)[0] : null;
    }, { label: 'lobby publish goes live', timeout: 60000 });
    record('real: lobby publish card still goes live through the shared engine', !!lobbyLive?.id,
      JSON.stringify({ id: lobbyLive?.id }));
    await viewer.page.goto(`${WEB}/room/${lobbyLive.id}`, { waitUntil: 'networkidle' });
    const lobbyPlayback = await waitFor(async () => viewer.page.evaluate(() => {
      const video = document.querySelector('.room-player-panel video');
      if (!video || !video.srcObject) return null;
      const tracks = video.srcObject.getTracks().map((track) => track.kind);
      return video.readyState >= 2 && video.currentTime > 0.5 && tracks.includes('video') ? { currentTime: video.currentTime, tracks } : null;
    }), { label: 'lobby room WHEP playback', timeout: 60000 });
    record('real: lobby-published room plays back over WHEP', lobbyPlayback.currentTime > 0.5,
      JSON.stringify(lobbyPlayback));
    await publisher.page.locator('#publish').getByRole('button', { name: '停止推流' }).click();
    await waitFor(async () => {
      const list = (await api('/api/streams')).json();
      return Array.isArray(list) && !list.some((stream) => stream.id === lobbyLive.id);
    }, { label: 'lobby room unpublished', timeout: 30000 });
    record('real: lobby stop unpublishes the room', true);

    record('real: no JS errors on publisher page', publisher.errors.length === 0, publisher.errors.slice(0, 2).join(' | '));
    record('real: no JS errors on viewer page', viewer.errors.length === 0, viewer.errors.slice(0, 2).join(' | '));
    record('real: test accounts', true, `${publisherName}, ${viewerName} (password: ${password})`);
  } catch (error) {
    record('real: suite aborted', false, error.stack || error.message);
  } finally {
    await closeAll();
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\nSUMMARY ${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ARTIFACTS, 'real-results.json'), JSON.stringify({ results, api: API, web: WEB }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

await main();
