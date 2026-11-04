import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import path from 'node:path';
import { createServer } from 'node:http';
import { readdir, stat, lstat, unlink, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createPluginManager } from './plugin-manager.js';
import { mysqlBoolean } from './mysql-utils.js';
import { recordingApiBaseForRequest, recordingBelongsToStreams } from './recordings-utils.js';
import { CoverValidationError, coverFilenameFromUrl, saveCoverImage } from './covers-utils.js';

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.use(express.text({ type: 'application/sdp', limit: '256kb' }));
// Cover uploads are base64 data URIs: 2MB decoded is ~2.8MB of JSON text, so
// only that route gets a larger JSON limit. All other endpoints stay at 100kb.
const standardJsonBody = express.json({ limit: '100kb' });
const coverJsonBody = express.json({ limit: '4mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/streams\/[0-9]+\/cover\/?$/.test(req.path)) return next();
  return standardJsonBody(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const allowedOrigins = String(process.env.CORS_ORIGINS || '*').split(',').map((value) => value.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));

const secret = process.env.JWT_SECRET || '';
if (secret.length < 32 || secret === 'replace_with_a_long_random_secret') throw new Error('JWT_SECRET must be a unique random value with at least 32 characters. Run server/install.sh.');

const db = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'conglive',
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'conglive',
  waitForConnections: true,
  connectionLimit: 6,
  queueLimit: 30,
});

const publicHostRaw = String(process.env.PUBLIC_HOST || '127.0.0.1').trim();
const publicHost = publicHostRaw.includes(':') && !publicHostRaw.startsWith('[') ? `[${publicHostRaw}]` : publicHostRaw;
const apiPort = Number(process.env.PORT || 3000);
const rtcCandidate = String(process.env.RTC_CANDIDATE || process.env.CANDIDATE || '').trim();
const srsRtcApi = String(process.env.SRS_RTC_API || 'http://srs:1985').replace(/\/$/, '');
const publicApiScheme = process.env.PUBLIC_API_SCHEME || 'http';
const publicApiPort = process.env.PUBLIC_API_PORT === undefined ? '3000' : String(process.env.PUBLIC_API_PORT).trim();
const recordingApiBase = `${publicApiScheme}://${publicHost}${publicApiPort ? `:${publicApiPort}` : ''}/api/recordings`;
const srsHookSecret = String(process.env.SRS_HOOK_SECRET || '');
const recordingsRoot = path.resolve(process.env.RECORDINGS_DIR || '/app/recordings');
// Stream covers are stored outside the database, next to the recordings volume.
// COVERS_DIR follows the same deployment convention as RECORDINGS_DIR
// (host: server/covers, container: /app/covers).
const coversRoot = path.resolve(process.env.COVERS_DIR || '/app/covers');
await mkdir(coversRoot, { recursive: true, mode: 0o750 }).catch((error) => {
  console.warn('[covers] 无法创建封面目录，封面上传将不可用:', error?.message || error);
});
// Covers are public: the Android app and the web lobby load them without a JWT.
// Filenames are unique per upload, so the files can be cached aggressively.
app.use('/covers', express.static(coversRoot, {
  index: false,
  dotfiles: 'ignore',
  fallthrough: true,
  redirect: false,
  maxAge: '7d',
  immutable: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

await db.query(`CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(40) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  banned_at DATETIME NULL,
  ban_reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);
await db.query(`CREATE TABLE IF NOT EXISTS streams (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  title VARCHAR(120) NOT NULL,
  stream_key VARCHAR(80) UNIQUE NOT NULL,
  is_live BOOLEAN DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  block_reason VARCHAR(255) NULL,
  deleted_at DATETIME NULL,
  cover_url TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

async function ensureColumn(table, column, definition) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, column],
  );
  if (!Number(rows[0].n)) await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Migrations for databases created by earlier v0.4 builds.
await ensureColumn('users', 'is_banned', 'BOOLEAN NOT NULL DEFAULT FALSE');
await ensureColumn('users', 'banned_at', 'DATETIME NULL');
await ensureColumn('users', 'ban_reason', 'VARCHAR(255) NULL');
await ensureColumn('streams', 'is_blocked', 'BOOLEAN NOT NULL DEFAULT FALSE');
await ensureColumn('streams', 'block_reason', 'VARCHAR(255) NULL');
await ensureColumn('streams', 'deleted_at', 'DATETIME NULL');
await ensureColumn('streams', 'cover_url', 'TEXT NULL');

await db.query(`CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  stream_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username VARCHAR(40) NOT NULL,
  content VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_stream_id (stream_id, id),
  FOREIGN KEY(stream_id) REFERENCES streams(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);
await db.query(`CREATE TABLE IF NOT EXISTS admin_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  admin_username VARCHAR(40) NOT NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id VARCHAR(80) NULL,
  details JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_logs_created (created_at)
)`);
await db.query(`CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id VARCHAR(50) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '需要登录' });
    const payload = jwt.verify(header.slice(7), secret);
    const [rows] = await db.query('SELECT id,username,is_banned FROM users WHERE id=? LIMIT 1', [payload.id]);
    if (!rows.length) return res.status(401).json({ error: '账号不存在' });
    if (rows[0].is_banned) return res.status(403).json({ error: '账号已被管理员封禁' });
    req.user = { id: rows[0].id, username: rows[0].username };
    return next();
  } catch {
    return res.status(401).json({ error: '登录状态无效或已过期' });
  }
}

