/**
 * `/studio` — PC-first broadcast workbench.
 *
 * Four guided steps: devices (camera/screen + microphone + live level meter) →
 * picture & Live2D → stream info (title/cover) → go live over WHIP. The page
 * reuses the same modules as the lobby: `cover.ts` for compression/upload,
 * `live2d.ts` for the mascot canvas, `overlay.ts` compositing inside
 * `whipPublisher.ts`, and `media.ts` presets/error text.
 *
 * The WHIP session itself lives in `App` (like the lobby publisher) so a host
 * can open their live room while still publishing — navigating away from the
 * studio does not kill the broadcast. The studio only renders its state.
 */
import { useEffect, useRef, useState } from 'react';
import { MAX_COVER_BYTES, describeCoverSize, prepareCover, type PreparedCover } from './cover';
import { errorMessage, msg, t, translateMessage, useLang, type I18nKey, type TextMessage } from './i18n';
import {
  PUBLISH_FPS,
  PUBLISH_RESOLUTIONS,
  describeMediaFailure,
  stopCaptureTracks,
  type PublishResolutionKey,
  type PublishSource,
} from './media';
import { levelDb, levelPercent, useLevelMeter } from './audioLevel';
import {
  attachLive2DPanel,
  getLive2DCanvas,
  loadLive2D,
  setLive2DVisible,
  unloadLive2D,
  useLive2DState,
} from './live2d';
import type { CapacityInfo, RtcStatus } from './api';
import type { WhipCreatedInfo, WhipStartOptions } from './whipPublisher';

/** Everything the studio configures; App adds the auth token when publishing. */
export type StudioStartRequest = Omit<WhipStartOptions, 'token'>;

export type StudioPageProps = {
  token: string;
  username: string;
  capacity: CapacityInfo | null;
  secureContext: boolean;
  publishing: boolean;
  status: RtcStatus;
  liveInfo: WhipCreatedInfo | null;
  /** Preview stream from the App-level publisher (composite when overlay is on). */
  enginePreview: MediaStream | null;
  messages: TextMessage[];
  onStart: (request: StudioStartRequest) => void;
  onStop: () => void;
  onSetOverlay: (enabled: boolean) => void;
  onLogin: () => void;
  onBackToLobby: () => void;
  onOpenRoom: (streamId: number) => void;
};

const STEP_COUNT = 4;

const STEP_TITLE_KEYS = ['studio.step1', 'studio.step2', 'studio.step3', 'studio.step4'] as const;
const STEP_HINT_KEYS = ['studio.stepHint1', 'studio.stepHint2', 'studio.stepHint3', 'studio.stepHint4'] as const;

/** i18n key for the Live2D phase pill. */
function live2dPhaseKey(phase: string): I18nKey {
  switch (phase) {
    case 'core': return 'live2d.phase.core';
    case 'model': return 'live2d.phase.model';
    case 'ready': return 'live2d.phase.ready';
    case 'error': return 'live2d.phase.error';
    default: return 'live2d.phase.idle';
  }
}

