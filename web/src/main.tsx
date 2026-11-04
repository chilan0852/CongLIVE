import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import {
  LocalizedError,
  backendText,
  errorMessage,
  msg,
  rawText,
  setLang,
  t,
  translateMessage,
  useLang,
  type I18nKey,
  type TextMessage,
} from './i18n';
import {
  MAX_COVER_BYTES,
  describeCoverSize,
  prepareCover,
  resolveAssetUrl,
  uploadCover,
  type PreparedCover,
} from './cover';
import {
  attachLive2DPanel,
  getLive2DCanvas,
  loadLive2D,
  setLive2DVisible,
  unloadLive2D,
  useLive2DState,
} from './live2d';
import {
  PUBLISH_FPS,
  PUBLISH_RESOLUTIONS,
  describeWhepFailure,
  looksLikeSdp,
  waitForIceGathering,
  type PublishResolutionKey,
  type PublishSource,
  type VideoElementWithFrames,
} from './media';
import {
  API,
  coverFallbackChar,
  coverFallbackStyle,
  fetchCapacity,
  fetchRoomDetail,
  fetchStreams,
  streamCoverUrl,
  type CapacityInfo,
  type ChatMessage,
  type LiveStream,
  type RoomDetail,
  type RtcStatus,
  type RtcTone,
} from './api';
import { startLatencyMonitor, type LatencySample } from './latency';
import { navigate, roomPath, scrollToSection, studioPath, useRoute } from './router';
import { RoomPage } from './room';
import { StudioPage, type StudioStartRequest } from './studio';
import { WhipPublisher, type WhipCreatedInfo } from './whipPublisher';

type LastCreatedStream = { id: number; title: string; coverUrl: string | null };

function live2dPhaseLabel(phase: string): I18nKey {
  switch (phase) {
    case 'core': return 'live2d.phase.core';
    case 'model': return 'live2d.phase.model';
    case 'ready': return 'live2d.phase.ready';
    case 'error': return 'live2d.phase.error';
    default: return 'live2d.phase.idle';
  }
}

