/** Stream cover helpers: client-side compression + upload to the backend API. */
import { LocalizedError, backendText, msg } from './i18n';

/** The backend rejects any decoded cover bigger than 2MB. */
export const MAX_COVER_BYTES = 2 * 1024 * 1024;
/**
 * Keep the final data URI under 2MB as required by the product spec, with a
 * little headroom for the JSON envelope (and for nginx `client_max_body_size`).
 */
export const MAX_COVER_DATA_URL_LENGTH = MAX_COVER_BYTES;
const TARGET_DATA_URL_LENGTH = MAX_COVER_DATA_URL_LENGTH - 64 * 1024;
const ACCEPTED_MIME = /^image\//i;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export type PreparedCover = {
  /** `data:image/jpeg;base64,...` — exactly what POST /cover expects. */
  dataUrl: string;
  /** Decoded byte size of the image payload. */
  bytes: number;
  width: number;
  height: number;
};

function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  return Math.max(0, Math.floor((base64.length * 3) / 4));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function describeCoverSize(cover: PreparedCover): string {
  return `${cover.width}×${cover.height} · ${formatBytes(cover.bytes)}`;
}

async function decodeImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> decoder (older Safari formats, etc.).
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new LocalizedError(msg('cover.decodeFailed')));
      image.src = objectUrl;
    });
  } finally {
    // The bitmap data is already copied into the image element by onload.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  }
}

/**
 * Read an image file and shrink it into a JPEG data URI that is guaranteed to
 * stay below 2MB (the encoded data URI length is checked, not just the file).
 */
export async function prepareCover(file: File): Promise<PreparedCover> {
  if (!file) throw new LocalizedError(msg('cover.pick'));
  if (file.type && !ACCEPTED_MIME.test(file.type)) {
    throw new LocalizedError(msg('cover.badType'));
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new LocalizedError(msg('cover.tooLarge'));
  }
  const bitmap = await decodeImage(file);
  const sourceWidth = 'width' in bitmap ? bitmap.width : 0;
  const sourceHeight = 'height' in bitmap ? bitmap.height : 0;
  if (!sourceWidth || !sourceHeight) {
    throw new LocalizedError(msg('cover.badSize'));
  }

  let maxSide = 1600;
  let quality = 0.86;
  let last: PreparedCover | null = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new LocalizedError(msg('cover.canvasUnavailable'));
    // JPEG has no alpha channel: paint the dark app background first.
    context.fillStyle = '#0b1122';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = decodedBytes(dataUrl);
    last = { dataUrl, bytes, width, height };
    if (dataUrl.startsWith('data:image/jpeg;base64,') && dataUrl.length <= TARGET_DATA_URL_LENGTH && bytes <= MAX_COVER_BYTES) {
      break;
    }
    if (quality > 0.5) {
      quality = Math.max(0.5, quality - 0.1);
    } else {
      maxSide = Math.round(maxSide * 0.8);
    }
    last = null;
  }
  if ('close' in bitmap && typeof bitmap.close === 'function') {
    try { bitmap.close(); } catch { /* already closed */ }
  }
  if (!last) {
    throw new LocalizedError(msg('cover.compressFailed'));
  }
  return last;
}

/** Resolve a backend-relative asset path (`/covers/x.jpg`) against the API base. */
export function resolveAssetUrl(apiBase: string, url: string): string {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  const base = apiBase.replace(/\/$/, '');
  return `${base}${value.startsWith('/') ? value : `/${value}`}`;
}

/** Upload a prepared cover for the given stream; returns the public cover URL. */
export async function uploadCover(
  apiBase: string,
  token: string,
  streamId: number,
  imageData: string,
): Promise<string> {
  const response = await fetch(`${apiBase}/api/streams/${streamId}/cover`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imageData }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new LocalizedError(msg('cover.uploadFailed', {
      status: response.status,
      detail: backendText(String(data?.error || ''), response.status),
    }));
  }
  const coverUrl = data?.coverUrl || data?.cover_url;
  if (typeof coverUrl !== 'string' || !coverUrl) {
    throw new LocalizedError(msg('cover.missingUrl'));
  }
  return coverUrl;
}
