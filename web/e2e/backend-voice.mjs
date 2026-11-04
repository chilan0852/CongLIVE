/**
 * Browser ↔ backend integration test for the mesh voice signaling.
 *
 * Unlike `studio-voice.mjs` (which uses a test-side WebSocket relay), this suite
 * imports the REAL backend implementation (`backend/src/voice.js`, task-7) and
 * wraps it in a tiny HTTP+WS server that also serves the production `dist/`
 * build and stubs the REST endpoints the room page needs. Two browser pages
 * then join the voice room through the actual server-side membership, target
 * validation, rate limiting and relay rules, building a real RTCPeerConnection
 * mesh with Chromium's fake microphone.
 *
 * Usage: npm run build && node e2e/backend-voice.mjs
 * Env: E2E_PORT (default 4175), PLAYWRIGHT_PATH, E2E_CHROME.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..');
const DIST = path.join(webRoot, 'dist');
const PORT = Number(process.env.E2E_PORT || 4175);
const CHROME = process.env.E2E_CHROME || '/root/workspace/browser/chrome/chrome-linux-arm64/chrome';
const ARTIFACTS = process.env.E2E_ARTIFACTS || path.join(here, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// Real backend signaling module (read-only import; no backend code is modified).
const { createVoiceSignaling, handleVoiceMessage, VOICE_LIMITS } = await import(
  new URL('../../backend/src/voice.js', import.meta.url)
);
const backendRequire = createRequire(`${repoRoot}/backend/package.json`);
const { WebSocketServer } = backendRequire('ws');

// Playwright may live in the repository test tooling or web/node_modules.
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/root/workspace/browser/node_modules/playwright/index.js',
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
const pw = await loadPlaywright();
const { chromium } = pw.default ?? pw;
const { INSTRUMENTATION, mediaStats } = await import('./mock-server.mjs');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 20000, interval = 200, label = 'condition' } = {}) {
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

/* ------------------------------------------------------------------ *
 * HTTP server: static dist + stubbed REST API for the room page
 * ------------------------------------------------------------------ */
const STREAM = {
  id: 7,
  title: 'Backend voice 集成测试',
  username: 'hostuser',
  is_live: true,
  whepPath: '/api/streams/7/whep',
  transport: 'WebRTC',
  coverUrl: null,
  viewers: 2,
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  if (pathname === '/api/capacity') {
    return sendJson(res, 200, {
      cpuCores: 2, memoryFreeMb: 512, memoryTotalMb: 2048, activeRooms: 1,
      allow1080p: false, allow1080p60: false, reason: 'integration test',
      recommended: { w: 1280, h: 720, fps: 30, bitrate: 2500000 },
    });
  }
  if (pathname === '/api/streams') return sendJson(res, 200, [STREAM]);
  if (pathname === '/api/streams/7') return sendJson(res, 200, STREAM);
  if (pathname === '/api/streams/7/whep') return sendJson(res, 409, { error: '主播尚未开播' });
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (pathname.startsWith('/ws/')) { res.writeHead(400); res.end('websocket only'); return; }

  let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html'); // SPA fallback (/room/7, /studio)
  }
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

/* ------------------------------------------------------------------ *
 * Real backend voice signaling over /ws/chat (auth handshake mirrored
 * from backend/src/index.js: auth → ready → voice-* handled by voice.js)
 * ------------------------------------------------------------------ */
const signaling = createVoiceSignaling();
const wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_LIMITS.maxFrameBytes });
let nextUserId = 100;

function sendWs(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* socket closing */ }
}

