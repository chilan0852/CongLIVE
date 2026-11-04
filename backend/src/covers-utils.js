/**
 * Stream cover helpers.
 *
 * Covers arrive as base64 data URIs (`data:image/(jpeg|png|webp);base64,...`)
 * and are stored as plain files under COVERS_DIR. Everything here is a pure
 * Node built-in helper so the upload rules can be tested without a database or
 * a running Express server.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export const MAX_COVER_BYTES = 2 * 1024 * 1024;
export const COVER_PUBLIC_PREFIX = '/covers/';
export const COVER_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

const DATA_URI_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Error type carrying the HTTP status the route should return. */
export class CoverValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CoverValidationError';
    this.status = status;
  }
}

/** Detect the real image format from the file signature, ignoring the claim. */
export function detectCoverImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'image/webp';
  return null;
}

/**
 * Validate a cover data URI. Returns the decoded buffer plus its verified MIME
 * type and file extension. Throws CoverValidationError with a 400 (invalid) or
 * 413 (decoded payload above the 2MB limit) status.
 */
export function parseCoverImageData(imageData) {
  if (typeof imageData !== 'string' || !imageData.trim()) {
    throw new CoverValidationError('请提供封面图片数据');
  }
  const match = DATA_URI_PATTERN.exec(imageData.trim());
  if (!match) {
    throw new CoverValidationError('图片格式无效，仅支持 JPEG/PNG/WebP 的 base64 data URI');
  }
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  // Reject before decoding when the encoded text alone cannot fit the limit.
  if (base64.length > Math.ceil(MAX_COVER_BYTES / 3) * 4 + 8) {
    throw new CoverValidationError('封面图片不能超过 2MB', 413);
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new CoverValidationError('图片数据为空或 base64 编码无效');
  if (buffer.length > MAX_COVER_BYTES) {
    throw new CoverValidationError('封面图片不能超过 2MB', 413);
  }
  const detected = detectCoverImageMime(buffer);
  if (!detected) {
    throw new CoverValidationError('无法识别的图片，仅支持 JPEG/PNG/WebP');
  }
  if (detected !== mime) {
    throw new CoverValidationError('图片内容与声明的格式不一致');
  }
  return { buffer, mime, extension: COVER_MIME_EXTENSIONS[mime] };
}

/** Build a safe, collision-resistant filename for a stream cover. */
export function createCoverFilename(streamId, extension) {
  const safeExtension = String(extension || '');
  if (!Object.values(COVER_MIME_EXTENSIONS).includes(safeExtension)) {
    throw new CoverValidationError('图片格式无效');
  }
  const numericId = String(streamId ?? '').replace(/[^0-9]/g, '').slice(0, 24) || '0';
  return `s${numericId}-${crypto.randomBytes(16).toString('hex')}.${safeExtension}`;
}

/**
 * Validate and persist a cover under `coversDir`. The filename never contains
 * user input, so the write always stays inside the covers directory.
 */
export async function saveCoverImage(coversDir, streamId, imageData) {
  const { buffer, mime, extension } = parseCoverImageData(imageData);
  const filename = createCoverFilename(streamId, extension);
  const directory = path.resolve(String(coversDir));
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  // flag wx: a filename collision (practically impossible) is an error rather
  // than silently overwriting another stream's cover.
  await writeFile(filePath, buffer, { flag: 'wx', mode: 0o644 });
  return { filename, filePath, coverUrl: `${COVER_PUBLIC_PREFIX}${filename}`, size: buffer.length, mime };
}

/** Extract a managed cover filename from a stored cover_url, or null. */
export function coverFilenameFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(COVER_PUBLIC_PREFIX)) return null;
  const filename = url.slice(COVER_PUBLIC_PREFIX.length);
  if (!filename || filename.length > 160 || !SAFE_FILENAME_PATTERN.test(filename)) return null;
  return filename;
}
