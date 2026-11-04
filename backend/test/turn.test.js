import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TURN_TTL,
  MAX_TURN_TTL,
  MIN_TURN_TTL,
  TURN_USERNAME_SUFFIX,
  buildTurnUrls,
  clampTurnTtl,
  computeTurnCredential,
  normalizeTurnHost,
  normalizeTurnUrls,
  turnSettingsFromEnv,
} from '../src/turn-utils.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));

test('coturn REST credential is the base64 HMAC-SHA1 of <expiry>:conglive', () => {
  const secret = 'conglive-turn-test-secret';
  const now = 1700000000123; // 2023-11-14T22:13:20Z in ms
  const result = computeTurnCredential({ secret, ttl: 3600, now });
  assert.equal(result.username, '1700003600:conglive');
  assert.equal(result.expiresAt, 1700003600);
  assert.equal(result.ttl, 3600);
  const expected = crypto.createHmac('sha1', secret).update(result.username).digest('base64');
  assert.equal(result.credential, expected);
  // The credential must be standard base64 (coturn decodes with a normal base64 decoder).
  assert.match(result.credential, /^[A-Za-z0-9+/]+={0,2}$/);
});

test('TURN credentials default to a one hour ttl', () => {
  const now = 1730000000123;
  const result = computeTurnCredential({ secret: 's3cr3t', now });
  assert.equal(result.ttl, DEFAULT_TURN_TTL);
  assert.equal(result.ttl, 3600);
  assert.equal(result.username, `${Math.floor(now / 1000) + 3600}:${TURN_USERNAME_SUFFIX}`);
});

test('TURN credentials honour a custom ttl and clamp unsafe values', () => {
  const now = 1712345678000;
  const custom = computeTurnCredential({ secret: 's3cr3t', ttl: 7200, now });
  assert.equal(custom.ttl, 7200);
  assert.equal(custom.expiresAt, Math.floor(now / 1000) + 7200);

  assert.equal(computeTurnCredential({ secret: 's3cr3t', ttl: 5, now }).ttl, MIN_TURN_TTL);
  assert.equal(computeTurnCredential({ secret: 's3cr3t', ttl: 999999, now }).ttl, MAX_TURN_TTL);
  assert.equal(computeTurnCredential({ secret: 's3cr3t', ttl: 'not-a-number', now }).ttl, DEFAULT_TURN_TTL);
  assert.equal(clampTurnTtl(undefined), DEFAULT_TURN_TTL);
  assert.equal(clampTurnTtl('120'), 120);
});

test('TURN credential generation refuses a missing secret', () => {
  for (const secret of ['', '   ', null, undefined]) {
    assert.throws(() => computeTurnCredential({ secret }), TypeError);
  }
});

test('default TURN urls use the public domain for udp, tcp and stun', () => {
  assert.deepEqual(buildTurnUrls({ host: 'xinglan.work' }), [
    'turn:xinglan.work:3478?transport=udp',
    'turn:xinglan.work:3478?transport=tcp',
    'stun:xinglan.work:3478',
  ]);
  assert.deepEqual(buildTurnUrls({ host: 'xinglan.work', port: 3479 })[0], 'turn:xinglan.work:3479?transport=udp');
});

test('TURN_URLS overrides the derived urls and only keeps ICE schemes', () => {
  assert.deepEqual(
    buildTurnUrls({ urls: 'turn:relay.example.com:3478?transport=udp, stun:relay.example.com:3478', host: 'ignored' }),
    ['turn:relay.example.com:3478?transport=udp', 'stun:relay.example.com:3478'],
  );
  // Duplicates, blanks and non-ICE entries are dropped.
  assert.deepEqual(
    normalizeTurnUrls(['turn:a.example:3478', 'turn:a.example:3478', 'http://evil.example', '', 'stuns:b.example:5349']),
    ['turn:a.example:3478', 'stuns:b.example:5349'],
  );
  assert.deepEqual(normalizeTurnUrls(undefined), []);
});

