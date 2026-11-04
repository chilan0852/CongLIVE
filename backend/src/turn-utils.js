import crypto from 'node:crypto';

/**
 * coturn short-term (REST API) credentials.
 *
 * coturn is configured with `use-auth-secret` + `static-auth-secret=...`; a
 * client then authenticates with a username of `<expiry>:<suffix>` and the
 * base64 HMAC-SHA1 of that username keyed with the shared secret. The
 * credential expires on its own, so the API only has to hand out short-lived
 * values and never stores TURN passwords.
 *
 * @see https://github.com/coturn/coturn/wiki/turnserver - use-auth-secret
 */

export const DEFAULT_TURN_TTL = 3600;
export const DEFAULT_TURN_PORT = 3478;
/** Application name embedded in the coturn REST username, e.g. `1700003600:conglive`. */
export const TURN_USERNAME_SUFFIX = 'conglive';
export const MIN_TURN_TTL = 60;
export const MAX_TURN_TTL = 86400;

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):/i;
const HOST_WITH_PORT = /^\[[^\]]+\]:\d+$|^[^:]+:\d+$/;

const toNumber = (value, fallback) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};

export function clampTurnTtl(value, fallback = DEFAULT_TURN_TTL) {
  const parsed = toNumber(value, NaN);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_TURN_TTL, Math.max(MIN_TURN_TTL, Math.trunc(parsed)));
}

/**
 * Keep only ICE URLs the browser can understand, from either a comma-separated
 * env value or an array. Duplicates are removed.
 */
export function normalizeTurnUrls(raw) {
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const urls = [];
  for (const value of values) {
    const url = String(value ?? '').trim();
    if (!url || !ICE_URL_PATTERN.test(url) || urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

/** Accept `xinglan.work`, `https://xinglan.work/`, `[2001:db8::1]`, … */
export function normalizeTurnHost(raw) {
  let host = String(raw ?? '').trim();
  host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return '';
  // A bare IPv6 address must be bracketed inside a URI.
  if (host.includes(':') && !HOST_WITH_PORT.test(host)) return `[${host}]`;
  return host;
}

/**
 * TURN/STUN URLs clients should use.
 *
 * `TURN_URLS` (comma separated) always wins; otherwise the three canonical
 * entries are derived from the public host so the same value is used for the
 * UDP relay, the TCP fallback and STUN.
 */
export function buildTurnUrls({ urls, host, port = DEFAULT_TURN_PORT } = {}) {
  const configured = normalizeTurnUrls(urls);
  if (configured.length) return configured;
  const hostname = normalizeTurnHost(host);
  if (!hostname) return [];
  const parsedPort = Math.trunc(toNumber(port, DEFAULT_TURN_PORT));
  const portValue = parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_TURN_PORT;
  // A host that already carries a port (e.g. PUBLIC_HOST=example.com:3478) is
  // used verbatim instead of producing host:port:port.
  const base = HOST_WITH_PORT.test(hostname) ? hostname : `${hostname}:${portValue}`;
  return [
    `turn:${base}?transport=udp`,
    `turn:${base}?transport=tcp`,
    `stun:${base}`,
  ];
}

/** Build a short-lived coturn REST credential pair. */
export function computeTurnCredential({
  secret,
  ttl = DEFAULT_TURN_TTL,
  now = Date.now,
  usernameSuffix = TURN_USERNAME_SUFFIX,
} = {}) {
  const key = String(secret ?? '');
  if (!key.trim()) throw new TypeError('TURN secret is required to compute credentials');
  const ttlSeconds = clampTurnTtl(ttl);
  const nowMs = typeof now === 'function' ? Number(now()) : Number(now);
  const expiresAt = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000) + ttlSeconds;
  const username = `${expiresAt}:${usernameSuffix}`;
  const credential = crypto.createHmac('sha1', key).update(username).digest('base64');
  return { username, credential, ttl: ttlSeconds, expiresAt };
}

/**
 * Resolve the TURN configuration from the environment. `TURN_SECRET` being
 * empty means TURN is not deployed and the API must return 503 so clients fall
 * back to STUN.
 */
export function turnSettingsFromEnv(env = process.env) {
  const secret = String(env.TURN_SECRET ?? '').trim();
  const urls = buildTurnUrls({
    urls: env.TURN_URLS,
    host: env.TURN_HOST || env.TURN_DOMAIN || env.PUBLIC_HOST || '127.0.0.1',
    port: env.TURN_PORT || DEFAULT_TURN_PORT,
  });
  return { secret, urls, ttl: clampTurnTtl(env.TURN_TTL) };
}
