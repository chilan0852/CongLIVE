import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  DEFAULT_SERVER,
  MAX_URL_LENGTH,
  normalizeServerUrl,
  normalizeServerOrDefault,
  loadConfig,
  saveConfig,
} = await import('../src/config.js');

test('default server is the production deployment', () => {
  assert.equal(DEFAULT_SERVER, 'https://xinglan.work');
});

test('bare production domain gets https', () => {
  assert.deepEqual(normalizeServerUrl('xinglan.work'), { ok: true, url: 'https://xinglan.work' });
  assert.deepEqual(normalizeServerUrl('live.example.com'), { ok: true, url: 'https://live.example.com' });
});

test('explicit http/https is preserved, trailing slash removed', () => {
  assert.deepEqual(normalizeServerUrl('https://xinglan.work/'), { ok: true, url: 'https://xinglan.work' });
  assert.deepEqual(normalizeServerUrl('http://example.com:8081/'), { ok: true, url: 'http://example.com:8081' });
  assert.deepEqual(normalizeServerUrl('HTTPS://XingLan.Work'), { ok: true, url: 'https://xinglan.work' });
});

test('LAN/loopback addresses default to http', () => {
  assert.deepEqual(normalizeServerUrl('192.168.1.10:8081'), { ok: true, url: 'http://192.168.1.10:8081' });
  assert.deepEqual(normalizeServerUrl('10.0.0.5'), { ok: true, url: 'http://10.0.0.5' });
  assert.deepEqual(normalizeServerUrl('172.16.3.9:8081'), { ok: true, url: 'http://172.16.3.9:8081' });
  assert.deepEqual(normalizeServerUrl('127.0.0.1:5173'), { ok: true, url: 'http://127.0.0.1:5173' });
  assert.deepEqual(normalizeServerUrl('localhost:3000'), { ok: true, url: 'http://localhost:3000' });
});

test('path prefixes are kept, query/hash dropped', () => {
  assert.deepEqual(normalizeServerUrl('example.com/live/'), { ok: true, url: 'https://example.com/live' });
  assert.deepEqual(normalizeServerUrl('https://example.com/a//b//'), { ok: true, url: 'https://example.com/a/b' });
  assert.deepEqual(normalizeServerUrl('https://example.com/live?token=1#top'), { ok: true, url: 'https://example.com/live' });
});

test('protocol-relative and whitespace input', () => {
  assert.deepEqual(normalizeServerUrl('  //example.com  '), { ok: true, url: 'https://example.com' });
  assert.deepEqual(normalizeServerUrl('  https://xinglan.work  '), { ok: true, url: 'https://xinglan.work' });
});

test('empty input is rejected', () => {
  assert.deepEqual(normalizeServerUrl(''), { ok: false, url: '', error: 'empty' });
  assert.deepEqual(normalizeServerUrl('   '), { ok: false, url: '', error: 'empty' });
  assert.deepEqual(normalizeServerUrl(null), { ok: false, url: '', error: 'empty' });
});

test('unsupported protocols are rejected', () => {
  assert.equal(normalizeServerUrl('ftp://example.com').ok, false);
  assert.equal(normalizeServerUrl('ftp://example.com').error, 'protocol');
  assert.equal(normalizeServerUrl('file:///etc/passwd').error, 'protocol');
});

test('credentials are rejected', () => {
  const result = normalizeServerUrl('https://user:secret@example.com');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'credentials');
});

test('garbage and overlong input are rejected', () => {
  assert.equal(normalizeServerUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeServerUrl('https://').error, 'invalid');
  assert.equal(normalizeServerUrl('x'.repeat(MAX_URL_LENGTH + 1)).error, 'length');
});

test('normalizeServerOrDefault falls back for invalid values', () => {
  assert.equal(normalizeServerOrDefault('not a url !'), DEFAULT_SERVER);
  assert.equal(normalizeServerOrDefault(''), DEFAULT_SERVER);
  assert.equal(normalizeServerOrDefault('example.com'), 'https://example.com');
});

test('saveConfig/loadConfig round-trip in userData', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conglive-pc-'));
  try {
    const saved = saveConfig(dir, {
      serverUrl: '192.168.1.10:8081/',
      windowBounds: { x: 10, y: 20, width: 1440, height: 900 },
      maximized: false,
    });
    assert.equal(saved.serverUrl, 'http://192.168.1.10:8081');
    const loaded = loadConfig(dir);
    assert.equal(loaded.serverUrl, 'http://192.168.1.10:8081');
    assert.deepEqual(loaded.windowBounds, { x: 10, y: 20, width: 1440, height: 900 });
    assert.equal(loaded.maximized, false);
    assert.ok(loaded.updatedAt);
    assert.match(readFileSync(join(dir, 'config.json'), 'utf8'), /"serverUrl": "http:\/\/192\.168\.1\.10:8081"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig tolerates missing/corrupt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conglive-pc-'));
  try {
    const empty = loadConfig(dir);
    assert.equal(empty.serverUrl, '');
    assert.equal(empty.windowBounds, null);
    writeFileSync(join(dir, 'config.json'), '{ not json', 'utf8');
    assert.equal(loadConfig(dir).serverUrl, '');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ serverUrl: 'ftp://bad', windowBounds: 'nope' }), 'utf8');
    const invalid = loadConfig(dir);
    assert.equal(invalid.serverUrl, '');
    assert.equal(invalid.windowBounds, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
