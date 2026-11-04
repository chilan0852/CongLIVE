/**
 * Browser WHIP publisher used by both the lobby publish card and `/studio`.
 *
 * One session = create the backend stream record → upload the optional cover →
 * capture camera/screen + microphone → optionally composite the Live2D mascot →
 * negotiate a single-shot ICE offer against the WHIP endpoint → keep publishing
 * until the caller stops it (or the source track ends).
 *
 * The class owns every resource (MediaStream tracks, hidden overlay <video>,
 * canvas capture stream, RTCPeerConnection, AbortController) and releases all
 * of them from `stop()`. UI code only renders the status callbacks, so the
 * lobby and the workbench share the exact same negotiation path.
 */
import { API, type RtcStatus, type RtcTone } from './api';
import { resolveAssetUrl, uploadCover, type PreparedCover } from './cover';
import { LocalizedError, backendText, errorMessage, msg, type TextMessage } from './i18n';
import { getLive2DCanvas } from './live2d';
import {
  PUBLISH_MEDIA_ERRORS,
  describeMediaFailure,
  describeWhipFailure,
  looksLikeSdp,
  preferH264,
  sourceText,
  waitForIceGathering,
  type PublishResolution,
  type PublishSource,
} from './media';
import { createOverlayStream, type OverlayHandle } from './overlay';

/** Stream record created by the backend before publishing starts. */
export type WhipCreatedInfo = { id: number; title: string; coverUrl: string | null };

/** UI callbacks; the engine never touches React state directly. */
export type WhipCallbacks = {
  /** Progress / error status line (rendered as a `.rtc-status` pill). */
  onStatus: (text: TextMessage, tone: RtcTone) => void;
  /** Success / hint lines appended to the page notice area. */
  onLog: (parts: Array<TextMessage | null | undefined>) => void;
  /** The backend room record exists (id + cover already uploaded). */
  onCreated: (info: WhipCreatedInfo) => void;
  /** Cover upload failed but publishing continues. */
  onCoverError: (text: TextMessage) => void;
  /** Stream to show in the local preview (null when the session released it). */
  onPreview: (stream: MediaStream | null) => void;
  /** Called exactly once when a session ends (failure, auto-stop or `stop()`). */
  onSessionEnd: (notice: RtcStatus) => void;
  /** The lobby stream list should be refreshed (publish started / source ended). */
  onLiveChanged: () => void;
};

export type WhipStartOptions = {
  token: string;
  title: string;
  source: PublishSource;
  resolution: Pick<PublishResolution, 'width' | 'height' | 'labelKey'>;
  fps: number;
  cover: PreparedCover | null;
  overlay: boolean;
  /** Pre-acquired capture (studio device step). When absent the engine captures. */
  capture?: MediaStream | null;
  audioDeviceId?: string;
  videoDeviceId?: string;
};

/** One live publish session and everything it owns. */
type Runtime = {
  controller: AbortController;
  source: PublishSource;
  stream: MediaStream | null;
  pc: RTCPeerConnection | null;
  fps: number;
  /** Raw camera/screen video track, restored when the overlay is switched off. */
  originalVideoTrack: MediaStreamTrack | null;
  /** Composite camera + Live2D canvas stream; null when overlay is off. */
  composite: OverlayHandle | null;
  /** Hidden <video> element that feeds the compositor. */
  sourceVideo: HTMLVideoElement | null;
};

export class WhipPublisher {
  private readonly callbacks: WhipCallbacks;
  private runtime: Runtime | null = null;

  constructor(callbacks: WhipCallbacks) {
    this.callbacks = callbacks;
  }

  get active(): boolean {
    return this.runtime !== null;
  }

  /** Current local capture stream (raw, not the composite); null when idle. */
  get stream(): MediaStream | null {
    return this.runtime?.stream ?? null;
  }

  /** `createRoom` + `getUserMedia` status helpers shared by both UIs. */
  private status(text: TextMessage, tone: RtcTone): void {
    this.callbacks.onStatus(text, tone);
  }