function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '请先登录管理员后台' });
    const payload = jwt.verify(header.slice(7), secret);
    if (payload.admin !== true) return res.status(403).json({ error: '无管理员权限' });
    req.admin = payload;
    return next();
  } catch { return res.status(401).json({ error: '管理员登录已过期，请重新登录' }); }
}

function srsHookAuth(req, res, next) {
  const supplied = String(req.query.secret || '');
  const expected = srsHookSecret;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (!expected || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(403).json({ code: 1, error: 'invalid SRS hook credential' });
  }
  return next();
}

async function writeAdminLog(req, action, targetType = null, targetId = null, details = {}) {
  await db.query(
    'INSERT INTO admin_logs(admin_username,action,target_type,target_id,details,ip_address) VALUES(?,?,?,?,?,?)',
    [req.admin?.username || 'admin', action, targetType, targetId == null ? null : String(targetId), JSON.stringify(details).slice(0, 4000), String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].slice(0, 64)],
  );
}

async function disconnectSrsClients(streamKey) {
  // SRS 5 exposes the publishing client's id as stream.publish.cid.
  // Its HTTP API then supports DELETE /api/v1/clients/{cid}.
  try {
    const response = await fetch('http://srs:1985/api/v1/streams/?count=1000');
    if (!response.ok) return 0;
    const payload = await response.json();
    const rows = Array.isArray(payload.streams) ? payload.streams : (Array.isArray(payload.data?.streams) ? payload.data.streams : (Array.isArray(payload.data) ? payload.data : []));
    let disconnected = 0;
    for (const item of rows) {
      const identity = `${item.app || item.stream?.app || ''}/${item.name || item.stream?.name || ''} ${item.url || item.stream?.url || ''}`;
      if (!identity.includes(streamKey)) continue;
      let clientId = item.publish?.cid ?? item.stream?.publish?.cid;
      if (clientId == null && item.id != null) {
        const detailResponse = await fetch(`http://srs:1985/api/v1/streams/${encodeURIComponent(item.id)}`);
        if (detailResponse.ok) {
          const detail = await detailResponse.json();
          clientId = detail.stream?.publish?.cid ?? detail.data?.stream?.publish?.cid;
        }
      }
      if (clientId != null) {
        const result = await fetch(`http://srs:1985/api/v1/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
        if (result.ok) disconnected += 1;
      }
    }
    return disconnected;
  } catch { return 0; }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, service: 'CongLive API', database: 'ok', media: 'webrtc-whip-whep' }); }
  catch { res.status(503).json({ ok: false, service: 'CongLive API', database: 'error' }); }
}));

function normalizeUsername(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function validUsername(value) {
  // 支持中文、日文、韩文及其他 Unicode 字母/数字；仍不允许空格和特殊符号。
  const length = [...value].length;
  return length >= 3 && length <= 40 && /^[\p{L}\p{N}_]+$/u.test(value);
}

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  if (!validUsername(username)) {
    return res.status(400).json({ error: '用户名需为3-40位中文、字母、数字或下划线，不能包含空格和特殊符号' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: '密码长度需为8-128个字符' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.query('INSERT INTO users(username,password_hash) VALUES(?,?)', [username, hash]);
    return res.status(201).json({ id: result.insertId, username });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在，请直接登录或换一个用户名' });
    console.error('[auth register]', error?.message || error);
    return res.status(500).json({ error: '注册服务暂时不可用，请检查数据库连接或稍后重试' });
  }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || typeof password !== 'string' || !password.length) {
    return res.status(400).json({ error: '请填写用户名和密码' });
  }
  const [rows] = await db.query('SELECT id,username,password_hash,is_banned FROM users WHERE username=? LIMIT 1', [username]);
  if (!rows.length || !await bcrypt.compare(password, rows[0].password_hash)) return res.status(401).json({ error: '用户名或密码错误；请确认这是普通用户账号，而不是后台管理员账号' });
  if (rows[0].is_banned) return res.status(403).json({ error: '账号已被管理员封禁' });
  const user = rows[0];
  return res.json({ token: jwt.sign({ id: user.id, username: user.username }, secret, { expiresIn: '7d' }), user: { id: user.id, username: user.username } });
}));

app.post('/api/streams', auth, asyncRoute(async (req, res) => {
  const title = String(req.body?.title || '我的直播').trim().slice(0, 120) || '我的直播';
  const streamKey = crypto.randomBytes(18).toString('hex');
  const [result] = await db.query('INSERT INTO streams(user_id,title,stream_key) VALUES(?,?,?)', [req.user.id, title, streamKey]);
  const stream = { id: result.insertId, title, userId: req.user.id, username: req.user.username };
  await plugins.emit('stream.created', { stream, user: req.user });
  // Stream keys stay server-side. Clients negotiate WebRTC through authenticated WHIP/WHEP proxy routes.
  return res.status(201).json({ id: result.insertId, title, publishPath: `/api/streams/${result.insertId}/whip`, whepPath: `/api/streams/${result.insertId}/whep`, transport: 'WebRTC' });
}));

function callbackToken(param) {
  try { return new URLSearchParams(String(param || '').replace(/^\?/, '')).get('token') || ''; }
  catch { return ''; }
}

function verifyRtcCallback(req, role, streamKey) {
  try {
    const claims = jwt.verify(callbackToken(req.body?.param), secret);
    if (claims.rtc !== true || claims.role !== role || !Number.isSafeInteger(Number(claims.streamId)) || !Number.isSafeInteger(Number(claims.userId))) return null;
    if (claims.streamKey !== streamKey) return null;
    return claims;
  } catch { return null; }
}

async function proxySrsRtc(req, res, { role, id }) {
  const streamId = Number(id);
  if (!Number.isSafeInteger(streamId) || streamId < 1) return res.status(400).json({ error: '直播编号无效' });
  if (typeof req.body !== 'string' || !req.body.startsWith('v=0')) return res.status(400).json({ error: 'WebRTC SDP Offer 无效' });
  const [rows] = await db.query(
    'SELECT s.id,s.stream_key,s.user_id,s.is_live,s.is_blocked,s.deleted_at,u.is_banned FROM streams s JOIN users u ON u.id=s.user_id WHERE s.id=? LIMIT 1',
    [streamId],
  );
  const stream = rows[0];
  if (!stream || stream.deleted_at || stream.is_blocked || stream.is_banned) return res.status(404).json({ error: '直播不存在或不可用' });
  if (role === 'publish' && Number(stream.user_id) !== Number(req.user.id)) return res.status(403).json({ error: '只能发布自己的直播' });
  if (role === 'play' && !mysqlBoolean(stream.is_live)) return res.status(409).json({ error: '主播尚未开播' });

  const token = jwt.sign({ rtc: true, role, streamId, userId: Number(req.user.id), streamKey: stream.stream_key }, secret, { expiresIn: '10m' });
  const endpoint = role === 'publish' ? 'whip' : 'whep';
  const target = new URL(`${srsRtcApi}/rtc/v1/${endpoint}/`);
  target.searchParams.set('app', 'live');
  target.searchParams.set('stream', stream.stream_key);
  target.searchParams.set('token', token);
  if (rtcCandidate && rtcCandidate !== '*') target.searchParams.set('eip', rtcCandidate);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      body: req.body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    console.error(`[webrtc ${role}] SRS signaling unavailable:`, error?.message || error);
    return res.status(502).json({ error: 'WebRTC 媒体服务器暂时不可用，请检查 SRS 和 1985 内部端口' });
  }
  const answer = await upstream.text();
  if (!upstream.ok || !answer.startsWith('v=0')) {
    console.warn(`[webrtc ${role}] SRS rejected SDP: HTTP ${upstream.status} ${answer.slice(0, 300)}`);
    return res.status(upstream.status >= 400 ? upstream.status : 502).json({ error: `SRS WebRTC 信令失败（HTTP ${upstream.status}）`, detail: answer.slice(0, 500) });
  }
  res.status(upstream.status).type('application/sdp').send(answer);
}

app.post('/api/streams/:id/whip', auth, express.text({ type: 'application/sdp', limit: '256kb' }), asyncRoute(async (req, res) => proxySrsRtc(req, res, { role: 'publish', id: req.params.id })));
app.post('/api/streams/:id/whep', auth, express.text({ type: 'application/sdp', limit: '256kb' }), asyncRoute(async (req, res) => proxySrsRtc(req, res, { role: 'play', id: req.params.id })));

app.post('/api/srs/on_publish', srsHookAuth, asyncRoute(async (req, res) => {
  const streamKey = String(req.body?.stream || '');
  if (!/^[a-f0-9]{36}$/.test(streamKey)) return res.status(400).json({ code: 1, error: 'invalid stream' });
  const claims = verifyRtcCallback(req, 'publish', streamKey);
  if (!claims) return res.status(403).json({ code: 1, error: 'invalid or expired WebRTC publish token' });
  const [rows] = await db.query(
    'SELECT s.id,s.title,s.user_id,s.is_blocked,s.deleted_at,u.username,u.is_banned FROM streams s JOIN users u ON u.id=s.user_id WHERE s.stream_key=? LIMIT 1',
    [streamKey],
  );
  if (!rows.length || Number(rows[0].id) !== Number(claims.streamId) || Number(rows[0].user_id) !== Number(claims.userId) || rows[0].is_blocked || rows[0].deleted_at || rows[0].is_banned) return res.status(403).json({ code: 1, error: 'stream is unavailable' });
  await db.query('UPDATE streams SET is_live=TRUE WHERE id=?', [rows[0].id]);
  const row = rows[0];
  console.info(`[srs] WebRTC publish accepted streamId=${row.id} userId=${row.user_id}`);
  await plugins.emit('stream.published', { stream: { id: row.id, title: row.title, userId: row.user_id, username: row.username } });
  return res.json({ code: 0 });
}));

app.post('/api/srs/on_unpublish', srsHookAuth, asyncRoute(async (req, res) => {
  const streamKey = String(req.body?.stream || '');
  if (streamKey) {
    const [rows] = await db.query('SELECT s.id,s.title,s.user_id,u.username FROM streams s JOIN users u ON u.id=s.user_id WHERE s.stream_key=? LIMIT 1', [streamKey]);
    await db.query('UPDATE streams SET is_live=FALSE WHERE stream_key=?', [streamKey]);
    if (rows.length) {
      console.info(`[srs] WebRTC unpublish accepted streamId=${rows[0].id} userId=${rows[0].user_id}`);
      const row = rows[0];
      closeChatRoom(row.id, '直播已结束');
      await plugins.emit('stream.unpublished', { stream: { id: row.id, title: row.title, userId: row.user_id, username: row.username } });
    }
  }
  return res.json({ code: 0 });
}));

app.post('/api/srs/on_play', srsHookAuth, asyncRoute(async (req, res) => {
  const streamKey = String(req.body?.stream || '');
  const claims = verifyRtcCallback(req, 'play', streamKey);
  if (!claims) return res.status(403).json({ code: 1, error: 'invalid or expired WebRTC playback token' });
  const [[stream]] = await db.query('SELECT s.id,s.user_id,s.is_live,s.is_blocked,s.deleted_at,u.is_banned FROM streams s JOIN users u ON u.id=s.user_id WHERE s.stream_key=? LIMIT 1', [streamKey]);
  if (!stream || Number(stream.id) !== Number(claims.streamId) || !mysqlBoolean(stream.is_live) || stream.is_blocked || stream.deleted_at || stream.is_banned) return res.status(403).json({ code: 1, error: 'stream is unavailable' });
  return res.json({ code: 0 });
}));
app.post('/api/srs/on_stop', srsHookAuth, (_req, res) => res.json({ code: 0 }));

app.get('/api/streams', asyncRoute(async (_req, res) => {
  const [rows] = await db.query('SELECT s.id,s.title,s.is_live,s.cover_url,s.created_at,u.username FROM streams s JOIN users u ON u.id=s.user_id WHERE s.deleted_at IS NULL AND s.is_blocked=FALSE AND s.is_live=TRUE AND u.is_banned=FALSE ORDER BY s.created_at DESC LIMIT 100');
  return res.json(rows.map(({ cover_url: coverUrl, ...stream }) => ({
    ...stream,
    is_live: mysqlBoolean(stream.is_live),
    coverUrl: coverUrl || null,
    whepPath: `/api/streams/${stream.id}/whep`,
    transport: 'WebRTC',
  })));
}));

app.post('/api/streams/:id/cover', auth, coverJsonBody, asyncRoute(async (req, res) => {
  const streamId = Number(req.params.id);
  if (!Number.isSafeInteger(streamId) || streamId < 1) return res.status(400).json({ error: '直播编号无效' });
  const [rows] = await db.query('SELECT id,user_id,cover_url FROM streams WHERE id=? AND deleted_at IS NULL LIMIT 1', [streamId]);
  if (!rows.length) return res.status(404).json({ error: '直播不存在或已删除' });
  if (Number(rows[0].user_id) !== Number(req.user.id)) return res.status(403).json({ error: '只能修改自己的直播封面' });
  let saved;
  try {
    saved = await saveCoverImage(coversRoot, streamId, req.body?.imageData);
  } catch (error) {
    if (error instanceof CoverValidationError) return res.status(error.status).json({ error: error.message });
    console.error('[cover upload]', error?.message || error);
    return res.status(500).json({ error: '封面上传失败，请稍后重试' });
  }
  try {
    await db.query('UPDATE streams SET cover_url=? WHERE id=?', [saved.coverUrl, streamId]);
  } catch (error) {
    // The DB is the source of truth: do not leave an unreferenced file behind.
    await unlink(saved.filePath).catch(() => {});
    throw error;
  }
  const previousFilename = coverFilenameFromUrl(rows[0].cover_url);
  if (previousFilename) await unlink(path.join(coversRoot, previousFilename)).catch(() => {});
  return res.json({ coverUrl: saved.coverUrl });
}));

app.get('/api/streams/:id/messages', asyncRoute(async (req, res) => {
  const streamId = Number(req.params.id);
  if (!Number.isSafeInteger(streamId) || streamId < 1) return res.status(400).json({ error: '直播编号无效' });
  const [streams] = await db.query('SELECT id FROM streams WHERE id=? AND deleted_at IS NULL AND is_blocked=FALSE', [streamId]);
  if (!streams.length) return res.status(404).json({ error: '直播不存在或不可用' });
  const [rows] = await db.query('SELECT id,stream_id AS streamId,username,content,created_at AS createdAt FROM chat_messages WHERE stream_id=? ORDER BY id DESC LIMIT 50', [streamId]);
  return res.json(rows.reverse());
}));

app.get('/api/streams/mine', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.query('SELECT id,title,is_live,cover_url,created_at,is_blocked FROM streams WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC', [req.user.id]);
  return res.json(rows.map(({ cover_url: coverUrl, ...row }) => ({
    ...row,
    is_live: mysqlBoolean(row.is_live),
    is_blocked: mysqlBoolean(row.is_blocked),
    coverUrl: coverUrl || null,
    publishPath: `/api/streams/${row.id}/whip`,
    whepPath: `/api/streams/${row.id}/whep`,
  })));
}));

app.patch('/api/streams/:id/status', auth, (_req, res) => {
  // Live state is authoritative only when SRS calls on_publish/on_unpublish.
  // Do not let clients mark a stream live without an active WebRTC publisher.
  return res.status(405).json({ error: '直播状态由推流服务器自动维护，客户端不能直接修改' });
});

// Real-time chat: the browser authenticates in the first WebSocket message so
// JWTs are not placed in URLs, access logs, or browser history.
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const chatRooms = new Map();
const lastChatAt = new Map();
const sendWs = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
function closeChatRoom(streamId, reason = '直播间已关闭') {
  const room = chatRooms.get(String(streamId));
  if (!room) return;
  for (const ws of room) ws.close(4403, reason);
  chatRooms.delete(String(streamId));
}
function closeUserChatSessions(userId) {
  for (const room of chatRooms.values()) {
    for (const ws of room) if (Number(ws.congliveSession?.userId) === Number(userId)) ws.close(4403, '账号已被封禁');
  }
}
function broadcastChat(streamId, payload) {
  for (const ws of chatRooms.get(String(streamId)) || []) sendWs(ws, payload);
}
httpServer.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname !== '/ws/chat') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});
wss.on('connection', (ws) => {
  let session = null;
  let authTimer = setTimeout(() => ws.close(4401, 'authentication timeout'), 5000);
  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (!session) {
        if (message.type !== 'auth' || typeof message.token !== 'string') return ws.close(4401, 'authentication required');
        const payload = jwt.verify(message.token, secret);
        const streamId = Number(message.streamId);
        if (!Number.isSafeInteger(streamId) || streamId < 1) return ws.close(4400, 'invalid stream');
        const [[user]] = await db.query('SELECT id,username,is_banned FROM users WHERE id=? LIMIT 1', [payload.id]);
        const [[stream]] = await db.query('SELECT id,is_live,is_blocked,deleted_at FROM streams WHERE id=? LIMIT 1', [streamId]);
        if (!user || user.is_banned || !stream || !stream.is_live || stream.is_blocked || stream.deleted_at) return ws.close(4403, 'stream chat unavailable');
        session = { userId: user.id, username: user.username, streamId };
        ws.congliveSession = session;
        clearTimeout(authTimer);
        const room = chatRooms.get(String(streamId)) || new Set();
        room.add(ws); chatRooms.set(String(streamId), room);
        const [history] = await db.query('SELECT id,username,content,created_at AS createdAt FROM chat_messages WHERE stream_id=? ORDER BY id DESC LIMIT 50', [streamId]);
        sendWs(ws, { type: 'ready', streamId, messages: history.reverse() });
        return;
      }
      if (message.type !== 'chat' || typeof message.content !== 'string') return;
      const content = message.content.trim().slice(0, 500);
      if (!content) return;
      const now = Date.now();
      const previous = lastChatAt.get(String(session.userId)) || 0;
      if (now - previous < 900) return sendWs(ws, { type: 'warning', message: '发送太快了，请稍后再试' });
      lastChatAt.set(String(session.userId), now);
      if (lastChatAt.size > 10000) { for (const [key, value] of lastChatAt) if (now - value > 60000) lastChatAt.delete(key); }
      const [[user]] = await db.query('SELECT is_banned FROM users WHERE id=? LIMIT 1', [session.userId]);
      const [[stream]] = await db.query('SELECT is_live,is_blocked,deleted_at FROM streams WHERE id=? LIMIT 1', [session.streamId]);
      if (!user || user.is_banned || !stream || !stream.is_live || stream.is_blocked || stream.deleted_at) return ws.close(4403, 'stream chat unavailable');
      const [result] = await db.query('INSERT INTO chat_messages(stream_id,user_id,username,content) VALUES(?,?,?,?)', [session.streamId, session.userId, session.username, content]);
      const [[saved]] = await db.query('SELECT id,username,content,created_at AS createdAt FROM chat_messages WHERE id=?', [result.insertId]);
      broadcastChat(session.streamId, { type: 'message', message: saved });
    } catch (error) {
      sendWs(ws, { type: 'error', message: '消息处理失败' });
      if (!session) ws.close(4401, 'authentication failed');
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!session) return;
    const room = chatRooms.get(String(session.streamId));
    room?.delete(ws);
    if (room && room.size === 0) chatRooms.delete(String(session.streamId));
  });
});

const enabledCsv = process.env.PLUGIN_ENABLED || 'welcome,stream-audit';
const [pluginRows] = await db.query('SELECT plugin_id,enabled FROM plugin_settings');
const pluginOverrides = Object.fromEntries(pluginRows.map((row) => [row.plugin_id, Boolean(row.enabled)]));
const plugins = await createPluginManager({ app, db, auth, dataDir: process.env.DATA_DIR || '/app/data', enabledCsv, overrides: pluginOverrides, logger: console });

// Admin WebUI (separate administrator credential; never the end-user login).
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || '';
app.get(['/admin', '/admin/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(new URL('../public/admin.html', import.meta.url).pathname);
});
app.post('/api/admin/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const supplied = Buffer.from(String(password || '').padEnd(256, '\0').slice(0, 256));
  const expected = Buffer.from(String(adminPassword).padEnd(256, '\0').slice(0, 256));
  if (!adminPassword || typeof username !== 'string' || username !== adminUsername || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: '管理员账号或密码错误' });
  return res.json({ token: jwt.sign({ admin: true, username }, secret, { expiresIn: '12h' }) });
}));

app.get('/api/admin/stats', adminAuth, asyncRoute(async (_req, res) => {
  const [[users]] = await db.query('SELECT COUNT(*) AS n FROM users');
  const [[streams]] = await db.query('SELECT COUNT(*) AS n FROM streams WHERE deleted_at IS NULL');
  const [[live]] = await db.query('SELECT COUNT(*) AS n FROM streams WHERE is_live=TRUE AND deleted_at IS NULL');
  const [[banned]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE is_banned=TRUE');
  const recordings = await collectRecordingFiles();
  res.json({ users: Number(users.n), streams: Number(streams.n), live: Number(live.n), banned: Number(banned.n), recordings: recordings.length, plugins: plugins.list().filter((item) => item.enabled).length });
}));
app.get('/api/admin/streams', adminAuth, asyncRoute(async (_req, res) => {
  const [rows] = await db.query('SELECT s.id,s.title,s.is_live,s.is_blocked,s.block_reason,s.deleted_at,s.created_at,u.username,u.is_banned FROM streams s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 300');
  res.json(rows);
}));
app.patch('/api/admin/streams/:id/block', adminAuth, asyncRoute(async (req, res) => {
  const blocked = Boolean(req.body?.blocked);
  const reason = String(req.body?.reason || '').trim().slice(0, 255) || null;
  const [rows] = await db.query('SELECT id,stream_key FROM streams WHERE id=? AND deleted_at IS NULL LIMIT 1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '直播不存在' });
  await db.query('UPDATE streams SET is_blocked=?,block_reason=?,is_live=IF(?,FALSE,is_live) WHERE id=?', [blocked, blocked ? reason : null, blocked, req.params.id]);
  const disconnected = blocked ? await disconnectSrsClients(rows[0].stream_key) : 0;
  if (blocked) closeChatRoom(req.params.id, '直播间已被管理员封禁');
  await writeAdminLog(req, blocked ? 'stream.block' : 'stream.unblock', 'stream', req.params.id, { reason, disconnected });
  res.json({ ok: true, blocked, disconnected });
}));
app.delete('/api/admin/streams/:id', adminAuth, asyncRoute(async (req, res) => {
  const [rows] = await db.query('SELECT id,stream_key FROM streams WHERE id=? AND deleted_at IS NULL LIMIT 1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '直播不存在' });
  await db.query('UPDATE streams SET deleted_at=NOW(),is_blocked=TRUE,is_live=FALSE,block_reason=COALESCE(block_reason,?) WHERE id=?', ['管理员删除', req.params.id]);
  const disconnected = await disconnectSrsClients(rows[0].stream_key);
  closeChatRoom(req.params.id, '直播间已删除');
  await writeAdminLog(req, 'stream.delete', 'stream', req.params.id, { disconnected, softDelete: true });
  res.json({ ok: true, disconnected, softDelete: true });
}));
app.get('/api/admin/users', adminAuth, asyncRoute(async (_req, res) => {
  const [rows] = await db.query('SELECT u.id,u.username,u.created_at,u.is_banned,u.banned_at,u.ban_reason,COUNT(s.id) AS stream_count FROM users u LEFT JOIN streams s ON s.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC LIMIT 300');
  res.json(rows);
}));
app.patch('/api/admin/users/:id/ban', adminAuth, asyncRoute(async (req, res) => {
  const banned = Boolean(req.body?.banned);
  const reason = String(req.body?.reason || '').trim().slice(0, 255) || null;
  const [users] = await db.query('SELECT id FROM users WHERE id=? LIMIT 1', [req.params.id]);
  if (!users.length) return res.status(404).json({ error: '用户不存在' });
  let disconnected = 0;
  // Persist the ban first so a reconnect/new publish is rejected immediately.
  await db.query('UPDATE users SET is_banned=?,banned_at=IF(?,NOW(),NULL),ban_reason=? WHERE id=?', [banned, banned, banned ? reason : null, req.params.id]);
  if (banned) {
    closeUserChatSessions(req.params.id);
    const [owned] = await db.query('SELECT stream_key FROM streams WHERE user_id=? AND is_live=TRUE', [req.params.id]);
    await db.query('UPDATE streams SET is_live=FALSE WHERE user_id=?', [req.params.id]);
    for (const stream of owned) disconnected += await disconnectSrsClients(stream.stream_key);
  }
  await writeAdminLog(req, banned ? 'user.ban' : 'user.unban', 'user', req.params.id, { reason, disconnected });
  res.json({ ok: true, banned, disconnected });
}));

async function collectRecordingFiles(recordingBase = recordingApiBase) {
  const found = [];
  async function walk(directory, relative = '', depth = 0) {
    if (depth > 8 || found.length >= 1000) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, rel, depth + 1);
      else if (entry.isFile() && /\.(mp4|flv|mkv)$/i.test(entry.name)) {
        try {
          const info = await stat(full);
          const encoded = Buffer.from(rel).toString('base64url');
          const token = jwt.sign({ admin: true, scope: 'recording', fileId: encoded }, secret, { expiresIn: '6h' });
          const url = `${recordingBase}/${encoded}/play?token=${encodeURIComponent(token)}`;
          found.push({ id: encoded, name: entry.name, path: rel, size: info.size, createdAt: info.birthtime.toISOString(), modifiedAt: info.mtime.toISOString(), playUrl: url });
        } catch { /* ignore files removed during listing */ }
      }
      if (found.length >= 1000) break;
    }
  }
  await walk(recordingsRoot);
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
app.get('/api/admin/recordings', adminAuth, asyncRoute(async (req, res) => {
  const base = recordingApiBaseForRequest(req, { publicHost: publicHostRaw, fallbackBase: recordingApiBase });
  res.setHeader('Cache-Control', 'no-store');
  return res.json(await collectRecordingFiles(base));
}));

// End users can view only recordings whose filename belongs to one of their
// own stream keys. The returned playUrl is short-lived and range-playable.
app.get('/api/recordings/mine', auth, asyncRoute(async (req, res) => {
  const [ownedStreams] = await db.query('SELECT stream_key FROM streams WHERE user_id=?', [req.user.id]);
  const ownedKeys = ownedStreams.map((row) => String(row.stream_key));
  if (!ownedKeys.length) return res.json([]);
  const base = recordingApiBaseForRequest(req, { publicHost: publicHostRaw, fallbackBase: recordingApiBase });
  const files = await collectRecordingFiles(base);
  const ownedFiles = files.filter((file) => recordingBelongsToStreams(file.path, ownedKeys));
  res.setHeader('Cache-Control', 'no-store');
  return res.json(ownedFiles);
}));
async function resolveRecordingFile(id) {
  let relative;
  try { relative = Buffer.from(id, 'base64url').toString('utf8'); }
  catch { const error = new Error('录像编号无效'); error.code = 'EINVAL'; throw error; }
  if (!relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) {
    const error = new Error('录像路径无效'); error.code = 'EINVAL'; throw error;
  }
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    const error = new Error('录像路径无效'); error.code = 'EINVAL'; throw error;
  }
  let cursor = recordingsRoot;
  const rootInfo = await lstat(cursor);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) { const error = new Error('录像目录无效'); error.code = 'EINVAL'; throw error; }
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) { const error = new Error('不允许访问符号链接'); error.code = 'EINVAL'; throw error; }
    if (index < parts.length - 1 && !info.isDirectory()) { const error = new Error('录像路径无效'); error.code = 'EINVAL'; throw error; }
    if (index === parts.length - 1 && !info.isFile()) { const error = new Error('只能操作录像文件'); error.code = 'EINVAL'; throw error; }
  }
  return { relative, full: cursor, info: await stat(cursor) };
}

// Short-lived signed URLs support HTML5 byte-range playback without exposing
// the raw SRS recordings directory to the public network.
app.get('/api/recordings/:id/play', asyncRoute(async (req, res) => {
  let claims;
  try { claims = jwt.verify(String(req.query.token || ''), secret); }
  catch { return res.status(401).json({ error: '回放链接已失效，请在后台重新打开录像' }); }
  if (claims.admin !== true || claims.scope !== 'recording' || claims.fileId !== req.params.id) return res.status(403).json({ error: '无权播放该录像' });
  let file;
  try { file = await resolveRecordingFile(req.params.id); }
  catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: '录像不存在' });
    if (error?.code === 'EINVAL') return res.status(400).json({ error: error.message });
    throw error;
  }
  const ext = path.extname(file.full).toLowerCase();
  res.setHeader('Content-Type', ext === '.mp4' ? 'video/mp4' : (ext === '.flv' ? 'video/x-flv' : 'video/x-matroska'));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  const range = req.headers.range;
  let start = 0;
  let end = Math.max(0, file.info.size - 1);
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || file.info.size === 0) {
      res.setHeader('Content-Range', `bytes */${file.info.size}`);
      return res.status(416).end();
    }
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) { res.setHeader('Content-Range', `bytes */${file.info.size}`); return res.status(416).end(); }
      start = Math.max(0, file.info.size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? end : Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.info.size) {
      res.setHeader('Content-Range', `bytes */${file.info.size}`);
      return res.status(416).end();
    }
    end = Math.min(end, file.info.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.info.size}`);
  }
  res.setHeader('Content-Length', String(file.info.size === 0 ? 0 : end - start + 1));
  const input = file.info.size === 0 ? null : createReadStream(file.full, { start, end });
  if (!input) return res.end();
  input.on('error', () => res.destroy());
  input.pipe(res);
}));

