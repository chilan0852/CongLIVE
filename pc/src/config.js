'use strict';

/**
 * Server-address handling shared by the Electron main process, the launcher UI
 * (through IPC) and the unit tests.
 *
 * The PC client loads an existing CongLive web deployment, so the only thing the
 * user configures is the base address: a domain name, an IP (optionally with a
 * port) or a full http(s) URL. Everything is normalised to a canonical URL
 * before being saved to `config.json` in Electron's userData directory.
 */

/** Default production deployment. */
const DEFAULT_SERVER = 'https://xinglan.work';

/** Maximum accepted length for a server address, in characters. */
const MAX_URL_LENGTH = 2048;

/** Private/loopback hosts usually run plain HTTP during local testing. */
const LOCAL_HOST_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:[/?#]|$)/i;

/** Error codes are translated by the launcher UI; keep them stable. */
const NORMALIZE_ERRORS = {
  EMPTY: 'empty',
  LENGTH: 'length',
  INVALID: 'invalid',
  PROTOCOL: 'protocol',
  HOST: 'host',
  CREDENTIALS: 'credentials',
};

function fail(error) {
  return { ok: false, url: '', error };
}

/**
 * Normalise a user-entered server address.
 *
 * Rules:
 *  - empty input is rejected (`empty`);
 *  - missing scheme defaults to https, except localhost / private IPs / 0.0.0.0
 *    which default to http (common LAN test setups);
 *  - only http(s) is accepted;
 *  - credentials (user:pass@) are rejected;
 *  - query strings and hashes are dropped;
 *  - a trailing slash is removed; the root URL becomes the origin.
 *
 * @param {string} input
 * @param {{ allowHttpFallback?: boolean }} [options]
 * @returns {{ ok: true, url: string } | { ok: false, url: '', error: string }}
 */
function normalizeServerUrl(input, options = {}) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return fail(NORMALIZE_ERRORS.EMPTY);
  if (raw.length > MAX_URL_LENGTH) return fail(NORMALIZE_ERRORS.LENGTH);

  // Protocol-relative input ("//host") inherits https.
  if (raw.startsWith('//')) raw = `https:${raw}`;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme) {
    const scheme = options.allowHttpFallback === false
      ? 'https'
      : LOCAL_HOST_PATTERN.test(raw) ? 'http' : 'https';
    raw = `${scheme}://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(NORMALIZE_ERRORS.INVALID);
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return fail(NORMALIZE_ERRORS.PROTOCOL);
  if (!url.hostname) return fail(NORMALIZE_ERRORS.HOST);
  if (url.username || url.password) return fail(NORMALIZE_ERRORS.CREDENTIALS);

  url.search = '';
  url.hash = '';
  const cleanPath = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!cleanPath) return { ok: true, url: url.origin };
  return { ok: true, url: `${url.origin}${cleanPath}` };
}

/** Canonicalise any stored value; invalid values fall back to the default. */
function normalizeServerOrDefault(input) {
  const result = normalizeServerUrl(input);
  return result.ok ? result.url : DEFAULT_SERVER;
}

/** 1-based config file path inside Electron's userData directory. */
function configFilePath(userDataDir) {
  return require('node:path').join(userDataDir, 'config.json');
}

/** Read `config.json`; never throws (missing/corrupt files yield defaults). */
function loadConfig(userDataDir) {
  const file = configFilePath(userDataDir);
  const fallback = { serverUrl: '', windowBounds: null, maximized: false, updatedAt: '' };
  try {
    const data = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return fallback;
    const normalized = normalizeServerUrl(data.serverUrl);
    const bounds = data.windowBounds && typeof data.windowBounds === 'object'
      ? {
        x: Number.isFinite(Number(data.windowBounds.x)) ? Number(data.windowBounds.x) : undefined,
        y: Number.isFinite(Number(data.windowBounds.y)) ? Number(data.windowBounds.y) : undefined,
        width: Number.isFinite(Number(data.windowBounds.width)) ? Number(data.windowBounds.width) : undefined,
        height: Number.isFinite(Number(data.windowBounds.height)) ? Number(data.windowBounds.height) : undefined,
      }
      : null;
    return {
      serverUrl: normalized.ok ? normalized.url : '',
      windowBounds: bounds,
      maximized: data.maximized === true,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    };
  } catch {
    return fallback;
  }
}

/** Atomically persist `config.json` (tmp file + rename). */
function saveConfig(userDataDir, config) {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = configFilePath(userDataDir);
  const normalized = normalizeServerUrl(config && config.serverUrl);
  const payload = {
    serverUrl: normalized.ok ? normalized.url : '',
    windowBounds: config && config.windowBounds ? config.windowBounds : null,
    maximized: Boolean(config && config.maximized),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  const tmp = path.join(userDataDir, `config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

module.exports = {
  DEFAULT_SERVER,
  MAX_URL_LENGTH,
  NORMALIZE_ERRORS,
  normalizeServerUrl,
  normalizeServerOrDefault,
  configFilePath,
  loadConfig,
  saveConfig,
};
