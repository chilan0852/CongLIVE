/**
 * Canvas compositor for browser publishing.
 *
 * Draws the camera/screen frame plus the Live2D model canvas into a 2D canvas
 * and exposes it as a `captureStream()` video track, so the existing WHIP
 * publisher can swap only the video track (audio is kept untouched).
 */
import { LocalizedError, msg } from './i18n';
import { renderLive2DToCanvas } from './live2d';

export type OverlayHandle = {
  stream: MediaStream;
  canvas: HTMLCanvasElement;
  /** Stop the animation loop and release every captured track. */
  stop: () => void;
};

export type OverlayOptions = {
  /** Fallback width when the source video has no metadata yet. */
  width: number;
  /** Fallback height when the source video has no metadata yet. */
  height: number;
  fps: number;
  /** Model height as a fraction of the output height (default 0.55). */
  modelScale?: number;
};

function evenSize(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * Start compositing `source` + the current Live2D canvas into a new
 * MediaStream. When no model is loaded the source video is still drawn, so the
 * published picture is identical to the raw camera.
 */
export function createOverlayStream(
  source: HTMLVideoElement,
  options: OverlayOptions,
): OverlayHandle {
  const width = evenSize(source.videoWidth || options.width);
  const height = evenSize(source.videoHeight || options.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new LocalizedError(msg('overlay.canvasUnavailable'));
  const fps = Math.min(60, Math.max(1, Math.round(options.fps) || 30));
  const modelScale = options.modelScale ?? 0.55;

  let stopped = false;
  let frameHandle = 0;
  let lastDraw = 0;
  const frameInterval = 1000 / fps;

  const drawFrame = (now: number) => {
    if (stopped) return;
    frameHandle = window.requestAnimationFrame(drawFrame);
    if (now - lastDraw < frameInterval) return;
    lastDraw = now;
    // Always paint the source first so a missing/broken model shows the camera.
    if (source.readyState >= 2 && source.videoWidth > 0) {
      try {
        context.drawImage(source, 0, 0, width, height);
      } catch {
        // A frame can be unavailable right after a track ends; keep the loop alive.
      }
    } else {
      context.fillStyle = '#05070d';
      context.fillRect(0, 0, width, height);
    }
    // Render the model right before drawImage() so its WebGL buffer is fresh.
    const model = renderLive2DToCanvas();
    if (!model || !model.width || !model.height) return;
    const targetHeight = Math.round(height * modelScale);
    const targetWidth = Math.round((targetHeight * model.width) / model.height);
    const x = width - targetWidth - Math.round(width * 0.02);
    const y = height - targetHeight;
    try {
      context.drawImage(model, x, y, targetWidth, targetHeight);
    } catch {
      // Model canvas might be detached mid-frame; the camera frame is still valid.
    }
  };

  frameHandle = window.requestAnimationFrame(drawFrame);

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(fps);
  } catch (error) {
    window.cancelAnimationFrame(frameHandle);
    stopped = true;
    throw error instanceof LocalizedError ? error : new LocalizedError(msg('overlay.captureUnsupported'));
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(frameHandle);
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* already stopped */ }
    }
  };

  return { stream, canvas, stop };
}