app.delete('/api/admin/recordings/:id', adminAuth, asyncRoute(async (req, res) => {
  try {
    const file = await resolveRecordingFile(req.params.id);
    await unlink(file.full);
    await writeAdminLog(req, 'recording.delete', 'recording', file.relative, { size: file.info.size });
    return res.json({ ok: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: '录像不存在' });
    if (error?.code === 'EINVAL') return res.status(400).json({ error: error.message });
    throw error;
  }
}));
// Public read-only summary used by server/install.sh and server/manage.sh.
// Only enabled plugins are listed; errors and local paths stay admin-only.
app.get('/api/plugins', asyncRoute(async (_req, res) => {
  const enabled = plugins.list()
    .filter((plugin) => plugin.enabled)
    .map(({ id, name, version, description, status }) => ({ id, name, version, description, status }));
  return res.json({ plugins: enabled });
}));
app.get('/api/admin/plugins', adminAuth, (_req, res) => res.json({ plugins: plugins.list() }));
app.patch('/api/admin/plugins/:id', adminAuth, asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const id = String(req.params.id || '');
  const result = await plugins.setEnabled(id, enabled);
  await db.query('INSERT INTO plugin_settings(plugin_id,enabled) VALUES(?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)', [id, enabled]);
  await writeAdminLog(req, enabled ? 'plugin.enable' : 'plugin.disable', 'plugin', id, { status: result.status });
  res.json({ ok: true, plugin: result });
}));
app.get('/api/admin/logs', adminAuth, asyncRoute(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const [rows] = await db.query('SELECT id,admin_username AS adminUsername,action,target_type AS targetType,target_id AS targetId,details,ip_address AS ipAddress,created_at AS createdAt FROM admin_logs ORDER BY id DESC LIMIT ?', [limit]);
  res.json(rows.map((row) => ({ ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details })));
}));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' });
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求内容不是有效的 JSON' });
  console.error('[api error]', error?.message || error);
  return res.status(500).json({ error: '服务器内部错误' });
});

httpServer.listen(apiPort, '0.0.0.0', () => console.log(`CongLive API listening on ${apiPort}`));
