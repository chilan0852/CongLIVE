/**
 * CongLive web E2E: broadcast studio (/studio) + mesh voice room (/room/:id).
 *
 * Runs against a locally served production build (`vite preview`) with the REST
 * API and the `/ws/chat` voice signaling mocked by `e2e/mock-server.mjs`, so the
 * suite is deterministic and offline. The two room pages build a REAL
 * RTCPeerConnection mesh with Chromium's fake camera/microphone, and the page
 * instrumentation counts PeerConnections / getUserMedia calls / stopped tracks
 * to prove the "no media before join" and "release everything on leave" rules.
 *
 * Usage:
 *   npm run build
 *   npm run preview -- --port 4173 &
 *   node e2e/studio-voice.mjs
 *
 * Env: E2E_BASE (default http://127.0.0.1:4173), E2E_CHROME, PLAYWRIGHT_PATH.
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

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173';
const CHROME = process.env.E2E_CHROME || '/root/workspace/browser/chrome/chrome-linux-arm64/chrome';
const ARTIFACTS = process.env.E2E_ARTIFACTS || path.join(here, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// Import the mock helpers from the same folder. They are plain ESM.
const { MOCK_STREAM, mockApi, MockVoiceServer, INSTRUMENTATION, mediaStats } = await import('./mock-server.mjs');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
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

let browser;
const contexts = [];

async function newSession({ token = 'tok-e2e', username = 'e2eviewer', locale = 'zh-CN', viewport } = {}) {
  const context = await browser.newContext({
    viewport: viewport || { width: 1440, height: 1000 },
    locale,
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });
  contexts.push(context);
  await context.addInitScript(INSTRUMENTATION);
  await context.addInitScript((auth) => {
    try {
      if (auth.token) localStorage.setItem('token', auth.token);
      if (auth.username) localStorage.setItem('username', auth.username);
    } catch {
      // ignore
    }
  }, { token, username });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 200)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The mocked WHIP/WHEP endpoints intentionally return 4xx; the browser logs
    // those as resource errors even though the app handles them gracefully.
    if (/Failed to load resource/.test(text)) return;
    errors.push(`console: ${text.slice(0, 200)}`);
  });
  return { context, page, errors };
}

async function attachMocks(page, voiceServer) {
  const calls = await mockApi(page);
  await page.routeWebSocket('**/ws/chat', voiceServer.handler());
  return calls;
}

async function openStudio(session, voiceServer, options = {}) {
  const calls = await attachMocks(session.page, voiceServer);
  await session.page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' });
  return calls;
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });
  } catch {
    // Screenshots are best-effort.
  }
}

/* ------------------------------------------------------------------ *
 * 1. Lobby never loads voice / media
 * ------------------------------------------------------------------ */
async function testLobbyNoVoice(voiceServer) {
  const session = await newSession({ username: 'lobbyviewer' });
  await attachMocks(session.page, voiceServer);
  await session.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await session.page.getByRole('heading', { name: /直播大厅/ }).waitFor({ timeout: 15000 });
  const stats = await mediaStats(session.page);
  record(
    'lobby: no PeerConnection / microphone / AudioContext before joining',
    stats.pcCreated === 0 && stats.gumCalls === 0 && stats.audioContexts === 0,
    JSON.stringify({ pc: stats.pcCreated, gum: stats.gumCalls, audio: stats.audioContexts }),
  );
  record('lobby: no voice WebSocket opened', voiceServer.connections === 0, `connections=${voiceServer.connections}`);
  record('lobby: no JS errors', session.errors.length === 0, session.errors.slice(0, 2).join(' | '));
  await shot(session.page, 'lobby-zh');
  await session.context.close();
}

/* ------------------------------------------------------------------ *
 * 2. Studio: steps, device preview, mic level, cover, WHIP path
 * ------------------------------------------------------------------ */