function App() {
  const route = useRoute();
  const roomId = route.name === 'room' ? route.streamId : null;
  const inRoom = roomId !== null;
  const inStudio = route.name === 'studio';
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<TextMessage[]>([]);
  const [chatStreamId, setChatStreamId] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatState, setChatState] = useState<TextMessage>(msg('chat.pickRoom'));
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>(() => ({
    text: msg(localStorage.getItem('token') ? 'rtc.idlePicking' : 'rtc.idleSignedOut'),
    tone: 'idle',
  }));
  const [retryNonce, setRetryNonce] = useState(0);
  // Browser publishing (WHIP) settings and runtime state.
  const [publishSource, setPublishSource] = useState<PublishSource>('camera');
  const [publishResolution, setPublishResolution] = useState<PublishResolutionKey>('720p');
  const [publishFps, setPublishFps] = useState<number>(30);
  const [publishTitle, setPublishTitle] = useState('');
  const [publishOverlay, setPublishOverlay] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<RtcStatus>(() => ({
    text: msg(window.isSecureContext ? 'publish.idle' : 'publish.idleInsecure'),
    tone: window.isSecureContext ? 'idle' : 'warn',
  }));
  // Broadcast studio (`/studio`) publish session.
  const [studioPublishing, setStudioPublishing] = useState(false);
  const [studioStatus, setStudioStatus] = useState<RtcStatus>(() => ({
    text: msg('publish.idle'),
    tone: 'idle',
  }));
  const [studioLiveInfo, setStudioLiveInfo] = useState<WhipCreatedInfo | null>(null);
  const [studioPreviewStream, setStudioPreviewStream] = useState<MediaStream | null>(null);
  const [studioMessages, setStudioMessages] = useState<TextMessage[]>([]);
  // Cover image: compressed locally, uploaded after the stream is created.
  const [cover, setCover] = useState<PreparedCover | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<TextMessage | null>(null);
  const [lastCreated, setLastCreated] = useState<LastCreatedStream | null>(null);
  // Standalone room state (`/room/<id>`): detail, viewer count, latency and lifecycle.
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomNotFound, setRoomNotFound] = useState(false);
  const [roomEnded, setRoomEnded] = useState(false);
  const [roomError, setRoomError] = useState<TextMessage | null>(null);
  const [roomRetryNonce, setRoomRetryNonce] = useState(0);
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const [latency, setLatency] = useState<LatencySample | null>(null);
  // Server capacity from GET /api/capacity; null = unknown, keep the legacy options.
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null);
  const roomLive = !!roomDetail && roomDetail.is_live && !roomEnded;
  // Live2D loader input (persisted between visits).
  const [live2dInput, setLive2dInput] = useState(() => localStorage.getItem('live2d.modelUrl') || '');
  const live2dState = useLive2DState();
  const lang = useLang();
  const secureContext = window.isSecureContext;
  const video = useRef<HTMLVideoElement>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const live2dHost = useRef<HTMLDivElement>(null);
  const publisher = useRef<WhipPublisher | null>(null);
  // Studio publishing lives at App level so opening the live room does not stop it.
  const studioPublisher = useRef<WhipPublisher | null>(null);
  const chatSocket = useRef<WebSocket | null>(null);
  const playbackTeardown = useRef<(() => void) | null>(null);
  const rtcToneRef = useRef<RtcTone>('idle');

  /** Show one or more translatable message lines (no parts clears the notice). */
  const showMessage = (...parts: Array<TextMessage | null | undefined>) => {
    setMessage(parts.filter((part): part is TextMessage => Boolean(part)));
  };

  async function load() {
    try {
      setStreams(await fetchStreams());
    } catch (e: any) {
      showMessage(msg('msg.streamListFailed', {
        detail: e?.message ? rawText(String(e.message)) : msg('msg.checkBackend'),
      }));
    }
  }

  // Lobby polling: only while the lobby is mounted and the tab is visible. The room
  // page has its own lighter refresh, so an open room never polls the lobby list.
  useEffect(() => {
    if (inRoom) return;
    void load();
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void load();
      }, 10000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [inRoom]);

  // Keep the Live2D canvas attached to the panel when it mounts. Without a loaded
  // model there is nothing to render, so no Live2D initialisation is triggered.
  useEffect(() => {
    if (!live2dState.hasModel) return;
    attachLive2DPanel(live2dHost.current);
  }, [live2dState.hasModel]);

  // Canvas aria-labels are set when the model loads; refresh them on language switch.
  useEffect(() => {
    getLive2DCanvas()?.setAttribute('aria-label', t('live2d.canvasLabel'));
  }, [lang]);

  // Server capacity gates 1080p/60fps for the publish card. A missing endpoint is
  // treated as "unknown" and must not disable any of the existing presets.
  useEffect(() => {
    const controller = new AbortController();
    void fetchCapacity(controller.signal)
      .then((info) => { if (!controller.signal.aborted) setCapacity(info); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // If the server reports it cannot sustain 1080p/60fps, move a stale selection back
  // to 720p/30 before the publisher constraints are built.
  useEffect(() => {
    if (capacity?.allow1080p60 !== false) return;
    setPublishResolution((current) => (current === '1080p' ? '720p' : current));
    setPublishFps((current) => (current === 60 ? 30 : current));
  }, [capacity]);

  // Browser tab title reflects the room or studio that is open.
  useEffect(() => {
    if (inStudio) document.title = t('studio.documentTitle');
    else document.title = roomDetail ? t('room.documentTitle', { title: roomDetail.title }) : t('app.title');
  }, [inStudio, roomDetail, lang]);

  // Scroll to the top when switching between the lobby, a room and the studio.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [roomId, inStudio]);

  // Route -> room detail. The lobby entry is used as an instant placeholder and then
  // GET /api/streams/:id refreshes it (and brings the authoritative viewer count).
  useEffect(() => {
    if (roomId === null) {
      setRoomDetail(null);
      setRoomError(null);
      setRoomNotFound(false);
      setRoomEnded(false);
      setRoomLoading(false);
      setViewerCount(null);
      setLatency(null);
      return;
    }
    const cached = streams.find((stream) => stream.id === roomId) ?? null;
    setRoomDetail(cached);
    setRoomError(null);
    setRoomNotFound(false);
    setRoomEnded(false);
    setViewerCount(cached?.viewers ?? null);
    setLatency(null);
    setRoomLoading(true);
    const controller = new AbortController();
    (async () => {
      try {
        const result = await fetchRoomDetail(roomId, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'ok') {
          setRoomDetail(result.stream);
          setViewerCount(result.stream.viewers ?? null);
          setRoomEnded(!result.stream.is_live);
        } else if (result.status === 'not-found') {
          setRoomEnded(true);
          if (!cached) {
            setRoomDetail(null);
            setRoomNotFound(true);
          }
        } else if (!cached) {
          setRoomError(msg('room.loadFailed'));
        }
      } catch (error: any) {
        if (error?.name === 'AbortError' || controller.signal.aborted) return;
        if (!cached) setRoomError(msg('room.loadFailed'));
      } finally {
        if (!controller.signal.aborted) setRoomLoading(false);
      }
    })();
    return () => controller.abort();
  }, [roomId, roomRetryNonce]);

  // While a room is open, refresh its detail (viewers + end of stream) only when the
  // tab is visible; leaving the room clears the interval.
  useEffect(() => {
    if (roomId === null) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchRoomDetail(roomId)
        .then((result) => {
          if (disposed || !result) return;
          if (result.status === 'ok') {
            setRoomDetail((previous) => (previous && previous.id === roomId
              ? { ...previous, ...result.stream }
              : result.stream));
            setViewerCount(result.stream.viewers ?? null);
            if (!result.stream.is_live) {
              // Ended rooms stay open for the "已下播" screen; stop refreshing them.
              setRoomEnded(true);
              window.clearInterval(timer);
            }
          } else if (result.status === 'not-found') {
            setRoomEnded(true);
            window.clearInterval(timer);
          }
        })
        .catch(() => undefined);
    }, 12000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [roomId]);

  // Only a live room that is actually open gets a WHEP player/chat session.
  useEffect(() => {
    if (roomId === null || !token || !roomLive) {
      setChatStreamId(null);
      return;
    }
    setChatStreamId(roomId);
  }, [roomId, token, roomLive]);

  // Explain the disabled chat input when the host has stopped publishing.
  useEffect(() => {
    if (!inRoom || !token || roomLive) return;
    setChatState(msg('chat.roomEnded'));
  }, [inRoom, token, roomLive]);

  // WebRTC playback uses WHEP (SDP offer/answer) instead of HLS or HTTP-FLV.
  useEffect(() => {
    const element = video.current;
    const frameElement = element as VideoElementWithFrames | null;
    const streamId = chatStreamId;
    const authToken = token;
    let closed = false;
    let pc: RTCPeerConnection | null = null;
    let mediaTimer: number | undefined;
    let stallTimer: number | undefined;
    let receivedTrack = false;
    let hasVideoTrack = false;
    let mutedByFallback = false;
    let videoFrameHandle = 0;
    let lastFrameAt = Date.now();
    let lastFrameCount = -1;
    let stalled = false;
    const controller = new AbortController();
    const remoteStream = new MediaStream();
    let latencyStop: (() => void) | null = null;

    const status = (text: TextMessage, tone: RtcTone) => {
      if (closed) return;
      rtcToneRef.current = tone;
      setRtcStatus({ text, tone });
    };

    // Idempotent teardown: closes the PeerConnection, cancels the in-flight WHEP
    // request and ICE gathering, stops every remote track and detaches srcObject.
    // It is called by leaveRoom() and by the React cleanup, whichever runs first.
    const release = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      latencyStop?.();
      latencyStop = null;
      setLatency(null);
      window.clearTimeout(mediaTimer);
      window.clearInterval(stallTimer);
      if (frameElement?.cancelVideoFrameCallback && videoFrameHandle) {
        try { frameElement.cancelVideoFrameCallback(videoFrameHandle); } catch { /* already cancelled */ }
        videoFrameHandle = 0;
      }
      if (pc) {
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        try { pc.close(); } catch { /* already closed */ }
        pc = null;
      }
      for (const track of remoteStream.getTracks()) {
        try { track.stop(); } catch { /* track already ended */ }
        remoteStream.removeTrack(track);
      }
      // Do not leave the next room silently muted because autoplay forced a muted fallback.
      if (element && mutedByFallback) {
        element.muted = false;
        mutedByFallback = false;
      }
      if (element && element.srcObject === remoteStream) element.srcObject = null;
    };

    if (!streamId || !authToken) {
      playbackTeardown.current = null;
      setLatency(null);
      status(authToken ? msg('rtc.idlePicking') : msg('rtc.idleSignedOut'), 'idle');
      return;
    }
    if (!element) return;

    playbackTeardown.current = release;
    setRtcStatus({ text: msg('rtc.connectingWhep'), tone: 'info' });

    pc = new RTCPeerConnection({
      // SRS publishes a public ICE candidate; STUN helps clients behind NAT discover their public mapping.
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Sample getStats once per second for the "延迟≈Xms" chip. The monitor pauses
    // itself on hidden tabs and is stopped by release() when the viewer leaves.
    latencyStop = startLatencyMonitor(pc, (sample) => {
      if (!closed) setLatency(sample);
    });

    // End-of-stream watchdog. SRS can keep a WHEP PeerConnection open after the publisher
    // stops, so no track-end or connection-state event arrives. A MediaStream's currentTime
    // keeps advancing even when no frames are decoded, so watch decoded/presented video
    // frames instead: rVFC where available, totalVideoFrames otherwise.
    const markFrameProgress = () => {
      lastFrameAt = Date.now();
      if (stalled) {
        stalled = false;
        status(msg('rtc.resumed'), 'ok');
      }
    };
    const watchVideoFrame = () => {
      if (closed || !frameElement || !hasVideoTrack) return;
      markFrameProgress();
      if (frameElement.requestVideoFrameCallback) {
        videoFrameHandle = frameElement.requestVideoFrameCallback(watchVideoFrame);
      }
    };
    stallTimer = window.setInterval(() => {
      if (closed || !element) return;
      if (!receivedTrack || !hasVideoTrack || element.paused) {
        lastFrameAt = Date.now();
        lastFrameCount = -1;
        return;
      }
      // requestVideoFrameCallback does not fire for hidden tabs, so do not misreport them.
      if (document.visibilityState !== 'visible') {
        lastFrameAt = Date.now();
        return;
      }
      if (!frameElement?.requestVideoFrameCallback) {
        if (typeof element.getVideoPlaybackQuality !== 'function') return; // rely on connection state
        const frames = element.getVideoPlaybackQuality().totalVideoFrames;
        if (frames !== lastFrameCount) {
          lastFrameCount = frames;
          markFrameProgress();
        }
      }
      if (!stalled && Date.now() - lastFrameAt > 10000 && rtcToneRef.current !== 'error') {
        stalled = true;
        status(msg('rtc.stalled'), 'warn');
      }
    }, 2000);

    // After media was flowing, "connection failed" usually means the stream ended rather
    // than a firewall problem, so word the message accordingly.
    const connectionFailureText = (layer: 'WebRTC' | 'ICE'): TextMessage => (receivedTrack
      ? msg('rtc.connectionLost', { layer })
      : msg('rtc.connectionFailed', { layer }));

    const startPlayback = async () => {
      if (closed || !element) return;
      try {
        await element.play();
        if (!closed) status(msg('rtc.playing'), 'ok');
      } catch {
        // Autoplay with sound is often blocked; retry muted so the picture still shows.
        element.muted = true;
        mutedByFallback = true;
        try {
          await element.play();
          if (!closed) status(msg('rtc.autoplayMuted'), 'warn');
        } catch {
          if (!closed) status(msg('rtc.clickPlay'), 'warn');
        }
      }
    };

    pc.ontrack = (event) => {
      if (closed) return;
      window.clearTimeout(mediaTimer);
      const track = event.track;
      // Every track is merged into one shared MediaStream. Using event.streams[0]
      // directly would let a late audio track replace the already rendered video.
      if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      if (element.srcObject !== remoteStream) element.srcObject = remoteStream;
      if (track.kind === 'video' && !hasVideoTrack) {
        hasVideoTrack = true;
        lastFrameAt = Date.now();
        if (frameElement?.requestVideoFrameCallback) {
          videoFrameHandle = frameElement.requestVideoFrameCallback(watchVideoFrame);
        }
      }
      track.onended = () => {
        if (closed) return;
        remoteStream.removeTrack(track);
        if (remoteStream.getTracks().length === 0) {
          status(msg('rtc.remoteEnded'), 'warn');
        }
      };
      if (!receivedTrack) {
        receivedTrack = true;
        status(msg('rtc.tracksReceived'), 'info');
      }
      void startPlayback();
    };

    pc.onconnectionstatechange = () => {
      if (closed || !pc) return;
      switch (pc.connectionState) {
        case 'connected':
          status(msg('rtc.connected'), 'ok');
          break;
        case 'disconnected':
          status(msg('rtc.disconnected'), 'warn');
          break;
        case 'failed':
          status(connectionFailureText('WebRTC'), 'error');
          break;
        case 'closed':
          break;
        default:
          status(msg('rtc.state', { state: pc.connectionState }), 'info');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (closed || !pc) return;
      switch (pc.iceConnectionState) {
        case 'checking':
          status(msg('rtc.iceChecking'), 'info');
          break;
        case 'connected':
        case 'completed':
          status(msg('rtc.iceConnected'), 'ok');
          break;
        case 'disconnected':
          status(msg('rtc.iceDisconnected'), 'warn');
          break;
        case 'failed':
          status(connectionFailureText('ICE'), 'error');
          break;
        default:
          break;
      }
    };

    async function connect() {
      if (!pc) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const gathering = await waitForIceGathering(pc, controller.signal, 12000);
        if (closed || gathering === 'aborted' || !pc) return;
        if (gathering === 'timeout') {
          status(msg('rtc.iceTimeout'), 'warn');
        }

        const response = await fetch(`${API}/api/streams/${streamId}/whep`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
          body: pc.localDescription?.sdp || offer.sdp,
          signal: controller.signal,
        });
        const answer = await response.text();
        if (closed) return;
        if (!response.ok) throw describeWhepFailure(response.status, answer);
        if (!looksLikeSdp(answer)) throw new LocalizedError(msg('rtc.badAnswer'));
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        if (closed) return;
        status(msg('rtc.signalingDone'), 'info');
        mediaTimer = window.setTimeout(() => {
          if (closed || receivedTrack) return;
          status(msg('rtc.noTracks'), 'warn');
        }, 15000);
      } catch (error: any) {
        if (closed) return;
        if (error?.name === 'AbortError') return;
        status(msg('rtc.playFailed', { detail: errorMessage(error, msg('common.unknownError')) }), 'error');
        // Signaling failed: stop ICE checks instead of leaving a half-open transport.
        controller.abort();
        if (pc) {
          try { pc.close(); } catch { /* already closed */ }
          pc = null;
        }
      }
    }
    void connect();

    return () => {
      release();
      if (playbackTeardown.current === release) playbackTeardown.current = null;
    };
  }, [chatStreamId, token, retryNonce]);

  // WebSocket remains the independent data channel for comments and moderation messages.
  useEffect(() => {
    if (!chatStreamId || !token) {
      chatSocket.current?.close();
      chatSocket.current = null;
      setChatMessages([]);
      setChatState(msg('chat.pickRoom'));
      return;
    }
    const wsBase = API ? API.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const socket = new WebSocket(`${wsBase}/ws/chat`);
    chatSocket.current = socket;
    let disposed = false;
    setChatMessages([]);
    setChatState(msg('chat.connecting'));
    // Viewer counter updates arrive over the chat channel (ready + broadcast events).
    const applyViewers = (value: unknown) => {
      const count = Number(value);
      if (!Number.isFinite(count) || count < 0) return;
      setViewerCount(count);
      setStreams((previous) => previous.map((stream) => (
        stream.id === chatStreamId ? { ...stream, viewers: count } : stream
      )));
      setRoomDetail((previous) => (previous && previous.id === chatStreamId
        ? { ...previous, viewers: count }
        : previous));
    };
    socket.onopen = () => { if (!disposed) socket.send(JSON.stringify({ type: 'auth', token, streamId: chatStreamId })); };
    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ready') {
          setChatMessages(data.messages || []);
          setChatState(msg('chat.connected'));
          if (data.viewers !== undefined && data.viewers !== null) applyViewers(data.viewers);
        } else if (data.type === 'viewers') {
          if (Number(data.streamId) === Number(chatStreamId)) applyViewers(data.viewers);
        } else if (data.type === 'message') setChatMessages((prev) => [...prev, data.message].slice(-100));
        else if (data.type === 'warning' || data.type === 'error') setChatState(data.message ? backendText(String(data.message)) : msg('chat.error'));
      } catch { /* Ignore malformed server messages. */ }
    };
    // Ignore close/error events fired by a socket we already abandoned, so a stale
    // "disconnected" message cannot overwrite the state of the room we just joined.
    socket.onclose = (event) => { if (!disposed) setChatState(msg(event.code === 4403 ? 'chat.closed' : 'chat.disconnected')); };
    socket.onerror = () => { if (!disposed) setChatState(msg('chat.connectFailed')); };
    return () => {
      disposed = true;
      socket.close();
      if (chatSocket.current === socket) chatSocket.current = null;
    };
  }, [chatStreamId, token]);

  // Release every media session when the app shell is torn down (page close/HMR).
  // Route changes keep publishing alive: the studio publisher is App-owned on purpose.
  useEffect(() => () => {
    publisher.current?.stop();
    studioPublisher.current?.stop();
  }, []);

  async function auth(path: 'login' | 'register') {
    try {
      const r = await fetch(`${API}/api/auth/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new LocalizedError(backendText(String(data?.error || `HTTP ${r.status}`), r.status));
      if (path === 'login') {
        setToken(data.token);
        localStorage.setItem('token', data.token);
        const name = data?.user?.username || username;
        setUsername(name);
        localStorage.setItem('username', name);
      }
      showMessage(msg(path === 'login' ? 'auth.loginSuccess' : 'auth.registerSuccess'));
    } catch (error: any) { showMessage(errorMessage(error, msg('common.unknownError'))); }
  }

  async function create() {
    if (!token) { showMessage(msg('msg.needLogin')); return; }
    const title = t('msg.userStreamTitle', { name: username || msg('common.userName') });
    try {
      const response = await fetch(`${API}/api/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new LocalizedError(data?.error
          ? backendText(String(data.error), response.status)
          : backendText('', response.status));
      }
      const id = Number(data?.id);
      if (Number.isSafeInteger(id) && id > 0) setLastCreated({ id, title, coverUrl: null });
      showMessage(
        msg('msg.streamCreated', {
          idPart: Number.isSafeInteger(id) && id > 0 ? msg('msg.idPart', { id }) : '',
        }),
        msg('msg.createdTransport', { transport: String(data?.transport ?? '') }),
      );
      await load();
    } catch (error: any) { showMessage(errorMessage(error, msg('common.unknownError'))); }
  }

  /** Compress the selected cover into a <=2MB JPEG data URL. */
  async function handleCoverFile(file: File | undefined) {
    if (!file) return;
    setCoverBusy(true);
    setCoverError(null);
    try {
      const prepared = await prepareCover(file);
      setCover(prepared);
    } catch (error: any) {
      setCover(null);
      setCoverError(errorMessage(error, msg('cover.processFailed')));
    } finally {
      setCoverBusy(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  }

  /** Upload the prepared cover to the most recently created stream. */
  async function uploadCoverToLastCreated() {
    if (!token) { setCoverError(msg('msg.needLogin')); return; }
    if (!lastCreated) { setCoverError(msg('cover.needCreateRoom')); return; }
    if (!cover) { setCoverError(msg('cover.needCover')); return; }
    setCoverBusy(true);
    setCoverError(null);
    try {
      const coverUrl = await uploadCover(API, token, lastCreated.id, cover.dataUrl);
      setLastCreated({ ...lastCreated, coverUrl });
      showMessage(msg('msg.coverUploaded', {
        id: lastCreated.id,
        url: resolveAssetUrl(API, coverUrl),
      }));
      await load();
    } catch (error: any) {
      setCoverError(errorMessage(error, msg('cover.uploadFailedFallback')));
    } finally {
      setCoverBusy(false);
    }
  }

  /** Build the lobby publish engine with the App state callbacks. */
  function createLobbyPublisher(): WhipPublisher {
    return new WhipPublisher({
      onStatus: (text, tone) => setPublishStatus({ text, tone }),
      onLog: (parts) => showMessage(...parts),
      onCreated: (info) => setLastCreated(info),
      onCoverError: (text) => setCoverError(text),
      onPreview: (stream) => {
        const preview = previewVideo.current;
        if (!preview) return;
        preview.srcObject = stream;
        if (stream) {
          preview.muted = true;
          void preview.play().catch(() => undefined);
        }
      },
      onSessionEnd: (notice) => {
        publisher.current = null;
        setPublishing(false);
        setPublishStatus(notice);
        if (previewVideo.current) previewVideo.current.srcObject = null;
      },
      onLiveChanged: () => { void load(); },
    });
  }

  /** Start browser publishing from the lobby publish card (WHIP). */
  async function startPublish() {
    if (publishing || publisher.current) return;
    if (!token) {
      setPublishStatus({ text: msg('publish.needLogin'), tone: 'warn' });
      return;
    }
    if (!secureContext) {
      setPublishStatus({ text: msg('publish.insecure'), tone: 'error' });
      return;
    }
    const devices = navigator.mediaDevices;
    const source = publishSource;
    if (!devices || typeof devices.getUserMedia !== 'function') {
      setPublishStatus({ text: msg('publish.noWebrtc'), tone: 'error' });
      return;
    }
    if (source === 'screen' && typeof devices.getDisplayMedia !== 'function') {
      setPublishStatus({ text: msg('publish.noDisplayMedia'), tone: 'error' });
      return;
    }
    const resolution = PUBLISH_RESOLUTIONS.find((item) => item.key === publishResolution) ?? PUBLISH_RESOLUTIONS[0];
    const engine = createLobbyPublisher();
    publisher.current = engine;
    setPublishing(true);
    setPublishStatus({ text: msg('publish.creating'), tone: 'info' });
    await engine.start({
      token,
      title: publishTitle.trim() || t('msg.userStreamTitle', { name: username || msg('common.userName') }),
      source,
      resolution,
      fps: publishFps,
      cover,
      overlay: publishOverlay,
    });
  }

  /** Stop the lobby publish session (SRS receives on_unpublish). */
  function stopPublish(notice: TextMessage = msg('msg.publishStopped')) {
    const engine = publisher.current;
    if (!engine) {
      setPublishing(false);
      if (previewVideo.current?.srcObject) previewVideo.current.srcObject = null;
      return;
    }
    engine.stop({ text: msg('publish.stopped'), tone: 'idle' });
    showMessage(notice);
    void load();
  }

  /** Toggle the Live2D overlay preference; hot-swaps the video track while live. */
  function togglePublishOverlay(next: boolean) {
    setPublishOverlay(next);
    const engine = publisher.current;
    if (engine?.active) void engine.setOverlay(next);
    else if (next && !live2dState.hasModel) {
      setPublishStatus({ text: msg('publish.overlayNoModelWarn'), tone: 'warn' });
    }
  }

  /* ------------------------------------------------------------------ *
   * Broadcast studio publish session (`/studio`)
   * ------------------------------------------------------------------ */

  /** Build the studio publish engine; it keeps running across route changes. */
  function createStudioPublisher(): WhipPublisher {
    return new WhipPublisher({
      onStatus: (text, tone) => setStudioStatus({ text, tone }),
      onLog: (parts) => setStudioMessages(parts.filter((part): part is TextMessage => Boolean(part))),
      onCreated: (info) => setStudioLiveInfo(info),
      onCoverError: (text) => setStudioMessages((previous) => [...previous, text]),
      onPreview: (stream) => setStudioPreviewStream(stream),
      onSessionEnd: (notice) => {
        studioPublisher.current = null;
        setStudioPublishing(false);
        setStudioPreviewStream(null);
        setStudioStatus(notice);
      },
      onLiveChanged: () => { void load(); },
    });
  }

  /** Start the studio WHIP session with the capture stream from the device step. */
  function startStudioPublish(request: StudioStartRequest) {
    if (!token || studioPublisher.current) return;
    const engine = createStudioPublisher();
    studioPublisher.current = engine;
    setStudioPublishing(true);
    setStudioMessages([]);
    setStudioLiveInfo(null);
    setStudioStatus({ text: msg('publish.creating'), tone: 'info' });
    void engine.start({ ...request, token });
  }

  /** Stop the studio session and release camera/mic/PC/preview. */
  function stopStudioPublish() {
    const engine = studioPublisher.current;
    if (!engine) return;
    engine.stop({ text: msg('publish.stopped'), tone: 'idle' });
    setStudioMessages([msg('msg.publishStopped')]);
  }

  /** Hot-toggle the studio Live2D overlay while live. */
  function setStudioOverlay(enabled: boolean) {
    void studioPublisher.current?.setOverlay(enabled);
  }

  /** Lobby live card click: open the standalone room (login is prompted inside it). */
  function enterRoom(stream: LiveStream) {
    if (roomId === stream.id) return;
    navigate(roomPath(stream.id));
  }

  /** Room "back to lobby": tear the WHEP/chat session down immediately, then route. */
  function leaveRoom() {
    playbackTeardown.current?.();
    playbackTeardown.current = null;
    chatSocket.current?.close();
    chatSocket.current = null;
    if (video.current) {
      video.current.srcObject = null;
      video.current.muted = false;
    }
    setChatStreamId(null);
    setRoomEnded(false);
    navigate('/');
  }

  /** Top-nav target: back to the lobby, then scroll to a card. */
  function handleSectionNav(section: string) {
    return (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (route.name === 'lobby') return;
      event.preventDefault();
      navigate('/');
      scrollToSection(section);
    };
  }

  function goLogin() {
    navigate('/');
    scrollToSection('auth');
  }

  function logout() {
    stopPublish(msg('msg.logoutStopped'));
    stopStudioPublish();
    leaveRoom();
    setToken('');
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    showMessage(msg('msg.signedOut'));
  }

  function sendChat(event: React.FormEvent) {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content) return;
    if (!token) { setChatState(msg('msg.needLogin')); return; }
    if (chatSocket.current?.readyState !== WebSocket.OPEN) { setChatState(msg('chat.notConnected')); return; }
    chatSocket.current.send(JSON.stringify({ type: 'chat', content }));
    setChatInput('');
  }

  async function loadLive2DModel() {
    const url = live2dInput.trim();
    localStorage.setItem('live2d.modelUrl', url);
    await loadLive2D(live2dHost.current, url);
  }

  function toggleLive2DVisible() {
    setLive2DVisible(!live2dState.visible);
  }

  const live2dLoading = live2dState.phase === 'core' || live2dState.phase === 'model';
  const live2dTone: RtcTone = live2dState.phase === 'ready'
    ? 'ok'
    : live2dState.phase === 'error'
      ? 'error'
      : live2dLoading
        ? 'info'
        : 'idle';
  const canConnectRoom = roomId !== null && !!token && roomLive;
  const canChatRoom = roomId !== null && !!token && roomLive;
  const canRetryRoom = canConnectRoom && (rtcStatus.tone === 'error' || rtcStatus.tone === 'warn');
  const capacityLimited = capacity?.allow1080p60 === false;
  const capacityReason = capacity
    && (capacity.cpuCores !== null || capacity.memoryFreeMb !== null || capacity.activeRooms !== null)
    ? t('publish.capacityReason', {
      cores: capacity.cpuCores ?? '—',
      freeMb: capacity.memoryFreeMb === null ? '—' : Math.round(capacity.memoryFreeMb),
      rooms: capacity.activeRooms ?? '—',
    })
    : (capacity?.reason || t('publish.capacityReasonUnknown'));

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a
            className="brand"
            href="#top"
            aria-label={t('brand.home')}
            onClick={(event) => {
              if (route.name === 'lobby') return;
              event.preventDefault();
              navigate('/');
            }}
          >
            <span className="brand-mark" aria-hidden="true">{t('brand.mark')}</span>
            <span className="brand-text">{t('brand.name')}<small>{t('brand.sub')}</small></span>
          </a>
          <nav className="topnav" aria-label={t('nav.label')}>
            <a href="#lobby" onClick={handleSectionNav('lobby')}>{t('nav.lobby')}</a>
            <a href="#publish" onClick={handleSectionNav('publish')}>{t('nav.publish')}</a>
            <a href="#live2d" onClick={handleSectionNav('live2d')}>{t('nav.live2d')}</a>
            <a
              href="/studio"
              aria-current={inStudio ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(studioPath());
              }}
            >
              {t('nav.studio')}
            </a>
          </nav>
          <div className="top-actions">
            <div className="lang-switch" role="group" aria-label={t('lang.switch')}>
              <button
                type="button"
                className={lang === 'zh' ? 'active' : ''}
                aria-pressed={lang === 'zh'}
                onClick={() => setLang('zh')}
              >
                {t('lang.zh')}
              </button>
              <button
                type="button"
                className={lang === 'en' ? 'active' : ''}
                aria-pressed={lang === 'en'}
                onClick={() => setLang('en')}
              >
                {t('lang.en')}
              </button>
            </div>
            {(publishing || studioPublishing) && (
              <span className="state-pill ok live-pill" title={t('studio.live')}>{t('studio.live')}</span>
            )}
            <span className={`conn-pill ${token ? 'online' : ''}`}>
              <i aria-hidden="true" />
              {token ? (username || t('topbar.signedIn')) : t('topbar.signedOut')}
            </span>
            {token
              ? <button type="button" className="ghost small" onClick={logout}>{t('topbar.logout')}</button>
              : (
                <a
                  className="button small"
                  href="#auth"
                  onClick={(event) => {
                    if (route.name === 'lobby') return;
                    event.preventDefault();
                    goLogin();
                  }}
                >
                  {t('topbar.loginRegister')}
                </a>
              )}
          </div>
        </div>
      </header>

      {inRoom ? (
        <RoomPage
          roomId={roomId as number}
          detail={roomDetail}
          loading={roomLoading}
          notFound={roomNotFound && !roomDetail}
          loadError={roomError}
          ended={roomEnded}
          token={token}
          viewers={viewerCount}
          latency={latency}
          videoRef={video}
          rtcStatus={rtcStatus}
          canConnect={canConnectRoom}
          canRetry={canRetryRoom}
          canChat={canChatRoom}
          chat={{
            messages: chatMessages,
            state: chatState,
            input: chatInput,
            setInput: setChatInput,
            submit: sendChat,
          }}
          onBack={leaveRoom}
          onLogin={goLogin}
          onRetryLoad={() => setRoomRetryNonce((value) => value + 1)}
          onRetryConnect={() => setRetryNonce((value) => value + 1)}
          currentUsername={username}
          onOpenStudio={() => navigate(studioPath())}
        />
      ) : inStudio ? (
        <StudioPage
          token={token}
          username={username}
          capacity={capacity}
          secureContext={secureContext}
          publishing={studioPublishing}
          status={studioStatus}
          liveInfo={studioLiveInfo}
          enginePreview={studioPreviewStream}
          messages={studioMessages}
          onStart={startStudioPublish}
          onStop={stopStudioPublish}
          onSetOverlay={setStudioOverlay}
          onLogin={goLogin}
          onBackToLobby={() => navigate('/')}
          onOpenRoom={(id) => navigate(roomPath(id))}
        />
      ) : (
        <main className="page" id="top">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">{t('hero.eyebrow')}</span>
            <h1>{t('hero.title')}<span>{t('hero.titleAccent')}</span></h1>
            <p className="hero-lead">{t('hero.lead')}</p>
            <div className="hero-badges">
              <span>{t('hero.badge.whep')}</span>
              <span>{t('hero.badge.whip')}</span>
              <span>{t('hero.badge.live2d')}</span>
              <span>{t('hero.badge.chat')}</span>
            </div>
          </div>
          <div className="auth-card" id="auth">
            {token ? (
              <div className="signed-in">
                <span className="eyebrow">{t('auth.eyebrowSignedIn')}</span>
                <h2>{username || t('auth.signedInAs')}</h2>
                <p className="hint">{t('auth.signedInHint')}</p>
                <div className="auth-actions">
                  <button type="button" className="secondary" onClick={() => void create()}>{t('auth.createRoom')}</button>
                  <button type="button" className="ghost" onClick={logout}>{t('topbar.logout')}</button>
                </div>
                {lastCreated && (
                  <p className="hint">{t('auth.lastCreated', { id: lastCreated.id, title: lastCreated.title })}</p>
                )}
              </div>
            ) : (
              <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void auth('login'); }}>
                <span className="eyebrow">{t('auth.eyebrowLogin')}</span>
                <h2>{t('auth.welcomeBack')}</h2>
                <label className="field">
                  {t('auth.username')}
                  <input
                    value={username}
                    autoComplete="username"
                    placeholder={t('auth.usernamePlaceholder')}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label className="field">
                  {t('auth.password')}
                  <input
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    placeholder={t('auth.passwordPlaceholder')}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <div className="auth-actions">
                  <button type="submit">{t('auth.login')}</button>
                  <button type="button" className="secondary" onClick={() => void auth('register')}>{t('auth.register')}</button>
                </div>
                <p className="hint">{t('auth.loginHint')}</p>
              </form>
            )}
          </div>
        </section>

        {message.length > 0 && (
          <pre className="message" role="status" aria-live="polite">{message.map(translateMessage).join('\n')}</pre>
        )}

        <section className="panel lobby-panel" id="lobby">
            <div className="panel-head">
              <div>
                <span className="eyebrow">{t('lobby.eyebrow')}</span>
                <h2>{t('lobby.title')} <span className="count">{streams.length}</span></h2>
              </div>
              <button type="button" className="secondary small" onClick={() => void load()}>{t('lobby.refresh')}</button>
            </div>
            <p className="hint">{t('lobby.hint')}</p>
            {!token && <p className="hint warn-text">{t('lobby.signedOutHint')}</p>}
            {streams.length === 0 ? (
              <div className="lobby-empty">
                <span className="lobby-empty-mark" aria-hidden="true">LIVE</span>
                <p>{t('lobby.emptyTitle')}</p>
                <small>{t('lobby.emptyHint')}</small>
              </div>
            ) : (
              <div className="live-grid">
                {streams.map((stream) => {
                  const coverUrl = streamCoverUrl(stream);
                  return (
                    <button
                      type="button"
                      className="live-card"
                      key={stream.id}
                      onClick={() => enterRoom(stream)}
                      aria-label={t('lobby.watchRoom', { title: stream.title })}
                    >
                      <div className="live-cover" style={coverFallbackStyle(stream)}>
                        <span className="live-cover-char" aria-hidden="true">{coverFallbackChar(stream)}</span>
                        {coverUrl && (
                          <img
                            src={coverUrl}
                            alt=""
                            loading="lazy"
                            onError={(event) => { event.currentTarget.style.display = 'none'; }}
                          />
                        )}
                        <span className="live-badge"><i aria-hidden="true" />{t('lobby.liveBadge')}</span>
                      </div>
                      <div className="live-meta">
                        <b>{stream.title}</b>
                        <span className="live-owner">{t('lobby.owner', { name: stream.username })}</span>
                        {stream.viewers !== null && stream.viewers !== undefined && (
                          <span className="live-viewers">{t('lobby.viewers', { count: stream.viewers })}</span>
                        )}
                        <span className="live-cta">{token ? t('lobby.cta') : t('lobby.ctaSignedOut')}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
        </section>

        <section className="panel publish-panel" id="publish">
          <div className="panel-head">
            <div>
              <span className="eyebrow">{t('publish.eyebrow')}</span>
              <h2>{t('publish.title')}</h2>
              <p className="hint">{t('publish.hint')}</p>
            </div>
            <span className={`state-pill ${publishing ? 'ok' : 'idle'}`}>{publishing ? t('publish.stateLive') : t('publish.stateIdle')}</span>
          </div>
          <div className="publish-grid">
            <div className="publish-form">
              <div className="field-row">
                <label className="field">{t('publish.source')}
                  <select value={publishSource} disabled={publishing} onChange={(e) => setPublishSource(e.target.value as PublishSource)}>
                    <option value="camera">{t('publish.sourceCamera')}</option>
                    <option value="screen">{t('publish.sourceScreen')}</option>
                  </select>
                </label>
                <label className="field">{t('publish.resolution')}
                  <select value={publishResolution} disabled={publishing} onChange={(e) => setPublishResolution(e.target.value as PublishResolutionKey)}>
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
                <label className="field">{t('publish.fps')}
                  <select value={publishFps} disabled={publishing} onChange={(e) => setPublishFps(Number(e.target.value))}>
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
                <p className="hint warn-text" role="status" aria-live="polite">
                  {t('publish.capacityLimited', { reason: capacityReason })}
                </p>
              )}
              {!capacityLimited && capacity && capacity.allow1080p60 === true && (
                <p className="hint">{t('publish.capacityAllowed')}</p>
              )}
              <label className="field">{t('publish.titleField')}
                <input
                  value={publishTitle}
                  maxLength={120}
                  disabled={publishing}
                  placeholder={t('msg.userStreamTitle', { name: username || msg('common.userName') })}
                  onChange={(e) => setPublishTitle(e.target.value)}
                />
              </label>

              <div className="cover-field">
                <div className="cover-field-head">
                  <span>{t('publish.coverTitle')}</span>
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
                      onChange={(e) => { void handleCoverFile(e.target.files?.[0]); }}
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
                        <button type="button" className="ghost small" disabled={publishing} onClick={() => { setCover(null); setCoverError(null); }}>
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
                {lastCreated && cover && (
                  <p className="hint">
                    {t('publish.lastCreatedRoom', { id: lastCreated.id })}
                    <button
                      type="button"
                      className="link-button"
                      disabled={coverBusy || publishing}
                      onClick={() => void uploadCoverToLastCreated()}
                    >
                      {t('publish.uploadCoverToRoom')}
                    </button>
                  </p>
                )}
              </div>

              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={publishOverlay}
                  disabled={!secureContext && !publishing}
                  onChange={(e) => togglePublishOverlay(e.target.checked)}
                />
                <span className="switch-text">
                  {t('publish.overlaySwitch')}
                  <small>
                    {live2dState.hasModel
                      ? t('publish.overlaySwitchHintOn')
                      : t('publish.overlaySwitchHintOff')}
                  </small>
                </span>
              </label>

              <div className="publish-actions">
                <button type="button" onClick={() => void startPublish()} disabled={!secureContext || publishing}>
                  {publishing ? t('publish.starting') : t('publish.start')}
                </button>
                <button type="button" className="secondary" onClick={() => stopPublish()} disabled={!publishing}>{t('publish.stop')}</button>
                <a className="button ghost small" href="#live2d">{t('publish.configureLive2d')}</a>
              </div>
              {!secureContext && (
                <p className="hint warn-text">{t('publish.insecureHint')}</p>
              )}
              <p className={`hint rtc-status ${publishStatus.tone}`} role="status" aria-live="polite">{translateMessage(publishStatus.text)}</p>
              <p className="hint">{t('publish.flowHint')}</p>
            </div>
            <div className="publish-preview">
              <div className={`player preview ${publishing ? 'has-stream' : ''}`}>
                <video ref={previewVideo} muted autoPlay playsInline aria-label={t('publish.previewLabel')} />
                {!publishing && (
                  <div className="player-empty">
                    <span className="player-empty-icon" aria-hidden="true">◉</span>
                    <p>{t('publish.previewLabel')}</p>
                  </div>
                )}
              </div>
              <p className="hint">{publishing
                ? t('publish.previewHintLive')
                : secureContext
                  ? t('publish.previewHintIdle')
                  : t('publish.previewHintInsecure')}</p>
            </div>
          </div>
        </section>

        <section className="panel live2d-panel" id="live2d">
            <div className="panel-head">
              <div>
                <span className="eyebrow">{t('live2d.eyebrow')}</span>
                <h2>{t('live2d.title')}</h2>
                <p className="hint">{t('live2d.panelHint')}</p>
              </div>
              <span className={`state-pill ${live2dTone}`}>{t(live2dPhaseLabel(live2dState.phase))}</span>
            </div>
            <div className="live2d-form">
              <input
                value={live2dInput}
                onChange={(e) => setLive2dInput(e.target.value)}
                placeholder="https://example.com/model/model3.json"
                aria-label={t('live2d.urlLabel')}
                disabled={live2dLoading}
                spellCheck={false}
              />
              <button type="button" onClick={() => void loadLive2DModel()} disabled={live2dLoading}>
                {live2dLoading ? t('live2d.loadingButton') : t('live2d.loadButton')}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={toggleLive2DVisible}
                disabled={!live2dState.hasModel}
              >
                {live2dState.visible ? t('live2d.hide') : t('live2d.show')}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => unloadLive2D()}
                disabled={!live2dState.hasModel}
              >
                {t('live2d.unload')}
              </button>
            </div>
            <p className={`hint rtc-status ${live2dTone}`} role="status" aria-live="polite">{translateMessage(live2dState.message)}</p>
            <div className="live2d-stage-wrap">
              <div ref={live2dHost} className={`live2d-stage ${live2dState.visible ? '' : 'is-hidden'}`} />
              {!live2dState.hasModel && (
                <div className="live2d-placeholder" aria-hidden="true">
                  <span className="live2d-placeholder-mark" aria-hidden="true">L2D</span>
                  <p>{t('live2d.placeholderTitle')}</p>
                  <small>{t('live2d.placeholderHint')}</small>
                </div>
              )}
            </div>
            <p className="hint">{t('live2d.footerHint')}</p>
        </section>

        <footer className="footer">
          <span>{t('footer.brand')}</span>
          <span>{t('footer.tech')}</span>
          <span>{t('footer.notice')}</span>
        </footer>
        </main>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