export function StudioPage(props: StudioPageProps) {
  const {
    token,
    username,
    capacity,
    secureContext,
    publishing,
    status,
    liveInfo,
    enginePreview,
    messages,
    onStart,
    onStop,
    onSetOverlay,
    onLogin,
    onBackToLobby,
    onOpenRoom,
  } = props;
  useLang();

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<PublishSource>('camera');
  const [resolutionKey, setResolutionKey] = useState<PublishResolutionKey>('720p');
  const [fps, setFps] = useState<number>(30);
  const [title, setTitle] = useState('');
  const [cover, setCover] = useState<PreparedCover | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<TextMessage | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<TextMessage | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [overlayNotice, setOverlayNotice] = useState<TextMessage | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState('');
  const [videoDeviceId, setVideoDeviceId] = useState('');
  const [live2dInput, setLive2dInput] = useState(() => localStorage.getItem('live2d.modelUrl') || '');

  const live2dState = useLive2DState();
  const previewVideo = useRef<HTMLVideoElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const live2dHost = useRef<HTMLDivElement>(null);
  const previewRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const wasPublishing = useRef(false);
  const micLevel = useLevelMeter(previewStream, !publishing);

  const resolution = PUBLISH_RESOLUTIONS.find((item) => item.key === resolutionKey) ?? PUBLISH_RESOLUTIONS[1];
  const capacityLimited = capacity?.allow1080p60 === false;
  const capacityReason = capacity
    && (capacity.cpuCores !== null || capacity.memoryFreeMb !== null || capacity.activeRooms !== null)
    ? t('publish.capacityReason', {
      cores: capacity.cpuCores ?? '—',
      freeMb: capacity.memoryFreeMb === null ? '—' : Math.round(capacity.memoryFreeMb),
      rooms: capacity.activeRooms ?? '—',
    })
    : (capacity?.reason || t('publish.capacityReasonUnknown'));
  const displayStream = enginePreview ?? previewStream;
  const micPercent = levelPercent(micLevel);
  const micActive = !!previewStream && previewStream.getAudioTracks().length > 0;
  const hasCapture = !!displayStream;
  const live2dBusy = live2dState.phase === 'core' || live2dState.phase === 'model';
  const live2dTone = live2dState.phase === 'ready'
    ? 'ok'
    : live2dState.phase === 'error'
      ? 'error'
      : live2dBusy
        ? 'info'
        : 'idle';

  /* ---------------- device capture ---------------- */

  async function refreshDevices(): Promise<void> {
    const devices = navigator.mediaDevices;
    if (!devices || typeof devices.enumerateDevices !== 'function') return;
    try {
      const list = await devices.enumerateDevices();
      if (!mountedRef.current) return;
      setAudioInputs(list.filter((device) => device.kind === 'audioinput'));
      setVideoInputs(list.filter((device) => device.kind === 'videoinput'));
    } catch {
      // Device labels need permission; an empty list is fine.
    }
  }

  async function startPreview(overrides: {
    source?: PublishSource;
    resolutionKey?: PublishResolutionKey;
    fps?: number;
    audioDeviceId?: string;
    videoDeviceId?: string;
  } = {}): Promise<void> {
    if (publishing || captureBusy) return;
    if (!secureContext) {
      setCaptureError(msg('studio.captureNeedsSecure'));
      return;
    }
    const nextSource = overrides.source ?? source;
    const nextResolution = PUBLISH_RESOLUTIONS.find((item) => item.key === (overrides.resolutionKey ?? resolutionKey))
      ?? PUBLISH_RESOLUTIONS[1];
    const nextFps = overrides.fps ?? fps;
    const nextAudio = overrides.audioDeviceId ?? audioDeviceId;
    const nextVideo = overrides.videoDeviceId ?? videoDeviceId;
    const devices = navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== 'function') {
      setCaptureError(msg('publish.noWebrtc'));
      return;
    }
    if (nextSource === 'screen' && typeof devices.getDisplayMedia !== 'function') {
      setCaptureError(msg('publish.noDisplayMedia'));
      return;
    }
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: nextResolution.width },
        height: { ideal: nextResolution.height },
        frameRate: { ideal: nextFps },
      };
      if (nextSource === 'camera' && nextVideo) videoConstraints.deviceId = { exact: nextVideo };
      const audioConstraints: MediaTrackConstraints | boolean = nextAudio
        ? { deviceId: { exact: nextAudio }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true };
      const stream = nextSource === 'screen'
        ? await devices.getDisplayMedia({ video: videoConstraints, audio: true })
        : await devices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
      if (!mountedRef.current) { stopCaptureTracks(stream); return; }
      const previous = previewRef.current;
      previewRef.current = stream;
      setPreviewStream(stream);
      if (previous && previous !== stream) stopCaptureTracks(previous);
      // Screen-share preview ends when the user stops sharing; the publisher
      // installs its own ended handler once it takes the stream over.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          if (previewRef.current !== stream) return;
          if (wasPublishing.current) return;
          previewRef.current = null;
          setPreviewStream(null);
          stopCaptureTracks(stream);
        });
      }
      void refreshDevices();
    } catch (error: any) {
      if (!mountedRef.current) return;
      setCaptureError(describeMediaFailure(error, nextSource));
    } finally {
      if (mountedRef.current) setCaptureBusy(false);
    }
  }

  function stopPreview(): void {
    if (publishing) return;
    const stream = previewRef.current;
    previewRef.current = null;
    setPreviewStream(null);
    stopCaptureTracks(stream);
  }

  function selectSource(next: PublishSource): void {
    setSource(next);
    if (previewRef.current) stopPreview();
  }

  function selectResolution(next: PublishResolutionKey): void {
    setResolutionKey(next);
    if (previewRef.current && !publishing) void startPreview({ resolutionKey: next });
  }

  function selectFps(next: number): void {
    setFps(next);
    if (previewRef.current && !publishing) void startPreview({ fps: next });
  }

  function selectAudioDevice(next: string): void {
    setAudioDeviceId(next);
    if (previewRef.current && !publishing) void startPreview({ audioDeviceId: next });
  }

  function selectVideoDevice(next: string): void {
    setVideoDeviceId(next);
    if (previewRef.current && !publishing) void startPreview({ videoDeviceId: next });
  }

  /* ---------------- cover ---------------- */

  async function handleCoverFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setCoverBusy(true);
    setCoverError(null);
    try {
      setCover(await prepareCover(file));
    } catch (error: any) {
      setCover(null);
      setCoverError(errorMessage(error, msg('cover.processFailed')));
    } finally {
      setCoverBusy(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  }

  /* ---------------- Live2D ---------------- */

  async function loadLive2DModel(): Promise<void> {
    const url = live2dInput.trim();
    localStorage.setItem('live2d.modelUrl', url);
    await loadLive2D(live2dHost.current, url);
  }

  function toggleOverlay(next: boolean): void {
    setOverlay(next);
    setOverlayNotice(null);
    if (publishing) {
      onSetOverlay(next);
      return;
    }
    if (next && !live2dState.hasModel) {
      setOverlayNotice(msg('publish.overlayNoModelWarn'));
    }
  }

  /* ---------------- publish ---------------- */

  function startPublish(): void {
    if (publishing) return;
    if (!token) {
      setOverlayNotice(msg('publish.needLogin'));
      return;
    }
    if (!secureContext) {
      setOverlayNotice(msg('publish.insecure'));
      return;
    }
    const capture = previewRef.current;
    if (!capture) {
      setOverlayNotice(msg('studio.captureRequired'));
      setStep(0);
      return;
    }
    setOverlayNotice(null);
    onStart({
      title: title.trim() || t('msg.userStreamTitle', { name: username || msg('common.userName') }),
      source,
      resolution,
      fps,
      cover,
      overlay,
      capture,
      audioDeviceId: audioDeviceId || undefined,
      videoDeviceId: source === 'camera' && videoDeviceId ? videoDeviceId : undefined,
    });
  }

  /* ---------------- effects ---------------- */

  // Attach the preview element to whichever stream should be shown (the App
  // publisher's composite wins while publishing, otherwise the local capture).
  useEffect(() => {
    const video = previewVideo.current;
    if (!video) return;
    if (video.srcObject !== displayStream) video.srcObject = displayStream;
    if (displayStream) {
      video.muted = true;
      void video.play().catch(() => undefined);
    }
  }, [displayStream]);

  // Re-attach an already loaded Live2D model when this page mounts.
  useEffect(() => {
    if (live2dState.hasModel) attachLive2DPanel(live2dHost.current);
  }, [live2dState.hasModel]);

  // Keep the canvas aria-label in sync with the selected language.
  useEffect(() => {
    getLive2DCanvas()?.setAttribute('aria-label', t('live2d.canvasLabel'));
  }, [live2dState.hasModel]);

  // Capacity-limited servers move a stale 1080p/60fps selection back down.
  useEffect(() => {
    if (capacity?.allow1080p60 !== false) return;
    setResolutionKey((current) => (current === '1080p' ? '720p' : current));
    setFps((current) => (current === 60 ? 30 : current));
  }, [capacity]);

  // The editor hands its capture stream to the publisher; once the session
  // ends the App clears the preview and the studio forgets the stopped stream.
  useEffect(() => {
    if (wasPublishing.current && !publishing) {
      previewRef.current = null;
      setPreviewStream(null);
      void refreshDevices();
    }
    wasPublishing.current = publishing;
  }, [publishing]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshDevices();
    return () => {
      mountedRef.current = false;
      // While publishing the stream belongs to the App-level publisher, so only
      // release a local preview that was never handed over.
      if (!wasPublishing.current) {
        const stream = previewRef.current;
        previewRef.current = null;
        stopCaptureTracks(stream);
      }
    };
  }, []);

  /* ---------------- render ---------------- */

  if (!token) {
    return (
      <main className="page studio-page" id="top">
        <div className="studio-topbar">
          <button type="button" className="secondary small" onClick={onBackToLobby}>
            <span aria-hidden="true">←</span> {t('studio.back')}
          </button>
        </div>
        <section className="panel studio-gate">
          <span className="lobby-empty-mark" aria-hidden="true">◉</span>
          <h1>{t('studio.needLoginTitle')}</h1>
          <p className="hint">{t('studio.needLogin')}</p>
          <button type="button" onClick={onLogin}>{t('studio.loginCta')}</button>
        </section>
      </main>
    );
  }

  const desktopHint = t('studio.bestOnDesktop');
  const publishStatePill = publishing ? t('studio.live') : t('studio.idle');
  const showLiveInfo = liveInfo && publishing;

  return (
    <main className="page studio-page" id="top">
      <div className="studio-topbar">
        <button type="button" className="secondary small" onClick={onBackToLobby}>
          <span aria-hidden="true">←</span> {t('studio.back')}
        </button>
        <div className="studio-topbar-actions">
          <span className={`state-pill ${publishing ? 'ok' : 'idle'}`}>{publishStatePill}</span>
          {showLiveInfo && (
            <button type="button" className="button small" onClick={() => onOpenRoom(liveInfo.id)}>
              {t('studio.openRoom')} · #{liveInfo.id}
            </button>
          )}
          {publishing && (
            <button type="button" className="secondary small" onClick={onStop}>{t('studio.stop')}</button>
          )}
        </div>
      </div>

      <section className="studio-head">
        <div>
          <span className="eyebrow">{t('studio.eyebrow')}</span>
          <h1>{t('studio.title')}</h1>
          <p className="hint">{t('studio.lead')}</p>
          <p className="hint">{desktopHint}</p>
        </div>
        <div className={`studio-status ${status.tone}`} role="status" aria-live="polite">
          <span className={`state-pill ${status.tone}`}>{publishing ? t('studio.live') : t('studio.idle')}</span>
          <p>{translateMessage(status.text)}</p>
        </div>
      </section>

      {!secureContext && (
        <p className="hint warn-text" role="alert">{t('studio.insecure')}</p>
      )}

      <div className="studio-shell">
        <nav className="studio-steps" aria-label={t('studio.title')}>
          {STEP_TITLE_KEYS.map((key, index) => {
            const active = step === index;
            const done = index < step;
            return (
              <button
                key={key}
                type="button"
                className={`studio-step${active ? ' active' : ''}${done ? ' done' : ''}`}
                aria-current={active ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="studio-step-index" aria-hidden="true">{done ? '✓' : index + 1}</span>
                <span className="studio-step-text">
                  <b>{t(key)}</b>
                  <small>{t(STEP_HINT_KEYS[index])}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="studio-main">
          <div className="studio-preview">
            <div className={`player preview${displayStream ? ' has-stream' : ''}`}>
              <video ref={previewVideo} muted autoPlay playsInline aria-label={t('studio.previewLabel')} />
              {!displayStream && (
                <div className="player-empty">
                  <span className="player-empty-icon" aria-hidden="true">◉</span>
                  <p>{t('studio.previewIdleTitle')}</p>
                  <small>{t('studio.previewIdleHint')}</small>
                </div>
              )}
              {publishing && <span className="studio-live-badge"><i aria-hidden="true" />{t('studio.live')}</span>}
            </div>
            <div className="studio-preview-meta">
              <span className="room-chip">{t('studio.summaryPicture', {
                resolution: t(resolution.labelKey),
                fps,
              })}</span>
              <span className="room-chip">{t(source === 'screen' ? 'publish.sourceScreen' : 'publish.sourceCamera')}</span>
            </div>
            <div className="studio-meter-block">
              <div className="studio-meter-label">
                <span>{t('studio.micLevel')}</span>
                <span>{micActive ? t('studio.micLevelDb', { db: levelDb(micLevel) }) : t('studio.micLevelIdle')}</span>
              </div>
              <div
                className="studio-meter"
                data-testid="mic-level"
                data-level={micPercent}
                role="meter"
                aria-label={t('studio.micLevel')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={micPercent}
              >
                <div className="studio-meter-fill" style={{ width: `${micPercent}%` }} />
              </div>
            </div>
          </div>

          <section className="panel studio-panel">
            {step === 0 && (
              <>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">STEP 1</span>
                    <h2>{t('studio.step1')}</h2>
                    <p className="hint">{t('studio.stepHint1')}</p>
                  </div>
                </div>
                <div className="field-row">
                  <label className="field">{t('studio.source')}
                    <select
                      value={source}
                      disabled={publishing}
                      onChange={(event) => selectSource(event.target.value as PublishSource)}
                    >
                      <option value="camera">{t('studio.sourceCamera')}</option>
                      <option value="screen">{t('studio.sourceScreen')}</option>
                    </select>
                  </label>
                  <label className="field">{t('studio.resolution')}
                    <select
                      value={resolutionKey}
                      disabled={publishing}
                      onChange={(event) => selectResolution(event.target.value as PublishResolutionKey)}
                    >
                      {PUBLISH_RESOLUTIONS.map((item) => {
                        const disabled = capacityLimited && item.key === '1080p';
                        return (
                          <option key={item.key} value={item.key} disabled={disabled}>
                            {t(item.labelKey)}{disabled ? t('publish.capacityOptionDisabled') : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="field">{t('studio.fps')}
                    <select value={fps} disabled={publishing} onChange={(event) => selectFps(Number(event.target.value))}>
                      {PUBLISH_FPS.map((value) => {
                        const disabled = capacityLimited && value === 60;
                        return (
                          <option key={value} value={value} disabled={disabled}>
                            {value} fps{disabled ? t('publish.capacityOptionDisabled') : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
                {capacityLimited && (
                  <p className="hint warn-text">{t('publish.capacityLimited', { reason: capacityReason })}</p>
                )}
                {!capacityLimited && capacity?.allow1080p60 === true && (
                  <p className="hint">{t('publish.capacityAllowed')}</p>
                )}
                <div className="field-row">
                  <label className="field">{t('studio.cameraDevice')}
                    <select
                      value={videoDeviceId}
                      disabled={publishing || source === 'screen'}
                      onChange={(event) => selectVideoDevice(event.target.value)}
                    >
                      <option value="">{t('studio.defaultDevice')}</option>
                      {videoInputs.map((device, index) => (
                        <option key={device.deviceId || index} value={device.deviceId}>
                          {device.label || `${t('studio.cameraDevice')} ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">{t('studio.micDevice')}
                    <select
                      value={audioDeviceId}
                      disabled={publishing}
                      onChange={(event) => selectAudioDevice(event.target.value)}
                    >
                      <option value="">{t('studio.defaultDevice')}</option>
                      {audioInputs.map((device, index) => (
                        <option key={device.deviceId || index} value={device.deviceId}>
                          {device.label || `${t('studio.micDevice')} ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="field studio-detect">
                    <span aria-hidden="true">&nbsp;</span>
                    <button type="button" onClick={() => void startPreview()} disabled={captureBusy || publishing}>
                      {captureBusy ? t('studio.detecting') : t('studio.detect')}
                    </button>
                  </div>
                </div>
                <div className="studio-actions">
                  <button type="button" className="secondary" onClick={stopPreview} disabled={!previewStream || publishing}>
                    {t('studio.stopPreview')}
                  </button>
                  {captureError && <span className="hint err-text" role="alert">{translateMessage(captureError)}</span>}
                  {!captureError && <span className="hint">{t('studio.deviceChangeHint')}</span>}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">STEP 2</span>
                    <h2>{t('studio.live2dTitle')}</h2>
                    <p className="hint">{t('studio.live2dHint')}</p>
                  </div>
                  <span className={`state-pill ${live2dTone}`}>{t(live2dPhaseKey(live2dState.phase))}</span>
                </div>
                <div className="live2d-form">
                  <input
                    value={live2dInput}
                    onChange={(event) => setLive2dInput(event.target.value)}
                    placeholder="https://example.com/model/model3.json"
                    aria-label={t('live2d.urlLabel')}
                    disabled={live2dBusy}
                    spellCheck={false}
                  />
                  <button type="button" onClick={() => void loadLive2DModel()} disabled={live2dBusy}>
                    {live2dBusy ? t('live2d.loadingButton') : t('live2d.loadButton')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setLive2DVisible(!live2dState.visible)}
                    disabled={!live2dState.hasModel}
                  >
                    {live2dState.visible ? t('live2d.hide') : t('live2d.show')}
                  </button>
                  <button type="button" className="ghost" onClick={() => unloadLive2D()} disabled={!live2dState.hasModel}>
                    {t('live2d.unload')}
                  </button>
                </div>
                <p className={`hint rtc-status ${live2dTone}`} role="status" aria-live="polite">
                  {translateMessage(live2dState.message)}
                </p>
                <div className="live2d-stage-wrap studio-live2d-stage">
                  <div ref={live2dHost} className={`live2d-stage ${live2dState.visible ? '' : 'is-hidden'}`} />
                  {!live2dState.hasModel && (
                    <div className="live2d-placeholder" aria-hidden="true">
                      <span className="live2d-placeholder-mark" aria-hidden="true">L2D</span>
                      <p>{t('live2d.placeholderTitle')}</p>
                      <small>{t('live2d.placeholderHint')}</small>
                    </div>
                  )}
                </div>
                <p className="hint">{t('studio.live2dPanelHint')}</p>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={overlay}
                    onChange={(event) => toggleOverlay(event.target.checked)}
                  />
                  <span className="switch-text">
                    {t('studio.overlaySwitch')}
                    <small>{live2dState.hasModel ? t('studio.overlayHintOn') : t('studio.overlayHintOff')}</small>
                  </span>
                </label>
                {overlayNotice && <p className="hint warn-text" role="status">{translateMessage(overlayNotice)}</p>}
              </>
            )}

            {step === 2 && (
              <>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">STEP 3</span>
                    <h2>{t('studio.step3')}</h2>
                    <p className="hint">{t('studio.stepHint3')}</p>
                  </div>
                </div>
                <label className="field">{t('studio.titleField')}
                  <input
                    value={title}
                    maxLength={120}
                    disabled={publishing}
                    placeholder={t('studio.titlePlaceholder')}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <div className="cover-field">
                  <div className="cover-field-head">
                    <span>{t('studio.coverTitle')}</span>
                    <small>{t('publish.coverHint')}</small>
                  </div>
                  <div className="cover-picker">
                    <div className="cover-thumb" style={cover ? undefined : { background: 'linear-gradient(135deg,#1d2742,#121a2e)' }}>
                      {cover ? (
                        <img src={cover.dataUrl} alt={t('publish.coverPreviewAlt')} />
                      ) : (
                        <span className="cover-thumb-empty" aria-hidden="true">＋</span>
                      )}
                    </div>
                    <div className="cover-picker-actions">
                      <input
                        ref={coverInput}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        hidden
                        onChange={(event) => { void handleCoverFile(event.target.files?.[0]); }}
                      />
                      <button
                        type="button"
                        className="secondary small"
                        disabled={coverBusy || publishing}
                        onClick={() => coverInput.current?.click()}
                      >
                        {coverBusy ? t('publish.coverBusy') : cover ? t('publish.coverChange') : t('publish.coverPick')}
                      </button>
                      {cover && (
                        <>
                          <button
                            type="button"
                            className="ghost small"
                            disabled={publishing}
                            onClick={() => { setCover(null); setCoverError(null); }}
                          >
                            {t('publish.coverRemove')}
                          </button>
                          <span className="hint">{describeCoverSize(cover)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {coverError && <p className="hint err-text" role="status">{translateMessage(coverError)}</p>}
                  {!coverError && cover && cover.bytes <= MAX_COVER_BYTES && (
                    <p className="hint">{t('publish.coverUploadBeforeStart')}</p>
                  )}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">STEP 4</span>
                    <h2>{t('studio.step4')}</h2>
                    <p className="hint">{t('studio.stepHint4')}</p>
                  </div>
                </div>
                <dl className="studio-summary">
                  <div><dt>{t('studio.summaryTitle')}</dt><dd>{title.trim() || t('studio.titlePlaceholder')}</dd></div>
                  <div><dt>{t('studio.source')}</dt><dd>{t(source === 'screen' ? 'publish.sourceScreen' : 'publish.sourceCamera')}</dd></div>
                  <div>
                    <dt>{t('studio.resolution')}</dt>
                    <dd>{t(resolution.labelKey)} · {fps}fps</dd>
                  </div>
                  <div>
                    <dt>{t('studio.cameraDevice')}</dt>
                    <dd>{source === 'screen' ? t('studio.sourceScreen') : (videoInputs.find((device) => device.deviceId === videoDeviceId)?.label || t('studio.defaultDevice'))}</dd>
                  </div>
                  <div>
                    <dt>{t('studio.micLabel')}</dt>
                    <dd>{audioInputs.find((device) => device.deviceId === audioDeviceId)?.label || t('studio.defaultDevice')}</dd>
                  </div>
                  <div>
                    <dt>{t('studio.overlayLabel')}</dt>
                    <dd>{overlay ? t('studio.on') : t('studio.off')}</dd>
                  </div>
                  <div>
                    <dt>{t('studio.micLevel')}</dt>
                    <dd>{micActive ? t('studio.micActive') : '—'}</dd>
                  </div>
                </dl>
                <div className="studio-actions">
                  <button type="button" onClick={startPublish} disabled={publishing || !hasCapture}>
                    {publishing ? t('studio.starting') : t('studio.start')}
                  </button>
                  <button type="button" className="secondary" onClick={onStop} disabled={!publishing}>
                    {t('studio.stop')}
                  </button>
                  {showLiveInfo && (
                    <button type="button" className="ghost" onClick={() => onOpenRoom(liveInfo.id)}>
                      {t('studio.openRoom')}
                    </button>
                  )}
                </div>
                <p className={`hint rtc-status ${status.tone}`} role="status" aria-live="polite">
                  {translateMessage(status.text)}
                </p>
                <p className="hint">{t('studio.flowHint')}</p>
                <p className="hint">{t('studio.engineHint')}</p>
                <p className="hint">{t('studio.voiceTip')}</p>
                {messages.length > 0 && (
                  <pre className="message studio-message" role="status" aria-live="polite">
                    {messages.map(translateMessage).join('\n')}
                  </pre>
                )}
              </>
            )}
          </section>

          <div className="studio-nav">
            <button type="button" className="secondary" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>
              {t('studio.prev')}
            </button>
            <span className="hint">{t(STEP_HINT_KEYS[step])}</span>
            <button type="button" onClick={() => setStep((current) => Math.min(STEP_COUNT - 1, current + 1))} disabled={step === STEP_COUNT - 1}>
              {t('studio.next')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