async function testStudio(voiceServer) {
  const session = await newSession({ username: 'studiohost' });
  const calls = await openStudio(session, voiceServer);
  const page = session.page;

  await page.getByRole('heading', { name: '开播工作台', exact: false }).first().waitFor({ timeout: 15000 });
  const stepButtons = page.locator('.studio-step');
  record('studio: /studio route renders 4-step workbench', (await stepButtons.count()) === 4);

  const before = await mediaStats(page);
  record('studio: no capture/PC before clicking detect',
    before.gumCalls === 0 && before.trackPcCreated === 0 && before.audioContexts === 0,
    JSON.stringify({ gum: before.gumCalls, pc: before.trackPcCreated, audio: before.audioContexts }));

  await page.getByRole('button', { name: '检测设备并预览' }).click();
  await waitFor(async () => {
    const video = page.locator('.studio-preview video');
    return video.evaluate((element) => element.videoWidth > 0 && element.readyState >= 2);
  }, { label: 'studio camera preview', timeout: 20000 });
  record('studio: camera preview after device detect', true);

  // Microphone level bar must react to the fake audio device.
  const levels = [];
  try {
    await waitFor(async () => {
      const value = Number(await page.getByTestId('mic-level').getAttribute('data-level'));
      levels.push(value);
      return value > 0;
    }, { label: 'microphone level > 0', timeout: 12000, interval: 200 });
  } catch {
    // reported below
  }
  const maxLevel = Math.max(0, ...levels);
  record('studio: microphone level meter moves with real mic samples', maxLevel > 0,
    `samples=${levels.length} max=${maxLevel}`);

  const afterDetect = await mediaStats(page);
  record('studio: detect calls getUserMedia once and creates no PeerConnection',
    afterDetect.gumCalls === 1 && afterDetect.trackPcCreated === 0,
    JSON.stringify({ gum: afterDetect.gumCalls, pc: afterDetect.trackPcCreated }));

  await page.getByRole('button', { name: '下一步' }).click();
  record('studio: step 2 shows Live2D loader + overlay switch',
    await page.getByRole('heading', { name: 'Live2D 看板娘' }).count() > 0
    && await page.getByLabel('开播时叠加 Live2D 看板娘').count() > 0);
  await page.getByLabel('开播时叠加 Live2D 看板娘').check();
  await waitFor(async () => (await page.locator('.studio-panel').innerText()).includes('尚未加载模型'),
    { label: 'overlay warning without model' });
  record('studio: overlay switch without a model explains it stays on the raw picture', true);
  await page.getByLabel('开播时叠加 Live2D 看板娘').uncheck();

  await page.getByRole('button', { name: '下一步' }).click();
  const titleInput = page.getByLabel('直播标题');
  await titleInput.fill('E2E 工作台直播');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const coverPath = path.join(ARTIFACTS, 'cover.png');
  fs.writeFileSync(coverPath, png);
  await page.locator('.studio-panel input[type=file]').setInputFiles(coverPath);
  try {
    await waitFor(async () => (await page.locator('.studio-panel .cover-thumb img').count()) > 0, { label: 'cover thumbnail' });
  } catch (error) {
    console.log('DEBUG studio panel:', (await page.locator('.studio-panel').innerText()).replace(/\n/g, ' | ').slice(0, 600));
    console.log('DEBUG step index:', await page.locator('.studio-step.active').innerText());
    await shot(page, 'debug-cover-failure');
    throw error;
  }
  record('studio: cover image is compressed locally and previewed', true);

  await page.getByRole('button', { name: '下一步' }).click();
  const summary = await page.locator('.studio-summary').innerText();
  record('studio: step 4 summary shows picture + resolution', /720p|1280/.test(summary), summary.replace(/\n/g, ' | ').slice(0, 120));

  await page.getByRole('button', { name: '开始 WHIP 开播' }).click();
  await waitFor(async () => calls.createStream.length === 1, { label: 'POST /api/streams', timeout: 20000 });
  await waitFor(async () => calls.whip.length === 1, { label: 'WHIP offer POST', timeout: 20000 });
  record('studio: start publishing creates the room then POSTs the WHIP offer',
    calls.createStream.length === 1 && calls.whip.length === 1
    && /^v=0/.test(calls.whip[0] || ''),
    `create=${calls.createStream.length} whipSdp=${(calls.whip[0] || '').slice(0, 8)}`);
  await waitFor(async () => /WHIP 推流失败|WHIP publish failed/.test(await page.locator('body').innerText()),
    { label: 'WHIP failure message', timeout: 15000 });
  record('studio: WHIP 409 surfaces a readable error and ends the session',
    await page.getByRole('button', { name: '停止开播' }).isDisabled()
    && !(await page.locator('.studio-preview video').evaluate((element) => element.srcObject))
    && calls.cover.length === 1);
  await shot(page, 'studio-zh');

  const afterFail = await mediaStats(page);
  record('studio: failed session releases capture tracks (no media leak)',
    afterFail.trackPcClosed === afterFail.trackPcCreated && afterFail.tracksStopped >= 2,
    JSON.stringify({ created: afterFail.trackPcCreated, closed: afterFail.trackPcClosed, stopped: afterFail.tracksStopped }));

  // Language switch must re-render the workbench.
  await page.getByRole('button', { name: 'English' }).click();
  await waitFor(async () => (await page.locator('body').innerText()).includes('Broadcast studio'), { label: 'studio english' });
  record('studio: zh/en switch re-renders workbench copy', true);
  const stored = await page.evaluate(() => localStorage.getItem('conglive.lang'));
  record('studio: language choice persisted in localStorage', stored === 'en', String(stored));
  await shot(page, 'studio-en');

  record('studio: no JS errors', session.errors.length === 0, session.errors.slice(0, 2).join(' | '));
  await session.context.close();
}