test('TURN host normalisation handles domains, ports, protocols and IPv6', () => {
  assert.equal(normalizeTurnHost('https://xinglan.work/'), 'xinglan.work');
  assert.equal(normalizeTurnHost('  xinglan.work  '), 'xinglan.work');
  assert.equal(normalizeTurnHost('[2001:db8::1]'), '[2001:db8::1]');
  assert.deepEqual(buildTurnUrls({ host: '2001:db8::1' }), [
    'turn:[2001:db8::1]:3478?transport=udp',
    'turn:[2001:db8::1]:3478?transport=tcp',
    'stun:[2001:db8::1]:3478',
  ]);
  // A host with an explicit port is not given a second one.
  assert.deepEqual(buildTurnUrls({ host: 'relay.example.com:3478', port: 3478 }), [
    'turn:relay.example.com:3478?transport=udp',
    'turn:relay.example.com:3478?transport=tcp',
    'stun:relay.example.com:3478',
  ]);
  assert.deepEqual(buildTurnUrls({ host: '', urls: '' }), []);
  assert.deepEqual(buildTurnUrls({ host: 'xinglan.work', tls: true, tlsPort: 5349 }), [
    'turn:xinglan.work:3478?transport=udp',
    'turn:xinglan.work:3478?transport=tcp',
    'turns:xinglan.work:5349?transport=tcp',
    'stun:xinglan.work:3478',
  ]);
  assert.ok(buildTurnUrls({ host: 'xinglan.work', tls: 'on', tlsPort: 9999 }).includes('turns:xinglan.work:9999?transport=tcp'));
});

test('turnSettingsFromEnv resolves secret, urls and ttl', () => {
  const settings = turnSettingsFromEnv({
    TURN_SECRET: '  shared-secret  ',
    PUBLIC_HOST: 'xinglan.work',
  });
  assert.equal(settings.secret, 'shared-secret');
  assert.equal(settings.ttl, 3600);
  assert.deepEqual(settings.urls, [
    'turn:xinglan.work:3478?transport=udp',
    'turn:xinglan.work:3478?transport=tcp',
    'stun:xinglan.work:3478',
  ]);

  // TURN_HOST/TURN_DOMAIN take precedence over PUBLIC_HOST; TURN_URLS wins over both.
  assert.deepEqual(turnSettingsFromEnv({ TURN_SECRET: 'x', TURN_HOST: 'turn.example', PUBLIC_HOST: 'pub.example' }).urls[0], 'turn:turn.example:3478?transport=udp');
  assert.deepEqual(turnSettingsFromEnv({ TURN_SECRET: 'x', TURN_DOMAIN: 'turn.example', PUBLIC_HOST: 'pub.example' }).urls[0], 'turn:turn.example:3478?transport=udp');
  assert.deepEqual(
    turnSettingsFromEnv({ TURN_SECRET: 'x', TURN_URLS: 'turn:relay.example:3478?transport=tcp', PUBLIC_HOST: 'pub.example' }).urls,
    ['turn:relay.example:3478?transport=tcp'],
  );
  assert.equal(turnSettingsFromEnv({ TURN_SECRET: 'x', TURN_TTL: '900' }).ttl, 900);
});

test('turnSettingsFromEnv reports TURN as unconfigured without a secret', () => {
  for (const env of [{}, { TURN_SECRET: '' }, { TURN_SECRET: '   ' }]) {
    const settings = turnSettingsFromEnv({ ...env, PUBLIC_HOST: 'xinglan.work' });
    assert.equal(settings.secret, '');
    // URLs may still be known, but the route must answer 503 while secret is empty.
    assert.deepEqual(settings.urls, [
      'turn:xinglan.work:3478?transport=udp',
      'turn:xinglan.work:3478?transport=tcp',
      'stun:xinglan.work:3478',
    ]);
  }
});