wss.on('connection', (ws) => {
  let session = null;
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (!session) {
      if (message.type !== 'auth' || typeof message.token !== 'string') {
        ws.close(4401, 'authentication required');
        return;
      }
      const username = message.token.startsWith('tok-') ? message.token.slice(4) : '';
      const streamId = Number(message.streamId);
      if (!username || streamId !== 7) {
        ws.close(4403, 'stream chat unavailable');
        return;
      }
      session = { userId: nextUserId++, username, streamId };
      sendWs(ws, { type: 'ready', streamId, messages: [], viewers: 2 });
      return;
    }
    // Everything voice-* is handled by the real backend module.
    handleVoiceMessage(signaling, ws, session, message);
  });
  ws.on('close', () => {
    if (session) signaling.leave(ws, 'close');
  });
});
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname !== '/ws/chat') { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

/* ------------------------------------------------------------------ *
 * Playwright browser flow
 * ------------------------------------------------------------------ */
async function newSession(browser, { token, username }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    permissions: ['camera', 'microphone'],
  });
  await context.addInitScript(INSTRUMENTATION);
  await context.addInitScript((auth) => {
    try {
      localStorage.setItem('token', auth.token);
      localStorage.setItem('username', auth.username);
    } catch { /* ignore */ }
  }, { token, username });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 200)));
  return { context, page, errors };
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });
  } catch { /* best-effort */ }
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  record('backend: static dist + stubbed REST served', fs.existsSync(path.join(DIST, 'index.html')), `port=${PORT}`);
  record('backend: real voice.js loaded', typeof createVoiceSignaling === 'function'
    && typeof handleVoiceMessage === 'function' && typeof VOICE_LIMITS.maxSdpLength === 'number');

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
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  const contexts = [];
  try {
    const host = await newSession(browser, { token: 'tok-hostuser', username: 'hostuser' });
    const guest = await newSession(browser, { token: 'tok-listener2', username: 'listener2' });
    contexts.push(host.context, guest.context);
    for (const session of [host, guest]) {
      await session.page.goto(`http://127.0.0.1:${PORT}/room/7`, { waitUntil: 'networkidle' });
      await session.page.locator('.voice-panel').waitFor({ timeout: 15000 });
    }
    record('backend: room page loads against same-origin server', true);

    const baseline = await mediaStats(host.page);
    record('backend: no voice PeerConnection / mic before join',
      baseline.trackPcCreated === 0 && baseline.gumCalls === 0,
      JSON.stringify({ pc: baseline.trackPcCreated, gum: baseline.gumCalls }));

    await host.page.getByRole('button', { name: '加入语音' }).click();
    await waitFor(async () => (await host.page.locator('.voice-peers .voice-peer').count()) === 1,
      { label: 'host joined voice room', timeout: 20000 });
    record('backend: real voice-join registers the participant server-side',
      signaling.size(7) === 1, `room size=${signaling.size(7)}`);

    await guest.page.getByRole('button', { name: '加入语音' }).click();
    await waitFor(async () => {
      const hostRows = await host.page.locator('.voice-peers .voice-peer').count();
      const guestRows = await guest.page.locator('.voice-peers .voice-peer').count();
      return hostRows === 2 && guestRows === 2;
    }, { label: 'both participants listed via real voice-peers/peer-joined', timeout: 20000 });
    record('backend: voice-peers / voice-peer-joined come from the real signaling module',
      signaling.size(7) === 2, `room size=${signaling.size(7)}`);

    await waitFor(async () => {
      const rows = host.page.locator('.voice-peers .voice-peer');
      if (await rows.count() !== 2) return false;
      return /已连接|说话中/.test(await rows.nth(1).innerText());
    }, { label: 'mesh connected through real signaling', timeout: 25000 });
    const hostMedia = await mediaStats(host.page);
    record('backend: real offer/answer/candidate relay builds a connected mesh',
      hostMedia.trackPcCreated === 1 && hostMedia.remote.length === 1
      && hostMedia.remote[0].tracks.includes('audio'),
      JSON.stringify({ pc: hostMedia.trackPcCreated, remote: hostMedia.remote }));

    // Server-side relay rules are active: bad target must yield target-not-found.
    const badTarget = await host.page.evaluate(() => new Promise((resolve) => {
      // Reuse the already-authenticated chat socket? The page owns it privately,
      // so open a second authenticated WS and probe the relay error instead.
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`);
      const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 8000);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token: 'tok-hostuser', streamId: 7 }));
        socket.send(JSON.stringify({ type: 'voice-join' }));
      };
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'voice-peers') {
          socket.send(JSON.stringify({ type: 'voice-offer', target: 'does-not-exist', sdp: 'v=0\r\n' }));
        }
        if (data.type === 'voice-error') {
          clearTimeout(timer);
          socket.close();
          resolve(data.code);
        }
      };
    }));
    record('backend: relay rules reject unknown targets (target-not-found)', badTarget === 'target-not-found', String(badTarget));

    // Leaving through the real backend broadcasts peer-left and empties the room.
    await host.page.getByRole('button', { name: '离开语音' }).click();
    await waitFor(async () => signaling.size(7) === 1, { label: 'server room shrinks after leave', timeout: 10000 });
    await waitFor(async () => (await guest.page.locator('.voice-peers .voice-peer').count()) === 1,
      { label: 'guest sees peer-left from backend', timeout: 10000 });
    const left = await mediaStats(host.page);
    record('backend: leave broadcasts peer-left and releases local media',
      left.trackPcClosed === left.trackPcCreated && left.remote.length === 0
      && left.localTracks.every((state) => state === 'ended'),
      JSON.stringify({ created: left.trackPcCreated, closed: left.trackPcClosed }));

    // Unauthenticated / invalid token → 4403 close surfaced by the UI.
    const denied = await newSession(browser, { token: 'tok-', username: 'denied' });
    contexts.push(denied.context);
    await denied.page.goto(`http://127.0.0.1:${PORT}/room/7`, { waitUntil: 'networkidle' });
    await denied.page.locator('.voice-panel').waitFor({ timeout: 15000 });
    await denied.page.getByRole('button', { name: '加入语音' }).click();
    await waitFor(async () => (await denied.page.locator('.voice-panel').innerText()).includes('语音房不可用'),
      { label: 'denied voice join', timeout: 15000 });
    record('backend: rejected auth close (4403) is surfaced in the UI', true);

    await shot(host.page, 'backend-voice-room');
    record('backend: no JS errors on voice pages',
      host.errors.length === 0 && guest.errors.length === 0 && denied.errors.length === 0,
      [...host.errors, ...guest.errors, ...denied.errors].slice(0, 2).join(' | '));
  } catch (error) {
    record('backend: suite aborted', false, error.stack || error.message);
  } finally {
    for (const context of contexts) {
      try { await context.close(); } catch { /* already closed */ }
    }
    await browser.close();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\nSUMMARY ${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ARTIFACTS, 'backend-voice-results.json'),
    JSON.stringify({ results, port: PORT }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

await main();