/* ------------------------------------------------------------------ *
 * 3. Room page: voice join, mesh between two pages, speaking UI, cleanup
 * ------------------------------------------------------------------ */
async function openRoom(session, voiceServer) {
  const calls = await attachMocks(session.page, voiceServer);
  await session.page.goto(`${BASE}/room/7`, { waitUntil: 'networkidle' });
  await session.page.locator('.voice-panel').waitFor({ timeout: 15000 });
  return calls;
}

async function testRoomVoice(voiceServer) {
  const host = await newSession({ token: 'tok-host', username: 'hostuser' });
  const guest = await newSession({ token: 'tok-guest', username: 'listener2' });
  await openRoom(host, voiceServer);
  await openRoom(guest, voiceServer);
  const hostPage = host.page;
  const guestPage = guest.page;

  // Host-only studio entry: the room owner sees it, the guest does not.
  record('room: host sees the studio entry', await hostPage.getByRole('button', { name: '开播工作台' }).count() === 1);
  record('room: listener does not see the studio entry', await guestPage.getByRole('button', { name: '开播工作台' }).count() === 0);

  const beforeJoin = await mediaStats(hostPage);
  record('room: no microphone / voice PeerConnection before joining voice',
    beforeJoin.gumCalls === 0 && beforeJoin.trackPcCreated === 0 && beforeJoin.audioContexts === 0,
    JSON.stringify({ gum: beforeJoin.gumCalls, voicePc: beforeJoin.trackPcCreated, audio: beforeJoin.audioContexts }));

  // ---- host joins ----
  await hostPage.getByRole('button', { name: '加入语音' }).click();
  await waitFor(async () => (await hostPage.locator('.voice-peers .voice-peer').count()) === 1,
    { label: 'host self participant row', timeout: 20000 });
  const afterJoin = await mediaStats(hostPage);
  record('room: joining captures the microphone and opens signaling',
    afterJoin.gumCalls === 1 && voiceServer.events.some((event) => event.type === 'voice-join'),
    JSON.stringify({ gum: afterJoin.gumCalls, joins: voiceServer.events.filter((e) => e.type === 'voice-join').length }));
  record('room: mesh PeerConnection is only created after join (no peers yet)', afterJoin.trackPcCreated === 0,
    `voicePcCreated=${afterJoin.trackPcCreated}`);

  // ---- guest joins: both sides build a PC and exchange SDP/ICE ----
  await guestPage.getByRole('button', { name: '加入语音' }).click();
  await waitFor(async () => {
    const hostRows = await hostPage.locator('.voice-peers .voice-peer').count();
    const guestRows = await guestPage.locator('.voice-peers .voice-peer').count();
    return hostRows === 2 && guestRows === 2;
  }, { label: 'both pages list 2 participants', timeout: 20000 });
  record('room: voice-peers / peer-joined list both participants on both pages', true);

  try {
    await waitFor(async () => {
      const rows = hostPage.locator('.voice-peers .voice-peer');
      if (await rows.count() !== 2) return false;
      return /已连接|说话中/.test(await rows.nth(1).innerText());
    }, { label: 'host mesh connected', timeout: 25000 });
    record('room: mesh PeerConnections reach connected state', true);
  } catch (error) {
    record('room: mesh PeerConnections reach connected state', false, error.message);
  }

  const hostMedia = await mediaStats(hostPage);
  const guestMedia = await mediaStats(guestPage);
  record('room: one voice PeerConnection per remote peer',
    hostMedia.trackPcCreated === 1 && guestMedia.trackPcCreated === 1,
    JSON.stringify({ hostPc: hostMedia.trackPcCreated, guestPc: guestMedia.trackPcCreated }));
  record('room: remote audio element carries the peer audio track',
    hostMedia.remote.length === 1 && hostMedia.remote[0].tracks.includes('audio')
    && guestMedia.remote.length === 1 && guestMedia.remote[0].tracks.includes('audio'),
    JSON.stringify({ host: hostMedia.remote, guest: guestMedia.remote }));

  const signaling = voiceServer.events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  }, {});
  record('room: offer/answer/candidate signaling relayed through the WS',
    (signaling['voice-offer'] || 0) >= 1 && (signaling['voice-answer'] || 0) >= 1
    && (signaling['voice-candidate'] || 0) >= 1,
    JSON.stringify(signaling));

  // Speaking UI: participant rows + live dots exist; fake audio may or may not
  // trip the speech threshold during the sample window.
  const dots = await hostPage.locator('.voice-peers .voice-dot').count();
  record('room: participant rows render speaking indicators', dots === 2, `dots=${dots}`);
  const sawSpeaking = await waitFor(async () => (await hostPage.locator('.voice-peer.speaking').count()) > 0,
    { timeout: 8000 }).then(() => true).catch(() => false);
  console.log(`INFO speaking indicator observed=${sawSpeaking}`);

  // Mute keeps the connection but stops local audio (track.enabled=false).
  await hostPage.getByRole('button', { name: '静音' }).click();
  await waitFor(async () => (await hostPage.getByRole('button', { name: '取消静音' }).count()) > 0, { label: 'mute toggle' });
  const muted = await hostPage.evaluate(() => {
    const streams = window.__e2e.streams;
    const tracks = streams.flatMap((stream) => stream.getAudioTracks());
    return tracks.every((track) => track.enabled === false);
  });
  record('room: mute disables the local microphone track without closing the mesh', muted);
  await hostPage.getByRole('button', { name: '取消静音' }).click();
  await shot(hostPage, 'room-voice');

  // ---- leaving releases everything ----
  await hostPage.getByRole('button', { name: '离开语音' }).click();
  await waitFor(async () => (await hostPage.getByRole('button', { name: '加入语音' }).count()) === 1, { label: 'leave voice button state' });
  const left = await mediaStats(hostPage);
  record('room: leaving closes every voice PeerConnection and stops every local track',
    left.trackPcClosed === left.trackPcCreated && left.tracksStopped >= 1
    && left.localTracks.every((state) => state === 'ended'),
    JSON.stringify({ created: left.trackPcCreated, closed: left.trackPcClosed, stopped: left.tracksStopped, tracks: left.localTracks }));
  record('room: leaving removes the remote audio elements', left.remote.length === 0, `audio=${left.remote.length}`);
  record('room: leaving broadcasts peer-left to the other participant',
    voiceServer.events.some((event) => event.type === 'voice-leave'));
  await waitFor(async () => (await guestPage.locator('.voice-peers .voice-peer').count()) === 1,
    { label: 'guest sees host left', timeout: 10000 });

  // ---- route change cleanup: join again then navigate back to the lobby ----
  await hostPage.getByRole('button', { name: '加入语音' }).click();
  await waitFor(async () => (await hostPage.locator('.voice-peers .voice-peer').count()) >= 1, { label: 'rejoin', timeout: 20000 });
  await hostPage.locator('.room-topbar .room-back').click();
  await hostPage.waitForURL(`${BASE}/`, { timeout: 10000 });
  const routed = await mediaStats(hostPage);
  record('room: navigating away unmounts voice and releases media',
    routed.trackPcClosed === routed.trackPcCreated && routed.tracksStopped >= 1
    && routed.localTracks.every((state) => state === 'ended'),
    JSON.stringify({ created: routed.trackPcCreated, closed: routed.trackPcClosed, stopped: routed.tracksStopped }));

  record('room: no JS errors on either page',
    host.errors.length === 0 && guest.errors.length === 0,
    [...host.errors, ...guest.errors].slice(0, 2).join(' | '));

  await guest.context.close();
  await host.context.close();
}