  /**
   * Start publishing. Resolves when the session either goes live or has been
   * torn down; failures are reported through `onSessionEnd` (never thrown).
   */
  async start(options: WhipStartOptions): Promise<void> {
    if (this.runtime) return;
    const controller = new AbortController();
    const runtime: Runtime = {
      controller,
      source: options.source,
      stream: null,
      pc: null,
      fps: options.fps,
      originalVideoTrack: null,
      composite: null,
      sourceVideo: null,
    };
    this.runtime = runtime;
    const isCurrent = () => this.runtime === runtime;
    const { source, resolution, fps } = options;

    try {
      // 1. Create the stream record on the backend and get its WHIP publish path.
      this.status(msg('publish.creating'), 'info');
      const response = await fetch(`${API}/api/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ title: options.title }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new LocalizedError(data?.error
          ? backendText(String(data.error), response.status)
          : msg('publish.createFailed', { status: response.status }));
      }
      const streamId = Number(data?.id);
      const publishPath = typeof data?.publishPath === 'string' && data.publishPath
        ? data.publishPath
        : (Number.isSafeInteger(streamId) && streamId > 0 ? `/api/streams/${streamId}/whip` : '');
      if (!Number.isSafeInteger(streamId) || streamId < 1 || !publishPath) {
        throw new LocalizedError(msg('publish.badCreateResponse'));
      }

      // 2. Upload the compressed cover (if selected) before going live.
      let uploadedCoverUrl: string | null = null;
      let coverNote: TextMessage | null = null;
      if (options.cover) {
        this.status(msg('publish.uploadingCover'), 'info');
        try {
          uploadedCoverUrl = await uploadCover(API, options.token, streamId, options.cover.dataUrl);
          coverNote = msg('msg.coverUploadedNote', { url: resolveAssetUrl(API, uploadedCoverUrl) });
        } catch (error: any) {
          coverNote = msg('msg.coverUploadFailedNote', {
            detail: errorMessage(error, msg('common.unknownError')),
          });
          this.callbacks.onCoverError(errorMessage(error, msg('cover.uploadFailedFallback')));
        }
        if (!isCurrent()) return;
      }
      this.callbacks.onCreated({ id: streamId, title: options.title, coverUrl: uploadedCoverUrl });

      // 3. Capture camera or screen (or reuse the studio's preview capture).
      let capture = options.capture ?? null;
      if (!capture) {
        this.status(msg(source === 'screen' ? 'publish.pickShareTarget' : 'publish.requestingDevice'), 'info');
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: resolution.width },
          height: { ideal: resolution.height },
          frameRate: { ideal: fps },
        };
        if (source === 'camera' && options.videoDeviceId) {
          videoConstraints.deviceId = { exact: options.videoDeviceId };
        }
        const audioConstraints: MediaTrackConstraints | boolean = options.audioDeviceId
          ? { deviceId: { exact: options.audioDeviceId } }
          : true;
        const devices = navigator.mediaDevices;
        capture = source === 'screen'
          ? await devices.getDisplayMedia({ video: videoConstraints, audio: true })
          : await devices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
      }
      runtime.stream = capture;
      if (!isCurrent()) { this.stopCapture(runtime); return; }
      runtime.originalVideoTrack = capture.getVideoTracks()[0] ?? null;

      // 4. Optional Live2D compositing: a hidden <video> feeds the overlay canvas.
      let overlayNote: TextMessage | null = null;
      if (options.overlay) {
        if (!getLive2DCanvas()) {
          overlayNote = msg('msg.overlayMissingNote');
        } else {
          try {
            const overlaySource = document.createElement('video');
            overlaySource.muted = true;
            overlaySource.playsInline = true;
            overlaySource.srcObject = capture;
            runtime.sourceVideo = overlaySource;
            void overlaySource.play().catch(() => undefined);
            runtime.composite = createOverlayStream(overlaySource, {
              width: resolution.width,
              height: resolution.height,
              fps,
            });
          } catch (error: any) {
            if (runtime.composite) { runtime.composite.stop(); runtime.composite = null; }
            overlayNote = msg('msg.overlayUnavailableNote', {
              detail: errorMessage(error, msg('common.unknownError')),
            });
          }
        }
      }
      this.callbacks.onPreview(runtime.composite?.stream ?? capture);

      // 5. PeerConnection with H.264 preferred, then a single-shot ICE offer (WHIP).
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      runtime.pc = pc;
      const outgoingVideo = runtime.composite?.stream.getVideoTracks()[0] ?? runtime.originalVideoTrack;
      if (outgoingVideo) {
        pc.addTrack(outgoingVideo, runtime.composite?.stream ?? capture);
      }
      for (const track of capture.getAudioTracks()) {
        pc.addTrack(track, capture);
      }
      // Screen-share/camera video tracks end when the user stops sharing or unplugs
      // the device; that ends publishing. The raw track stays alive while a
      // composite video track is being sent.
      runtime.originalVideoTrack?.addEventListener('ended', () => {
        if (this.runtime !== runtime) return;
        this.stop({
          text: msg(runtime.source === 'screen' ? 'publish.shareEnded' : 'publish.cameraEnded'),
          tone: 'warn',
        });
        this.callbacks.onLog([
          msg(runtime.source === 'screen' ? 'publish.shareEndedMessage' : 'publish.cameraEndedMessage'),
        ]);
        this.callbacks.onLiveChanged();
      });
      preferH264(pc);
      pc.onconnectionstatechange = () => {
        if (this.runtime !== runtime) return;
        switch (pc.connectionState) {
          case 'connected': this.status(msg('publish.streamingConnected'), 'ok'); break;
          case 'disconnected': this.status(msg('publish.disconnected'), 'warn'); break;
          case 'failed': this.status(msg('publish.connectionFailed'), 'error'); break;
          default: break;
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (this.runtime !== runtime) return;
        switch (pc.iceConnectionState) {
          case 'checking': this.status(msg('publish.iceChecking'), 'info'); break;
          case 'connected':
          case 'completed': this.status(msg('publish.iceConnected'), 'ok'); break;
          case 'failed': this.status(msg('publish.iceFailed'), 'error'); break;
          default: break;
        }
      };

      const offer = await pc.createOffer();
      if (!isCurrent()) return;
      await pc.setLocalDescription(offer);
      if (!isCurrent()) return;
      this.status(msg('publish.gathering'), 'info');
      const gathering = await waitForIceGathering(pc, controller.signal, 12000);
      if (!isCurrent()) return;
      if (gathering === 'timeout') {
        this.status(msg('publish.iceTimeout'), 'warn');
      }

      // 6. POST the offer to the authenticated WHIP proxy; the answer completes it.
      const whipResponse = await fetch(`${API}${publishPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/sdp',
          Accept: 'application/sdp',
        },
        body: pc.localDescription?.sdp || offer.sdp,
        signal: controller.signal,
      });
      const answer = await whipResponse.text();
      if (!isCurrent()) return;
      if (!whipResponse.ok) throw describeWhipFailure(whipResponse.status, answer);
      if (!looksLikeSdp(answer)) throw new LocalizedError(msg('rtc.badAnswer'));
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (!isCurrent()) return;
      const overlayLabel = runtime.composite ? msg('msg.overlayLabel') : '';
      this.status(msg('publish.liveStatus', {
        id: streamId,
        resolution: msg(resolution.labelKey),
        fps,
        source: sourceText(source),
        overlay: overlayLabel,
      }), 'ok');
      this.callbacks.onLog([
        msg('msg.publishStarted', { id: streamId, title: options.title }),
        msg('msg.publishUrl', { url: `${API}${publishPath}` }),
        msg('msg.publishPicture', {
          resolution: msg(resolution.labelKey),
          fps,
          source: sourceText(source),
          overlay: overlayLabel,
        }),
        coverNote,
        overlayNote,
      ]);
      this.callbacks.onLiveChanged();
    } catch (error: any) {
      if (this.runtime !== runtime) return;
      const aborted = error?.name === 'AbortError' || controller.signal.aborted;
      if (aborted) {
        this.stop();
        return;
      }
      const text = PUBLISH_MEDIA_ERRORS.includes(String(error?.name))
        ? describeMediaFailure(error, source)
        : msg('publish.failed', { detail: errorMessage(error, msg('common.unknownError')) });
      this.stop({ text, tone: 'error' });
      this.callbacks.onLog([text, msg('msg.publishFailureHint')]);
    }
  }

  /**
   * Tear the session down: abort in-flight requests/ICE, close the
   * PeerConnection, stop the composite + capture tracks and clear the preview.
   * Idempotent; always emits `onSessionEnd` when a session was active.
   */
  stop(notice: RtcStatus = { text: msg('publish.stopped'), tone: 'idle' }): void {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = null;
    try { runtime.controller.abort(); } catch { /* already aborted */ }
    if (runtime.pc) {
      runtime.pc.onconnectionstatechange = null;
      runtime.pc.oniceconnectionstatechange = null;
      try { runtime.pc.close(); } catch { /* already closed */ }
      runtime.pc = null;
    }
    if (runtime.composite) {
      try { runtime.composite.stop(); } catch { /* already stopped */ }
      runtime.composite = null;
    }
    if (runtime.sourceVideo) {
      runtime.sourceVideo.srcObject = null;
      runtime.sourceVideo.remove();
      runtime.sourceVideo = null;
    }
    this.stopCapture(runtime);
    this.callbacks.onPreview(null);
    this.callbacks.onSessionEnd(notice);
  }

  /**
   * Switch the Live2D overlay on/off for a session that is already live.
   * Only the video track is replaced; audio keeps flowing from the capture.
   */
  async setOverlay(enabled: boolean): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !runtime.pc || !runtime.stream) return;
    const videoSender = runtime.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (!videoSender) return;
    if (!enabled) {
      if (runtime.composite) {
        runtime.composite.stop();
        runtime.composite = null;
      }
      if (runtime.sourceVideo) {
        runtime.sourceVideo.srcObject = null;
        runtime.sourceVideo.remove();
        runtime.sourceVideo = null;
      }
      const original = runtime.originalVideoTrack;
      if (original && original.readyState === 'live') {
        try { await videoSender.replaceTrack(original); } catch { /* keep composite if swap fails */ }
      }
      this.callbacks.onPreview(runtime.stream);
      this.status(msg('publish.overlayOff'), 'info');
      return;
    }
    const modelCanvas = getLive2DCanvas();
    if (!modelCanvas) {
      this.status(msg('publish.overlayNoModel'), 'warn');
      return;
    }
    try {
      let source = runtime.sourceVideo;
      if (!source) {
        source = document.createElement('video');
        source.muted = true;
        source.playsInline = true;
        source.srcObject = runtime.stream;
        runtime.sourceVideo = source;
        void source.play().catch(() => undefined);
      }
      if (source.readyState < 2) {
        await new Promise<void>((resolve) => {
          if (!source) { resolve(); return; }
          const target = source;
          const done = () => {
            target.removeEventListener('loadeddata', done);
            window.clearTimeout(timer);
            resolve();
          };
          const timer = window.setTimeout(done, 2000);
          target.addEventListener('loadeddata', done);
        });
      }
      if (runtime.composite) {
        runtime.composite.stop();
        runtime.composite = null;
      }
      const handle = createOverlayStream(source, { width: 1280, height: 720, fps: runtime.fps });
      runtime.composite = handle;
      const track = handle.stream.getVideoTracks()[0];
      if (!track) throw new LocalizedError(msg('publish.noVideoTrack'));
      await videoSender.replaceTrack(track);
      this.callbacks.onPreview(handle.stream);
      this.status(msg('publish.overlayOn'), 'ok');
    } catch (error: any) {
      this.status(msg('publish.overlayEnableFailed', {
        detail: errorMessage(error, msg('common.unknownError')),
      }), 'error');
    }
  }

  /** Stop every capture track (the caller owns the stream once handed over). */
  private stopCapture(runtime: Runtime): void {
    const stream = runtime.stream;
    runtime.stream = null;
    runtime.originalVideoTrack = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* track already stopped */ }
    }
  }
}
