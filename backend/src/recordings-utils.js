/**
 * Resolve the public recording endpoint from the same public origin that served
 * the API request. This avoids handing Android clients a playback URL on a
 * different port (for example :8081) when they configured the API directly on
 * :3000. Host names are checked against PUBLIC_HOST before being reflected.
 */
export function recordingApiBaseForRequest(req, {
  publicHost,
  fallbackBase,
  fallbackScheme = 'http',
  fallbackPort = '8081',
} = {}) {
  const configuredHost = String(publicHost || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const fallbackHost = publicHost
    ? (String(publicHost).includes(':') && !String(publicHost).startsWith('[') ? `[${publicHost}]` : String(publicHost))
    : '127.0.0.1';
  const fallback = fallbackBase || `${fallbackScheme}://${fallbackHost}${fallbackPort ? `:${fallbackPort}` : ''}/api/recordings`;

  const firstHeader = (value) => String(value || '').split(',')[0].trim();
  const hostHeader = firstHeader(req?.headers?.['x-forwarded-host'] || req?.headers?.host);
  const forwardedProto = firstHeader(req?.headers?.['x-forwarded-proto']).toLowerCase();
  const requestProto = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : (req?.protocol === 'https' ? 'https' : 'http');
  if (!hostHeader || !configuredHost) return fallback;

  try {
    const url = new URL(`${requestProto}://${hostHeader}`);
    if (url.username || url.password || url.hostname.toLowerCase().replace(/^\[|\]$/g, '') !== configuredHost) return fallback;
    return `${url.origin}/api/recordings`;
  } catch {
    return fallback;
  }
}

export function recordingBelongsToStreams(relativePath, streamKeys) {
  const filename = String(relativePath || '').split('/').pop() || '';
  return (Array.isArray(streamKeys) ? streamKeys : []).some((key) => {
    const value = String(key || '');
    return value.length > 0 && (filename.startsWith(`${value}.`) || filename === value);
  });
}