/* ------------------------------------------------------------------ *
 * 4. Voice errors: denied join + server voice-error
 * ------------------------------------------------------------------ */
async function testVoiceErrors() {
  // 1) WS close 4403 during voice-join → "语音房不可用" message.
  const deniedServer = new MockVoiceServer();
  deniedServer.denyNextJoin = true;
  const denied = await newSession({ token: 'tok-denied', username: 'denied-user' });
  await openRoom(denied, deniedServer);
  await denied.page.getByRole('button', { name: '加入语音' }).click();
  await waitFor(async () => (await denied.page.locator('.voice-panel').innerText()).includes('语音房不可用'),
    { label: 'denied voice error', timeout: 15000 });
  record('room: rejected join shows a readable error (4403)', true);
  await denied.context.close();

  // 2) Server voice-error is surfaced to the user.
  const rejectedServer = new MockVoiceServer();
  rejectedServer.rejectNextJoin = true;
  const rejected = await newSession({ token: 'tok-rejected', username: 'rejected-user' });
  await openRoom(rejected, rejectedServer);
  await rejected.page.getByRole('button', { name: '加入语音' }).click();
  await waitFor(async () => (await rejected.page.locator('.voice-panel').innerText()).includes('语音设备不可用'),
    { label: 'voice-error surfaced', timeout: 15000 });
  record('room: server voice-error is shown to the user', true);
  await rejected.context.close();
}

