/**
 * CongLive web API client: typed helpers for the public endpoints the browser app
 * consumes, plus the shared stream/room types used by both the lobby and the room page.
 *
 * The backend runs in parallel with this client, so every reader is defensive:
 *   - `viewers` is optional (older backends do not count viewers yet);
 *   - `GET /api/capacity` being unavailable must not break the publish card;
 *   - `GET /api/streams/:id` returning an HTML 404 means the route is not deployed yet,
 *     which the caller may fall back from instead of treating the room as deleted.
 */
import type { CSSProperties } from 'react';
import { resolveAssetUrl } from './cover';
import { t, type TextMessage } from './i18n';

/** API origin override; empty means same origin (nginx proxies /api and /ws to the backend). */
export const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export type RtcTone = 'idle' | 'info' | 'ok' | 'warn' | 'error';
export type RtcStatus = { text: TextMessage; tone: RtcTone };

/** One live stream as returned by `GET /api/streams`. */
export type LiveStream = {
  id: number;
  title: string;
  username: string;
  is_live: boolean;
  whepPath: string;
  transport: 'WebRTC';
  coverUrl?: string | null;
  viewers?: number | null;
};

/** `GET /api/streams/:id` detail; a live stream plus its current viewer count. */
export type RoomDetail = LiveStream & {
  viewers?: number | null;
};

export type ChatMessage = {
  id: number;
  username: string;
  content: string;
  createdAt: string;
};

/** `GET /api/capacity`: what the server can currently encode. */
export type CapacityInfo = {
  cpuCores: number | null;
  memoryFreeMb: number | null;
  memoryTotalMb: number | null;
  activeRooms: number | null;
  allow1080p: boolean | null;
  /** Only an explicit `false` must disable 1080p/60fps, so unknown stays `null`. */
  allow1080p60: boolean | null;
  reason: string | null;
  recommended: { width: number | null; height: number | null; fps: number | null; bitrate: number | null } | null;
};

/** Absolute cover URL for `<img>`; empty string when the stream has no cover. */
export function streamCoverUrl(stream: { coverUrl?: string | null }): string {
  return resolveAssetUrl(API, stream.coverUrl || '');
}

