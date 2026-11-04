import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_COVER_BYTES,
  CoverValidationError,
  coverFilenameFromUrl,
  createCoverFilename,
  detectCoverImageMime,
  parseCoverImageData,
  saveCoverImage,
} from '../src/covers-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

// Minimal valid signatures for each whitelisted format.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0x00, 0x00, 0x00, 0x0d])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 ')]);
const dataUri = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

const isValidationError = (status) => (error) => error instanceof CoverValidationError && error.status === status;

test('detectCoverImageMime recognises JPEG/PNG/WebP magic bytes only', () => {
  assert.equal(detectCoverImageMime(JPEG), 'image/jpeg');
  assert.equal(detectCoverImageMime(PNG), 'image/png');
  assert.equal(detectCoverImageMime(WEBP), 'image/webp');
  assert.equal(detectCoverImageMime(Buffer.from('GIF89a......')), null);
  assert.equal(detectCoverImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(detectCoverImageMime(Buffer.alloc(0)), null);
  assert.equal(detectCoverImageMime(null), null);
});

test('parseCoverImageData accepts the three allowed data URI formats', () => {
  const cases = [
    ['image/jpeg', 'jpg', JPEG],
    ['image/png', 'png', PNG],
    ['image/webp', 'webp', WEBP],
  ];
  for (const [mime, extension, buffer] of cases) {
    const parsed = parseCoverImageData(dataUri(mime, buffer));
    assert.equal(parsed.mime, mime);
    assert.equal(parsed.extension, extension);
    assert.deepEqual(parsed.buffer, buffer);
    // MIME is matched case-insensitively, e.g. what some Android encoders emit.
    assert.equal(parseCoverImageData(dataUri(mime.toUpperCase(), buffer)).mime, mime);
  }
});

test('parseCoverImageData rejects non-whitelisted, spoofed and malformed images', () => {
  assert.throws(() => parseCoverImageData(dataUri('image/gif', Buffer.from('GIF89a......'))), isValidationError(400));
  assert.throws(() => parseCoverImageData(dataUri('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), isValidationError(400));
  // PNG bytes declared as JPEG: the real header must win over the claimed type.
  assert.throws(() => parseCoverImageData(dataUri('image/jpeg', PNG)), isValidationError(400));
  assert.throws(() => parseCoverImageData(null), isValidationError(400));
  assert.throws(() => parseCoverImageData(''), isValidationError(400));
  assert.throws(() => parseCoverImageData('http://example.com/a.png'), isValidationError(400));
  assert.throws(() => parseCoverImageData('data:image/png;base64,%%%%'), isValidationError(400));
  assert.throws(() => parseCoverImageData('data:image/png;base64,'), isValidationError(400));
});

test('parseCoverImageData enforces the 2MB decoded limit exactly', () => {
  const atLimit = Buffer.concat([PNG, Buffer.alloc(MAX_COVER_BYTES - PNG.length)]);
  assert.equal(parseCoverImageData(dataUri('image/png', atLimit)).buffer.length, MAX_COVER_BYTES);

  const overLimit = Buffer.concat([PNG, Buffer.alloc(MAX_COVER_BYTES + 1 - PNG.length)]);
  assert.throws(() => parseCoverImageData(dataUri('image/png', overLimit)), isValidationError(413));
});

test('createCoverFilename is safe, unique and extension-restricted', () => {
  const first = createCoverFilename(42, 'jpg');
  const second = createCoverFilename(42, 'jpg');
  assert.match(first, /^s42-[a-f0-9]{32}\.jpg$/);
  assert.notEqual(first, second);
  assert.match(createCoverFilename('7; rm -rf /', 'png'), /^s7-[a-f0-9]{32}\.png$/);
  assert.throws(() => createCoverFilename(1, 'svg'), isValidationError(400));
});

test('coverFilenameFromUrl only returns managed, traversal-free filenames', () => {
  assert.equal(coverFilenameFromUrl('/covers/s42-abc.png'), 's42-abc.png');
  assert.equal(coverFilenameFromUrl('/covers/../etc/passwd'), null);
  assert.equal(coverFilenameFromUrl('/covers/a/b.png'), null);
  assert.equal(coverFilenameFromUrl('/covers/'), null);
  assert.equal(coverFilenameFromUrl('https://example.com/covers/a.png'), null);
  assert.equal(coverFilenameFromUrl(null), null);
});

test('saveCoverImage writes a unique file inside COVERS_DIR and returns /covers URL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'conglive-covers-'));
  try {
    const first = await saveCoverImage(directory, 7, dataUri('image/png', PNG));
    assert.match(first.filename, /^s7-[a-f0-9]{32}\.png$/);
    assert.equal(first.coverUrl, `/covers/${first.filename}`);
    assert.equal(first.mime, 'image/png');
    assert.equal(first.size, PNG.length);
    assert.deepEqual(await readFile(first.filePath), PNG);

    const second = await saveCoverImage(directory, 7, dataUri('image/png', PNG));
    assert.notEqual(second.filename, first.filename);

    // The directory is created on demand (fresh volume / first upload).
    const nested = await saveCoverImage(path.join(directory, 'nested', 'deeper'), 8, dataUri('image/webp', WEBP));
    assert.equal((await stat(nested.filePath)).isFile(), true);
    assert.match(nested.coverUrl, /^\/covers\/s8-[a-f0-9]{32}\.webp$/);

    await assert.rejects(() => saveCoverImage(directory, 9, dataUri('image/gif', Buffer.from('GIF89a......'))), isValidationError(400));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('streams schema gains cover_url without dropping existing data', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /CREATE TABLE IF NOT EXISTS streams \([\s\S]*?cover_url TEXT NULL[\s\S]*?FOREIGN KEY\(user_id\) REFERENCES users\(id\)/);
  assert.match(source, /await ensureColumn\('streams', 'cover_url', 'TEXT NULL'\);/);
  // Existing migrations must stay in place next to the new one.
  assert.match(source, /await ensureColumn\('streams', 'deleted_at', 'DATETIME NULL'\);/);
});

test('cover upload route is authenticated, owner-only and has its own 4mb body limit', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /const coverJsonBody = express\.json\(\{ limit: '4mb' \}\);/);
  assert.match(source, /if \(req\.method === 'POST' && /);
  assert.ok(source.includes('/^\\/api\\/streams\\/[0-9]+\\/cover\\/?$/.test(req.path)'), 'cover path is skipped by the default 100kb JSON parser');
  assert.match(source, /app\.post\('\/api\/streams\/:id\/cover', auth, coverJsonBody, asyncRoute/);
  assert.match(source, /if \(Number\(rows\[0\]\.user_id\) !== Number\(req\.user\.id\)\) return res\.status\(403\)/);
  assert.match(source, /UPDATE streams SET cover_url=\? WHERE id=\?/);
  assert.match(source, /return res\.json\(\{ coverUrl: saved\.coverUrl \}\);/);
});

test('GET /api/streams and /api/streams/mine expose coverUrl', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /SELECT s\.id,s\.title,s\.is_live,s\.cover_url,s\.created_at,u\.username/);
  assert.match(source, /coverUrl: coverUrl \|\| null,/);
  assert.match(source, /SELECT id,title,is_live,cover_url,created_at,is_blocked FROM streams WHERE user_id=\?/);
  assert.match(source, /app\.get\('\/api\/streams\/mine', auth, asyncRoute/);
});

test('express serves /covers with public cache headers', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /const coversRoot = path\.resolve\(process\.env\.COVERS_DIR \|\| '\/app\/covers'\);/);
  assert.match(source, /app\.use\('\/covers', express\.static\(coversRoot,/);
  assert.match(source, /res\.setHeader\('Cache-Control', 'public, max-age=604800, immutable'\);/);
  assert.match(source, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\);/);
});

test('deployment mounts server/covers and proxies /covers to the backend', async () => {
  const compose = await read('server/docker-compose.yml');
  assert.match(compose, /COVERS_DIR: \/app\/covers/);
  assert.match(compose, /- \.\/covers:\/app\/covers/);

  const install = await read('server/install.sh');
  assert.match(install, /mkdir -p recordings\/live srs-html\/live srs-html\/recordings plugin-data covers/);
  assert.match(install, /chmod 750 recordings plugin-data covers/);
  assert.match(install, /chown -R 1000:1000 recordings srs-html plugin-data covers/);

  const caddy = await read('server/Caddyfile');
  assert.match(caddy, /@backend path \/api\/\* \/ws\/\* \/admin\* \/covers\/\*/);

  const gitignore = await read('server/.gitignore');
  assert.match(gitignore, /covers\/\*\*/);
  assert.match(gitignore, /!covers\/\.gitkeep/);

  const envExample = await read('backend/.env.example');
  assert.match(envExample, /COVERS_DIR=\.\.\/server\/covers/);
});