/* ------------------------------------------------------------------ *
 * 5. Mobile layout: no horizontal overflow on studio / room
 * ------------------------------------------------------------------ */
async function testMobileLayout(voiceServer) {
  const session = await newSession({ username: 'mobileviewer', viewport: { width: 390, height: 844 } });
  await attachMocks(session.page, voiceServer);

  await session.page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' });
  await session.page.getByRole('heading', { name: '开播工作台', exact: false }).first().waitFor({ timeout: 15000 });
  let layout = await session.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  record('mobile: /studio has no horizontal overflow', layout.scrollWidth <= layout.innerWidth + 1,
    JSON.stringify(layout));
  await shot(session.page, 'studio-mobile');

  await session.page.goto(`${BASE}/room/7`, { waitUntil: 'networkidle' });
  await session.page.locator('.voice-panel').waitFor({ timeout: 15000 });
  layout = await session.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  record('mobile: /room/7 has no horizontal overflow', layout.scrollWidth <= layout.innerWidth + 1,
    JSON.stringify(layout));
  await shot(session.page, 'room-mobile');
  record('mobile: no JS errors', session.errors.length === 0, session.errors.slice(0, 2).join(' | '));
  await session.context.close();
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  browser = await chromium.launch({
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

  const voiceServer = new MockVoiceServer();
  try {
    await testLobbyNoVoice(voiceServer);
    await testStudio(voiceServer);
    await testRoomVoice(voiceServer);
    await testVoiceErrors();
    await testMobileLayout(voiceServer);
  } catch (error) {
    record('suite aborted', false, error.stack || error.message);
  } finally {
    for (const context of contexts) {
      try { await context.close(); } catch { /* already closed */ }
    }
    await browser.close();
  }

  const passed = results.filter((result) => result.ok).length;
  console.log(`\nSUMMARY ${passed}/${results.length} passed`);
  fs.writeFileSync(path.join(ARTIFACTS, 'results.json'), JSON.stringify({ results, streamId: MOCK_STREAM.id }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

await main();