/** Deterministic gradient for streams without a cover (title fallback). */
export function coverFallbackStyle(stream: { id: number }): CSSProperties {
  const hue = (Number(stream.id) * 47) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 68% 40%), hsl(${(hue + 58) % 360} 72% 26%))`,
  };
}

/** First visible character of the title, used inside the gradient fallback. */
export function titleInitial(title: string): string {
  const trimmed = String(title || '').trim();
  return trimmed ? Array.from(trimmed)[0] : t('brand.mark');
}

export function coverFallbackChar(stream: { title: string }): string {
  return titleInitial(stream.title);
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function normalizeStream(raw: any): LiveStream | null {
  const id = finiteOrNull(raw?.id);
  if (id === null || !Number.isSafeInteger(id) || id < 1) return null;
  return {
    id,
    title: String(raw?.title ?? ''),
    username: String(raw?.username ?? ''),
    is_live: booleanOrNull(raw?.is_live) === true,
    whepPath: typeof raw?.whepPath === 'string' && raw.whepPath ? raw.whepPath : `/api/streams/${id}/whep`,
    transport: 'WebRTC',
    coverUrl: typeof raw?.coverUrl === 'string' && raw.coverUrl ? raw.coverUrl : null,
    viewers: finiteOrNull(raw?.viewers),
  };
}

/** List every live room; returns [] on any failure (the caller shows a notice). */
export async function fetchStreams(signal?: AbortSignal): Promise<LiveStream[]> {
  const response = await fetch(`${API}/api/streams`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) return [];
  return data
    .filter((stream: any) => stream?.is_live === true && !!stream?.whepPath)
    .map(normalizeStream)
    .filter((stream: LiveStream | null): stream is LiveStream => stream !== null);
}

export type RoomDetailResult =
  | { status: 'ok'; stream: RoomDetail }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * Fetch one room. `not-found` means the backend explicitly said the room does not
 * exist (JSON 404); an HTML 404 means the detail route is not deployed yet and is
 * reported as `unavailable` so the lobby data can be used instead.
 */
export async function fetchRoomDetail(id: number, signal?: AbortSignal): Promise<RoomDetailResult> {
  let response: Response;
  try {
    response = await fetch(`${API}/api/streams/${id}`, { cache: 'no-store', signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return { status: 'unavailable' };
  }
  if (response.status === 404) {
    const contentType = response.headers.get('content-type') || '';
    // Express' default 404 page is HTML; a JSON error means the API handled it.
    return { status: contentType.includes('application/json') ? 'not-found' : 'unavailable' };
  }
  if (!response.ok) return { status: 'unavailable' };
  const data = await response.json().catch(() => null);
  const stream = normalizeStream(data);
  if (!stream) return { status: 'unavailable' };
  return { status: 'ok', stream };
}

/** Read the server capacity; null when unavailable (callers must keep working). */
export async function fetchCapacity(signal?: AbortSignal): Promise<CapacityInfo | null> {
  try {
    const response = await fetch(`${API}/api/capacity`, { cache: 'no-store', signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    const recommended = data.recommended && typeof data.recommended === 'object'
      ? {
        width: finiteOrNull(data.recommended.w ?? data.recommended.width),
        height: finiteOrNull(data.recommended.h ?? data.recommended.height),
        fps: finiteOrNull(data.recommended.fps),
        bitrate: finiteOrNull(data.recommended.bitrate),
      }
      : null;
    return {
      cpuCores: finiteOrNull(data.cpuCores),
      memoryFreeMb: finiteOrNull(data.memoryFreeMb),
      memoryTotalMb: finiteOrNull(data.memoryTotalMb),
      activeRooms: finiteOrNull(data.activeRooms),
      allow1080p: booleanOrNull(data.allow1080p),
      allow1080p60: booleanOrNull(data.allow1080p60),
      reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : null,
      recommended,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

/**
 * STUN-only fallback used when `GET /api/turn-credentials` is unavailable
 * (no TURN_SECRET configured → 503, session expired → 401, network error…).
 * Kept as a module constant so every VoiceClient/PeerConnection reuses the
 * same array instead of rebuilding configs on each render.
 */
export const STUN_FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** A short-lived TURN credential set from `GET /api/turn-credentials`. */
export type TurnCredentials = {
  /** turn:/turns:/stun: URLs (UDP/TCP relay + STUN from the same server). */
  urls: string[];
  /** `<expiry>:conglive` (coturn `use-auth-secret` style REST username). */
  username: string;
  /** base64 HMAC-SHA1 of the username with TURN_SECRET. */
  credential: string;
  /** Validity in seconds when the server reports it. */
  ttl: number | null;
  /** Ready to pass to `new RTCPeerConnection({ iceServers })`. */
  iceServers: RTCIceServer[];
};

export type TurnCredentialsResult =
  | { status: 'ok'; credentials: TurnCredentials }
  | { status: 'unavailable'; code: number | null };

const ICE_SERVER_URL = /^(stun|stuns|turn|turns):/i;

/** Accept a string or string[] from the backend and keep only ICE schemes. */
function normalizeIceUrls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const urls: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const url = item.trim();
    if (url && ICE_SERVER_URL.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Fetch short-lived TURN credentials for the mesh voice room.
 *
 * Requires the signed-in user's token (the route is authenticated). Every
 * failure is reported as `unavailable` with the HTTP status when there is one,
 * so the caller can fall back to STUN and show the "relay unavailable → direct"
 * state without breaking the voice room.
 */
export async function fetchTurnCredentials(
  token: string,
  signal?: AbortSignal,
): Promise<TurnCredentialsResult> {
  if (!token) return { status: 'unavailable', code: 401 };
  let response: Response;
  try {
    response = await fetch(`${API}/api/turn-credentials`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return { status: 'unavailable', code: null };
  }
  if (!response.ok) return { status: 'unavailable', code: response.status };
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') return { status: 'unavailable', code: null };
  const urls = normalizeIceUrls(data.urls);
  if (!urls.length) return { status: 'unavailable', code: null };
  const username = typeof data.username === 'string' ? data.username.trim() : '';
  const credential = typeof data.credential === 'string' ? data.credential.trim() : '';
  const iceServers: RTCIceServer[] = [{ urls }];
  if (username && credential) {
    iceServers[0].username = username;
    iceServers[0].credential = credential;
  }
  return {
    status: 'ok',
    credentials: {
      urls,
      username,
      credential,
      ttl: finiteOrNull(data.ttl),
      iceServers,
    },
  };
}

/** Build a local WebSocket URL for the chat channel (same origin or the API origin). */
export function chatSocketUrl(): string {
  if (API) return `${API.replace(/^http/, 'ws')}/ws/chat`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`;
}