test('index.js exposes authenticated GET /api/turn-credentials with STUN fallback', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /import \{ computeTurnCredential, turnSettingsFromEnv \} from '\.\/turn-utils\.js';/);
  assert.match(source, /const turnSettings = turnSettingsFromEnv\(process\.env\);/);
  const route = /app\.get\('\/api\/turn-credentials', auth, \(_req, res\) => \{[\s\S]*?\n\}\);/.exec(source)?.[0] || '';
  assert.ok(route, 'turn-credentials route exists and requires auth');
  assert.match(route, /res\.setHeader\('Cache-Control', 'no-store'\);/);
  assert.match(route, /if \(!turnSettings\.secret\) \{[\s\S]*?res\.status\(503\)\.json\(\{ error: /);
  assert.match(route, /computeTurnCredential\(\{[\s\S]*?secret: turnSettings\.secret,[\s\S]*?ttl: turnSettings\.ttl,/);
  assert.match(route, /return res\.json\(\{ urls: turnSettings\.urls, username, credential, ttl \}\);/);
});

test('server/turn.conf is a coturn REST template with the runtime placeholders', async () => {
  const conf = await read('../../server/turn.conf');
  assert.match(conf, /^listening-port=3478$/m);
  assert.match(conf, /^fingerprint$/m);
  assert.match(conf, /^use-auth-secret$/m);
  assert.match(conf, /^static-auth-secret=\$TURN_SECRET$/m);
  assert.match(conf, /^realm=\$PUBLIC_HOST$/m);
  assert.match(conf, /^external-ip=\$CANDIDATE$/m);
  assert.match(conf, /^min-port=49160$/m);
  assert.match(conf, /^max-port=49200$/m);
  assert.match(conf, /^no-tls$/m);
  assert.match(conf, /^no-dtls$/m);
  // The only placeholders are the three install.sh knows how to replace.
  const placeholders = new Set([...conf.matchAll(/\$([A-Z_]+)/g)].map((match) => match[1]));
  assert.deepEqual([...placeholders].sort(), ['CANDIDATE', 'PUBLIC_HOST', 'TURN_SECRET']);
});

test('install.sh generates turn.runtime.conf, opens TURN ports and prints TURN hints', async () => {
  const install = await read('../../server/install.sh');
  const turn = await read('../../server/turn.conf');
  // The template's three placeholders must each have a sed replacement.
  for (const name of [...new Set([...turn.matchAll(/\$([A-Z_]+)/g)].map((match) => match[1]))]) {
    assert.match(install, new RegExp(`s\\|\\\\\\$${name}\\|`), `install.sh replaces $${name}`);
  }
  assert.match(install, /turn\.runtime\.conf/);
  assert.match(install, /"\$SCRIPT_DIR\/turn\.conf" > "\$SCRIPT_DIR\/turn\.runtime\.conf"/);
  assert.match(install, /grep -qE '\\\$\(TURN_SECRET\|CANDIDATE\|PUBLIC_HOST\)' "\$SCRIPT_DIR\/turn\.runtime\.conf"/);
  // TURN_SECRET is generated/persisted like the other deployment secrets.
  assert.match(install, /TURN_SECRET="\$\(get_env TURN_SECRET\)"/);
  assert.match(install, /TURN_SECRET="\$\(random_secret\)"/);
  assert.match(install, /set_env TURN_SECRET "\$TURN_SECRET"/);
  // Relay firewall rules.
  assert.match(install, /ufw allow 3478\/tcp/);
  assert.match(install, /ufw allow 3478\/udp/);
  assert.match(install, /ufw allow 49160:49200\/udp/);
  // Restart so an existing deployment picks up the new bind-mounted config.
  assert.match(install, /docker compose restart srs coturn/);
  // Operator-facing hints.
  assert.match(install, /TURN 中继/);
  assert.match(install, /\/api\/turn-credentials/);
});

test('compose runs coturn on the host network with the generated runtime config', async () => {
  const compose = await read('../../server/docker-compose.yml');
  const coturn = /coturn:\s*\n([\s\S]*?)\n\n/.exec(compose)?.[1] || '';
  assert.ok(coturn, 'coturn service exists');
  assert.match(coturn, /image: coturn\/coturn/);
  assert.match(coturn, /container_name: conglive-coturn/);
  assert.match(coturn, /network_mode: host/);
  assert.match(coturn, /command: \["-c", "\/etc\/coturn\/turnserver\.conf"\]/);
  assert.match(coturn, /\.\/turn\.runtime\.conf:\/etc\/coturn\/turnserver\.conf:ro/);
  assert.match(coturn, /mem_limit: 128m/);
  assert.doesNotMatch(coturn, /networks: \[conglive\]/);
  // Backend receives the shared secret used to sign short-lived credentials.
  assert.match(compose, /TURN_SECRET: \$\{TURN_SECRET:-\}/);
  assert.match(compose, /TURN_TTL: \$\{TURN_TTL:-3600\}/);
});

test('generated TURN runtime config is gitignored like the SRS runtime config', async () => {
  const gitignore = await read('../../server/.gitignore');
  assert.match(gitignore, /^srs\.runtime\.conf$/m);
  assert.match(gitignore, /^turn\.runtime\.conf$/m);
});

test('docker compose config accepts the coturn service when docker is available', async (t) => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    t.skip('docker compose is not available in this environment');
    return;
  }
  execFileSync('docker', ['compose', 'config', '-q'], {
    cwd: serverDir,
    timeout: 30000,
    stdio: 'pipe',
    env: {
      ...process.env,
      // Values normally written to server/.env by install.sh.
      MYSQL_ROOT_PASSWORD: 'test-root-password',
      MYSQL_PASSWORD: 'test-db-password',
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
      PUBLIC_HOST: 'xinglan.work',
      SRS_HOOK_SECRET: 'test-hook-secret',
      TURN_SECRET: 'test-turn-secret',
      ADMIN_PASSWORD: 'test-admin-password',
      CANDIDATE: '203.0.113.10',
    },
  });
});
