/**
 * Shared browser-media helpers used by the lobby publish card and the
 * `/studio` workbench: capture presets, readable error messages, codec
 * preference and the single-shot ICE gathering helper used by WHIP/WHEP.
 *
 * Keeping these out of `main.tsx` means the studio and the lobby card publish
 * through the same primitives instead of forking the media code.
 */
import { LocalizedError, backendText, msg, rawText, t, type I18nKey, type TextMessage } from './i18n';

export type PublishSource = 'camera' | 'screen';

/** One selectable publish resolution; `labelKey` is translated at render time. */
export const PUBLISH_RESOLUTIONS = [
  { key: '1080p', width: 1920, height: 1080, labelKey: 'publish.res1080p' },
  { key: '720p', width: 1280, height: 720, labelKey: 'publish.res720p' },
  { key: '540p', width: 960, height: 540, labelKey: 'publish.res540p' },
  { key: '360p', width: 640, height: 360, labelKey: 'publish.res360p' },
] as const;

export type PublishResolutionKey = (typeof PUBLISH_RESOLUTIONS)[number]['key'];
export type PublishResolution = (typeof PUBLISH_RESOLUTIONS)[number];

export const PUBLISH_FPS = [60, 30, 24, 15] as const;

/** DOMException names raised by getUserMedia/getDisplayMedia. */
export const PUBLISH_MEDIA_ERRORS = [
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'OverconstrainedError',
  'NotSupportedError',
  'SecurityError',
];

export type VideoElementWithFrames = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Wait until ICE gathering completes so the offer posted to WHIP/WHEP already
 * contains the client candidates (SRS needs them to answer within one request).
 * Resolves early with 'timeout' when gathering stalls and 'aborted' when the
 * caller tears the session down, so a stale offer is never posted.
 */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  signal?: AbortSignal,
  timeoutMs = 12000,
): Promise<'complete' | 'timeout' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (pc.iceGatheringState === 'complete') return Promise.resolve('complete');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: 'complete' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', check);
      signal?.removeEventListener('abort', onAbort);
      window.clearTimeout(timer);
      resolve(reason);
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish('complete');
    };
    const onAbort = () => finish('aborted');
    const timer = window.setTimeout(() => finish('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** An SDP answer must start with the version line and contain at least one media section. */
export function looksLikeSdp(text: string): boolean {
  const value = text.trim();
  return value.startsWith('v=0') && /^m=/m.test(value);
}

/** Extract a short JSON/plain-text error detail from a non-2xx media response. */
export function mediaErrorDetail(body: string): string {
  let detail = '';
  try {
    const data = JSON.parse(body);
    if (typeof data?.error === 'string') detail = data.error;
    else if (typeof data?.detail === 'string') detail = data.detail;
  } catch {
    // Not JSON: nginx/gateway HTML or plain text, trimmed below.
  }
  if (!detail && body.trim() && !body.trim().startsWith('v=')) {
    detail = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return detail;
}

const WHEP_HINT_KEYS: Record<number, I18nKey> = {
  400: 'whep.hint.400',
  401: 'whep.hint.401',
  403: 'whep.hint.403',
  404: 'whep.hint.404',
  409: 'whep.hint.409',
  429: 'whep.hint.429',
  502: 'whep.hint.502',
  504: 'whep.hint.504',
};

/** Turn a non-2xx WHEP response into a short, human readable status message. */
export function describeWhepFailure(status: number, body: string): LocalizedError {
  const detail = mediaErrorDetail(body);
  return new LocalizedError(msg('whep.fail', {
    status,
    detail: detail ? backendText(detail, status) : msg(WHEP_HINT_KEYS[status] ?? 'whep.hint.generic'),
  }));
}

const WHIP_HINT_KEYS: Record<number, I18nKey> = {
  400: 'whip.hint.400',
  401: 'whip.hint.401',
  403: 'whip.hint.403',
  404: 'whip.hint.404',
  409: 'whip.hint.409',
  429: 'whip.hint.429',
  502: 'whip.hint.502',
  504: 'whip.hint.504',
};

/** Turn a non-2xx WHIP response into a short, human readable publish error. */
export function describeWhipFailure(status: number, body: string): LocalizedError {
  const detail = mediaErrorDetail(body);
  return new LocalizedError(msg('whip.fail', {
    status,
    detail: detail ? backendText(detail, status) : msg(WHIP_HINT_KEYS[status] ?? 'whip.hint.generic'),
  }));
}

/** User-visible label for the selected publish source. */
export function sourceText(source: PublishSource): TextMessage {
  return msg(source === 'screen' ? 'msg.sourceScreenShare' : 'msg.sourceCameraMic');
}

/** Short localized label for the publish source (status chips). */
export function sourceShortText(source: PublishSource): string {
  return t(source === 'screen' ? 'publish.sourceScreen' : 'publish.sourceCamera');
}

/** Resolved human label for a preset (e.g. "720p（1280×720）"). */
export function resolutionLabel(resolution: Pick<PublishResolution, 'labelKey'>): string {
  return t(resolution.labelKey);
}

/** Explain getUserMedia/getDisplayMedia failures instead of leaking DOMException names. */
export function describeMediaFailure(error: any, source: PublishSource): TextMessage {
  const name = String(error?.name || '');
  const detail: TextMessage = error?.message ? rawText(String(error.message)) : msg('common.unknownError');
  if (source === 'screen') {
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return msg('media.screenCancelled');
      case 'NotSupportedError':
        return msg('media.screenUnsupported');
      default:
        return msg('media.screenFailed', { detail });
    }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return msg('media.permissionDenied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return msg('media.deviceNotFound');
    case 'NotReadableError':
      return msg('media.deviceBusy');
    case 'NotSupportedError':
      return msg('media.captureUnsupported');
    default:
      return msg('media.captureFailed', { detail });
  }
}

/** Stop every track in a local capture stream; safe to call more than once. */
export function stopCaptureTracks(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* track already stopped */ }
  }
}

/**
 * Ask the browser to prefer H.264 for outgoing video. SRS forwards the
 * publisher's H.264 to WHEP viewers, so keeping it first avoids a codec
 * mismatch on older SRS boxes. Browsers without the API keep their defaults.
 */
export function preferH264(pc: RTCPeerConnection): void {
  const capabilities = typeof RTCRtpSender.getCapabilities === 'function'
    ? RTCRtpSender.getCapabilities('video')
    : null;
  if (!capabilities?.codecs.length) return;
  const h264 = capabilities.codecs.filter((codec) => /^video\/h264$/i.test(codec.mimeType));
  if (!h264.length) return;
  const ordered = [...h264, ...capabilities.codecs.filter((codec) => !h264.includes(codec))];
  for (const transceiver of pc.getTransceivers()) {
    const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind;
    if (kind !== 'video') continue;
    try { transceiver.setCodecPreferences(ordered); } catch { /* keep browser defaults */ }
  }
}
