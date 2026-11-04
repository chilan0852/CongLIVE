import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
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
import { createOverlayStream, type OverlayHandle } from './overlay';

const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
type ChatMessage = { id: number; username: string; content: string; createdAt: string };
type LiveStream = {
  id: number;
  title: string;
  username: string;
  is_live: boolean;
  whepPath: string;
  transport: 'WebRTC';
  coverUrl?: string | null;
};
type RtcTone = 'idle' | 'info' | 'ok' | 'warn' | 'error';
type RtcStatus = { text: string; tone: RtcTone };
type LastCreatedStream = { id: number; title: string; coverUrl: string | null };
type VideoElementWithFrames = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Cover URL as returned by the backend (`/covers/...`), resolved for <img>. */
function streamCoverUrl(stream: LiveStream): string {
  return resolveAssetUrl(API, stream.coverUrl || '');
}

/** Deterministic gradient for streams without a cover (title fallback). */
function coverFallbackStyle(stream: LiveStream): React.CSSProperties {
  const hue = (Number(stream.id) * 47) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 68% 40%), hsl(${(hue + 58) % 360} 72% 26%))`,
  };
}

/** First visible character of the title, used inside the gradient fallback. */
function titleInitial(title: string): string {
  const trimmed = String(title || '').trim();
  return trimmed ? Array.from(trimmed)[0] : '葱';
}

function coverFallbackChar(stream: LiveStream): string {
  return titleInitial(stream.title);
}

/**
 * Wait until ICE gathering completes so the offer posted to WHEP already contains
 * the client candidates (SRS needs them to trickle/answer within one request).
 * Resolves early with 'timeout' when gathering stalls, and with 'aborted' when the
 * viewer leaves the room, so the caller can stop without sending a stale offer.
 */
function waitForIceGathering(
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
function looksLikeSdp(text: string): boolean {
  const value = text.trim();
  return value.startsWith('v=0') && /^m=/m.test(value);
}

/** Turn a non-2xx WHEP response into a short, human readable status message. */
function describeWhepFailure(status: number, body: string): string {
  const hints: Record<number, string> = {
    400: '请求中的 SDP 无效',
    401: '登录状态已失效，请重新登录',
    403: '没有观看该直播的权限',
    404: '直播不存在或已下架',
    409: '主播尚未开播',
    429: '请求过于频繁，请稍后重试',
    502: '媒体服务器（SRS）暂时不可用',
    504: '媒体服务器（SRS）响应超时',
  };
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
  return `WHEP 请求失败（HTTP ${status}）：${detail || hints[status] || '未知错误'}`;
}

type PublishSource = 'camera' | 'screen';
const PUBLISH_RESOLUTIONS = [
  { key: '720p', width: 1280, height: 720, label: '720p（1280×720）' },
  { key: '540p', width: 960, height: 540, label: '540p（960×540）' },
  { key: '360p', width: 640, height: 360, label: '360p（640×360）' },
] as const;
type PublishResolutionKey = (typeof PUBLISH_RESOLUTIONS)[number]['key'];
const PUBLISH_FPS = [30, 24, 15] as const;
const PUBLISH_MEDIA_ERRORS = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'NotSupportedError', 'SecurityError'];

/** One active browser-publish session; null when nothing is being published. */
type Publisher = {
  controller: AbortController;
  stream: MediaStream | null;
  pc: RTCPeerConnection | null;
  /** Frame rate requested for the publish session (used by the overlay). */
  fps: number;
  /** Raw camera/screen video track, restored when the overlay is switched off. */
  originalVideoTrack: MediaStreamTrack | null;
  /** Composite camera + Live2D canvas stream; null when overlay is off. */
  composite: OverlayHandle | null;
  /** Hidden <video> element that feeds the compositor. */
  sourceVideo: HTMLVideoElement | null;
};

/** Turn a non-2xx WHIP response into a short, human readable publish error. */
function describeWhipFailure(status: number, body: string): string {
  const hints: Record<number, string> = {
    400: '提交的 SDP 无效',
    401: '登录状态已失效，请重新登录',
    403: '没有开播权限：只能推流自己的直播间',
    404: '直播间不存在或已被下架',
    409: '该直播间当前不可推流',
    429: '请求过于频繁，请稍后重试',
    502: '媒体服务器（SRS）暂时不可用，请检查 SRS 与 1985 内部端口',
    504: '媒体服务器（SRS）响应超时',
  };
  let detail = '';
  try {
    const data = JSON.parse(body);
    if (typeof data?.error === 'string') detail = data.error;
    else if (typeof data?.detail === 'string') detail = data.detail;
  } catch {
    // Not JSON: gateway HTML or plain text, trimmed below.
  }
  if (!detail && body.trim() && !body.trim().startsWith('v=')) {
    detail = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return `WHIP 推流失败（HTTP ${status}）：${detail || hints[status] || '未知错误'}`;
}

/** Explain getUserMedia/getDisplayMedia failures instead of leaking DOMException names. */
function describeMediaFailure(error: any, source: PublishSource): string {
  const name = String(error?.name || '');
  if (source === 'screen') {
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '屏幕共享被取消或未授权：开播需要允许共享屏幕（也可改用「摄像头」视频源）';
      case 'NotSupportedError':
        return '当前浏览器不支持屏幕共享（getDisplayMedia），请改用「摄像头」视频源或新版 Chrome/Edge';
      default:
        return `获取屏幕画面失败：${error?.message || '未知错误'}`;
    }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头或麦克风权限被拒绝：请点击地址栏的权限图标允许后重试';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '未找到可用的摄像头/麦克风，或设备不支持所选分辨率与帧率';
    case 'NotReadableError':
      return '摄像头或麦克风被其他程序占用，请关闭占用设备后重试';
    case 'NotSupportedError':
      return '当前浏览器不支持摄像头采集（getUserMedia）';
    default:
      return `获取摄像头/麦克风失败：${error?.message || '未知错误'}`;
  }
}

/** Stop every track in a local capture stream; safe to call more than once. */
function stopCaptureTracks(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* track already stopped */ }
  }
}

/**
 * Ask the browser to prefer H.264 for outgoing video. SRS forwards the publisher's
 * H.264 to WHEP viewers, so keeping it first avoids a codec mismatch on older SRS boxes.
 * Browsers that do not expose the API keep their own defaults.
 */
function preferH264(pc: RTCPeerConnection) {
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

function live2dPhaseLabel(phase: string): string {
  switch (phase) {
    case 'core': return '加载 Core';
    case 'model': return '加载模型';
    case 'ready': return '已就绪';
    case 'error': return '加载失败';
    default: return '未加载';
  }
}

function App() {
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [chatStreamId, setChatStreamId] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatState, setChatState] = useState('选择一间正在直播的房间加入弹幕');
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>(() => (localStorage.getItem('token')
    ? { text: '在右侧大厅选择一间正在直播的房间开始观看', tone: 'idle' }
    : { text: '未登录：观看直播需要先登录，登录后通过 WHEP 实时播放', tone: 'idle' }));
  const [retryNonce, setRetryNonce] = useState(0);
  // Browser publishing (WHIP) settings and runtime state.
  const [publishSource, setPublishSource] = useState<PublishSource>('camera');
  const [publishResolution, setPublishResolution] = useState<PublishResolutionKey>('720p');
  const [publishFps, setPublishFps] = useState<number>(30);
  const [publishTitle, setPublishTitle] = useState('');
  const [publishOverlay, setPublishOverlay] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<RtcStatus>(() => (window.isSecureContext
    ? { text: '未开播：选择视频源、分辨率与帧率后点击「开始开播」', tone: 'idle' }
    : { text: '浏览器推流需要 HTTPS：当前页面不是安全上下文，开播按钮已禁用（观看、WHEP 与弹幕不受影响）', tone: 'warn' }));
  // Cover image: compressed locally, uploaded after the stream is created.
  const [cover, setCover] = useState<PreparedCover | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState('');
  const [lastCreated, setLastCreated] = useState<LastCreatedStream | null>(null);
  // Live2D loader input (persisted between visits).
  const [live2dInput, setLive2dInput] = useState(() => localStorage.getItem('live2d.modelUrl') || '');
  const live2dState = useLive2DState();
  const secureContext = window.isSecureContext;
  const video = useRef<HTMLVideoElement>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const live2dHost = useRef<HTMLDivElement>(null);
  const publisher = useRef<Publisher | null>(null);
  const publishReleaseRef = useRef<(() => void) | null>(null);
  const chatSocket = useRef<WebSocket | null>(null);
  const playbackTeardown = useRef<(() => void) | null>(null);
  const rtcToneRef = useRef<RtcTone>('idle');
  const chatEnd = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const r = await fetch(`${API}/api/streams`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setStreams(Array.isArray(data) ? data.filter((s: LiveStream) => s.is_live === true && !!s.whepPath) : []);
    } catch (e: any) {
      setMessage(`无法读取直播列表：${e?.message || '请检查后端地址'}`);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep the Live2D canvas attached to the panel when it mounts.
  useEffect(() => {
    attachLive2DPanel(live2dHost.current);
  }, [live2dState.hasModel]);

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

    const status = (text: string, tone: RtcTone) => {
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
      status(authToken
        ? '在右侧大厅选择一间正在直播的房间开始观看'
        : '未登录：观看直播需要先登录，登录后通过 WHEP 实时播放', 'idle');
      return;
    }
    if (!element) return;

    playbackTeardown.current = release;
    setRtcStatus({ text: '正在建立 WHEP 连接…', tone: 'info' });

    pc = new RTCPeerConnection({
      // SRS publishes a public ICE candidate; STUN helps clients behind NAT discover their public mapping.
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // End-of-stream watchdog. SRS can keep a WHEP PeerConnection open after the publisher
    // stops, so no track-end or connection-state event arrives. A MediaStream's currentTime
    // keeps advancing even when no frames are decoded, so watch decoded/presented video
    // frames instead: rVFC where available, totalVideoFrames otherwise.
    const markFrameProgress = () => {
      lastFrameAt = Date.now();
      if (stalled) {
        stalled = false;
        status('直播画面已恢复', 'ok');
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
        status('直播画面已停止更新超过 10 秒：主播可能已停止推流，可重新加入房间', 'warn');
      }
    }, 2000);

    // After media was flowing, "connection failed" usually means the stream ended rather
    // than a firewall problem, so word the message accordingly.
    const connectionFailureText = (layer: 'WebRTC' | 'ICE') => (receivedTrack
      ? `${layer} 连接中断：直播可能已结束；若主播仍在推流，请检查服务器 UDP 8000 / TCP 8000 与 CANDIDATE 配置`
      : `${layer} 连接失败：请确认服务器 UDP 8000 / TCP 8000 已放行，且 CANDIDATE 配置为公网 IP`);

    const startPlayback = async () => {
      if (closed || !element) return;
      try {
        await element.play();
        if (!closed) status('WebRTC 播放中：已通过 WHEP 接收音视频', 'ok');
      } catch {
        // Autoplay with sound is often blocked; retry muted so the picture still shows.
        element.muted = true;
        mutedByFallback = true;
        try {
          await element.play();
          if (!closed) status('浏览器阻止了带声音的自动播放，已静音播放；可在播放器上取消静音', 'warn');
        } catch {
          if (!closed) status('媒体已到达，请点击视频上的播放按钮开始播放', 'warn');
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
          status('远端媒体流已结束：主播可能已停止推流，可重新加入房间或点击重新连接', 'warn');
        }
      };
      if (!receivedTrack) {
        receivedTrack = true;
        status('已收到音视频轨道，正在播放…', 'info');
      }
      void startPlayback();
    };

    pc.onconnectionstatechange = () => {
      if (closed || !pc) return;
      switch (pc.connectionState) {
        case 'connected':
          status('WebRTC 已连接', 'ok');
          break;
        case 'disconnected':
          status('WebRTC 连接中断，正在尝试恢复…', 'warn');
          break;
        case 'failed':
          status(connectionFailureText('WebRTC'), 'error');
          break;
        case 'closed':
          break;
        default:
          status(`WebRTC：${pc.connectionState}`, 'info');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (closed || !pc) return;
      switch (pc.iceConnectionState) {
        case 'checking':
          status('正在建立 ICE 连接…', 'info');
          break;
        case 'connected':
        case 'completed':
          status('ICE 已联通，正在接收媒体…', 'ok');
          break;
        case 'disconnected':
          status('ICE 连接中断，正在尝试恢复…', 'warn');
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
          status('ICE 候选收集超时（12 秒），已用已收集的候选继续协商…', 'warn');
        }

        const response = await fetch(`${API}/api/streams/${streamId}/whep`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
          body: pc.localDescription?.sdp || offer.sdp,
          signal: controller.signal,
        });
        const answer = await response.text();
        if (closed) return;
        if (!response.ok) throw new Error(describeWhepFailure(response.status, answer));
        if (!looksLikeSdp(answer)) throw new Error('媒体服务器返回的 SDP Answer 无效（可能被网关拦截或 SRS 异常）');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        if (closed) return;
        status('WHEP 信令完成，等待音视频轨道…', 'info');
        mediaTimer = window.setTimeout(() => {
          if (closed || receivedTrack) return;
          status('信令已完成，但 15 秒内未收到音视频轨道：请确认主播端仍在推流，且 ICE 没有被网络阻断', 'warn');
        }, 15000);
      } catch (error: any) {
        if (closed) return;
        if (error?.name === 'AbortError') return;
        status(`WebRTC 播放失败：${error?.message || '未知错误'}`, 'error');
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
      setChatState('选择一间正在直播的房间加入弹幕');
      return;
    }
    const wsBase = API ? API.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    const socket = new WebSocket(`${wsBase}/ws/chat`);
    chatSocket.current = socket;
    let disposed = false;
    setChatMessages([]);
    setChatState('正在连接弹幕…');
    socket.onopen = () => { if (!disposed) socket.send(JSON.stringify({ type: 'auth', token, streamId: chatStreamId })); };
    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ready') { setChatMessages(data.messages || []); setChatState('实时弹幕已连接'); }
        else if (data.type === 'message') setChatMessages((prev) => [...prev, data.message].slice(-100));
        else if (data.type === 'warning' || data.type === 'error') setChatState(data.message || '弹幕异常');
      } catch { /* Ignore malformed server messages. */ }
    };
    // Ignore close/error events fired by a socket we already abandoned, so a stale
    // "disconnected" message cannot overwrite the state of the room we just joined.
    socket.onclose = (event) => { if (!disposed) setChatState(event.code === 4403 ? '直播间已关闭或账号不可用' : '弹幕连接已断开'); };
    socket.onerror = () => { if (!disposed) setChatState('弹幕连接失败'); };
    return () => {
      disposed = true;
      socket.close();
      if (chatSocket.current === socket) chatSocket.current = null;
    };
  }, [chatStreamId, token]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chatMessages]);

  // Keep the latest publish teardown reachable from the unmount cleanup, and release
  // the camera/screen capture whenever this page is torn down.
  useEffect(() => {
    publishReleaseRef.current = () => releasePublisher();
  });
  useEffect(() => () => { publishReleaseRef.current?.(); }, []);

  async function auth(path: 'login' | 'register') {
    try {
      const r = await fetch(`${API}/api/auth/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      if (path === 'login') {
        setToken(data.token);
        localStorage.setItem('token', data.token);
        const name = data?.user?.username || username;
        setUsername(name);
        localStorage.setItem('username', name);
      }
      setMessage(path === 'login' ? '登录成功' : '注册成功，请登录');
    } catch (error: any) { setMessage(error.message); }
  }

  async function create() {
    if (!token) { setMessage('请先登录'); return; }
    const title = `${username || '用户'}的直播`;
    try {
      const response = await fetch(`${API}/api/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const id = Number(data?.id);
      if (Number.isSafeInteger(id) && id > 0) setLastCreated({ id, title, coverUrl: null });
      setMessage(`直播间创建成功${Number.isSafeInteger(id) && id > 0 ? `（#${id}）` : ''}。现在可直接在「浏览器开播」卡片开始推流，或在 Android 客户端开播。\n传输协议：${data?.transport}`);
      await load();
    } catch (error: any) { setMessage(error.message); }
  }

  /** Compress the selected cover into a <=2MB JPEG data URL. */
  async function handleCoverFile(file: File | undefined) {
    if (!file) return;
    setCoverBusy(true);
    setCoverError('');
    try {
      const prepared = await prepareCover(file);
      setCover(prepared);
    } catch (error: any) {
      setCover(null);
      setCoverError(error?.message || '封面处理失败，请换一张图片');
    } finally {
      setCoverBusy(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  }

  /** Upload the prepared cover to the most recently created stream. */
  async function uploadCoverToLastCreated() {
    if (!token) { setCoverError('请先登录'); return; }
    if (!lastCreated) { setCoverError('请先创建直播间'); return; }
    if (!cover) { setCoverError('请先选择封面图片'); return; }
    setCoverBusy(true);
    setCoverError('');
    try {
      const coverUrl = await uploadCover(API, token, lastCreated.id, cover.dataUrl);
      setLastCreated({ ...lastCreated, coverUrl });
      setMessage(`封面已上传到直播间 #${lastCreated.id}\n封面地址：${resolveAssetUrl(API, coverUrl)}`);
      await load();
    } catch (error: any) {
      setCoverError(error?.message || '封面上传失败');
    } finally {
      setCoverBusy(false);
    }
  }

  /**
   * Idempotent browser-publish teardown: aborts the in-flight WHIP request and
   * ICE gathering, closes the PeerConnection, stops every local capture track and
   * clears the preview. Called by stop, by track-end auto-stop and by unmount.
   */
  function releasePublisher(notice?: RtcStatus) {
    const runtime = publisher.current;
    publisher.current = null;
    if (runtime) {
      try { runtime.controller.abort(); } catch { /* already aborted */ }
      if (runtime.pc) {
        runtime.pc.onconnectionstatechange = null;
        runtime.pc.oniceconnectionstatechange = null;
        try { runtime.pc.close(); } catch { /* already closed */ }
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
      stopCaptureTracks(runtime.stream);
    }
    const preview = previewVideo.current;
    if (preview && preview.srcObject) preview.srcObject = null;
    setPublishing(false);
    if (notice) setPublishStatus(notice);
  }

  function stopPublish(notice = '已停止推流：本地预览已关闭，PeerConnection、音视频轨道与摄像头/屏幕采集均已释放') {
    if (!publisher.current) {
      setPublishing(false);
      if (previewVideo.current?.srcObject) previewVideo.current.srcObject = null;
      return;
    }
    releasePublisher({ text: '已停止开播：本地预览与音视频采集已释放', tone: 'idle' });
    setMessage(notice);
    // SRS calls on_unpublish when the PeerConnection closes; refresh the lobby.
    void load();
  }

  /**
   * Switch the Live2D overlay on/off for a publish session that is already live.
   * Only the video track is replaced; audio keeps flowing from the capture device.
   */
  async function applyPublisherOverlay(enabled: boolean) {
    const runtime = publisher.current;
    if (!runtime || !runtime.pc || !runtime.stream) return;
    const videoSender = runtime.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (!videoSender) return;
    if (!enabled) {
      const original = runtime.originalVideoTrack;
      if (original && original.readyState === 'live') {
        try { await videoSender.replaceTrack(original); } catch { /* keep composite if swap fails */ }
      }
      if (runtime.composite) {
        runtime.composite.stop();
        runtime.composite = null;
      }
      if (runtime.sourceVideo) {
        runtime.sourceVideo.srcObject = null;
        runtime.sourceVideo.remove();
        runtime.sourceVideo = null;
      }
      if (previewVideo.current) previewVideo.current.srcObject = runtime.stream;
      setPublishStatus({ text: '已关闭 Live2D 叠加：推流恢复原始画面，音频保持不变', tone: 'info' });
      return;
    }
    const modelCanvas = getLive2DCanvas();
    if (!modelCanvas) {
      setPublishStatus({
        text: '尚未加载 Live2D 模型：推流保持原始画面。请先在「Live2D 看板娘」面板加载模型，再开启叠加。',
        tone: 'warn',
      });
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
          const done = () => { source?.removeEventListener('loadeddata', done); window.clearTimeout(timer); resolve(); };
          const timer = window.setTimeout(done, 2000);
          source.addEventListener('loadeddata', done);
        });
      }
      if (runtime.composite) {
        runtime.composite.stop();
        runtime.composite = null;
      }
      const handle = createOverlayStream(source, { width: 1280, height: 720, fps: runtime.fps });
      runtime.composite = handle;
      const track = handle.stream.getVideoTracks()[0];
      if (!track) throw new Error('合成画布没有生成视频轨');
      await videoSender.replaceTrack(track);
      if (previewVideo.current) previewVideo.current.srcObject = handle.stream;
      setPublishStatus({ text: '已开启 Live2D 叠加：观众看到的画面已合成看板娘，音频保持不变', tone: 'ok' });
    } catch (error: any) {
      setPublishStatus({ text: `开启 Live2D 叠加失败：${error?.message || '未知错误'}`, tone: 'error' });
    }
  }

  /** Toggle the overlay preference; hot-swaps tracks when already publishing. */
  function togglePublishOverlay(next: boolean) {
    setPublishOverlay(next);
    if (publisher.current?.pc) void applyPublisherOverlay(next);
    else if (next && !live2dState.hasModel) {
      setPublishStatus({ text: '尚未加载 Live2D 模型：开播时会保持原始画面；加载模型后可再开启叠加', tone: 'warn' });
    }
  }

  async function startPublish() {
    if (publishing || publisher.current) return;
    if (!token) {
      setPublishStatus({ text: '开播需要先登录：请在上方登录或注册账号后重试', tone: 'warn' });
      return;
    }
    if (!window.isSecureContext) {
      setPublishStatus({ text: '浏览器推流需要 HTTPS：当前页面不是安全上下文，无法访问摄像头/屏幕采集', tone: 'error' });
      return;
    }
    const devices = navigator.mediaDevices;
    const source = publishSource;
    if (!devices || typeof devices.getUserMedia !== 'function') {
      setPublishStatus({ text: '当前浏览器不支持 WebRTC 媒体采集，请更换新版 Chrome / Edge / Safari', tone: 'error' });
      return;
    }
    if (source === 'screen' && typeof devices.getDisplayMedia !== 'function') {
      setPublishStatus({ text: '当前浏览器不支持屏幕共享（getDisplayMedia），请改用「摄像头」视频源', tone: 'error' });
      return;
    }
    const resolution = PUBLISH_RESOLUTIONS.find((item) => item.key === publishResolution) ?? PUBLISH_RESOLUTIONS[0];
    const fps = publishFps;
    const wantedOverlay = publishOverlay;
    const preparedCover = cover;
    const title = publishTitle.trim() || `${username || '用户'}的直播`;
    const controller = new AbortController();
    const runtime: Publisher = {
      controller,
      stream: null,
      pc: null,
      fps,
      originalVideoTrack: null,
      composite: null,
      sourceVideo: null,
    };
    publisher.current = runtime;
    setPublishing(true);
    setPublishStatus({ text: '正在创建直播间…', tone: 'info' });
    try {
      // 1. Create the stream record on the backend and get its WHIP publish path.
      const response = await fetch(`${API}/api/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (publisher.current !== runtime) return;
      if (!response.ok) throw new Error(data?.error || `创建直播间失败（HTTP ${response.status}）`);
      const streamId = Number(data?.id);
      const publishPath = typeof data?.publishPath === 'string' && data.publishPath
        ? data.publishPath
        : (Number.isSafeInteger(streamId) && streamId > 0 ? `/api/streams/${streamId}/whip` : '');
      if (!Number.isSafeInteger(streamId) || streamId < 1 || !publishPath) {
        throw new Error('创建直播间响应缺少 id 或 publishPath');
      }

      // 2. Upload the compressed cover (if selected) before going live.
      let uploadedCoverUrl: string | null = null;
      let coverNote = '';
      if (preparedCover) {
        setPublishStatus({ text: '直播间已创建，正在上传封面…', tone: 'info' });
        try {
          uploadedCoverUrl = await uploadCover(API, token, streamId, preparedCover.dataUrl);
          coverNote = `\n封面已上传：${resolveAssetUrl(API, uploadedCoverUrl)}`;
        } catch (error: any) {
          coverNote = `\n封面上传失败：${error?.message || '未知错误'}`;
          setCoverError(error?.message || '封面上传失败');
        }
        if (publisher.current !== runtime) return;
      }
      setLastCreated({ id: streamId, title, coverUrl: uploadedCoverUrl });

      // 3. Capture camera or screen with ideal resolution/frame-rate constraints.
      setPublishStatus({
        text: source === 'screen' ? '请在弹出的窗口中选择要共享的屏幕…' : '正在请求摄像头与麦克风权限…',
        tone: 'info',
      });
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: resolution.width },
        height: { ideal: resolution.height },
        frameRate: { ideal: fps },
      };
      const capture = source === 'screen'
        ? await devices.getDisplayMedia({ video: videoConstraints, audio: true })
        : await devices.getUserMedia({ video: videoConstraints, audio: true });
      runtime.stream = capture;
      if (publisher.current !== runtime) { stopCaptureTracks(capture); return; }
      runtime.originalVideoTrack = capture.getVideoTracks()[0] ?? null;

      // 4. Optional Live2D compositing: a hidden <video> feeds the overlay canvas.
      let overlayNote = '';
      if (wantedOverlay) {
        if (!getLive2DCanvas()) {
          overlayNote = '\n未加载 Live2D 模型：本次开播保持原始画面。';
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
            overlayNote = `\nLive2D 叠加不可用（${error?.message || '未知错误'}）：本次开播保持原始画面。`;
          }
        }
      }

      const preview = previewVideo.current;
      if (preview) {
        preview.srcObject = runtime.composite?.stream ?? capture;
        preview.muted = true;
        void preview.play().catch(() => undefined);
      }

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
      // the device; stop the publish session too. The raw track stays alive even
      // while a composite video track is being sent.
      runtime.originalVideoTrack?.addEventListener('ended', () => {
        if (publisher.current !== runtime) return;
        releasePublisher({
          text: source === 'screen'
            ? '屏幕共享已结束，推流已自动停止（SRS 会收到 on_unpublish）'
            : '摄像头视频轨已结束，推流已自动停止',
          tone: 'warn',
        });
        setMessage(source === 'screen' ? '屏幕共享已结束：浏览器开播已自动停止。' : '摄像头视频轨已结束：浏览器开播已自动停止。');
        void load();
      });
      preferH264(pc);
      pc.onconnectionstatechange = () => {
        if (publisher.current !== runtime) return;
        switch (pc.connectionState) {
          case 'connected':
            setPublishStatus({ text: '推流已连接：SRS 正在转发你的音视频', tone: 'ok' });
            break;
          case 'disconnected':
            setPublishStatus({ text: '推流连接中断，正在尝试恢复…', tone: 'warn' });
            break;
          case 'failed':
            setPublishStatus({ text: '推流连接失败：请检查服务器 UDP/TCP 8000 与 CANDIDATE 配置后重新开播', tone: 'error' });
            break;
          default:
            break;
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (publisher.current !== runtime) return;
        switch (pc.iceConnectionState) {
          case 'checking':
            setPublishStatus({ text: '正在建立 ICE 连接…', tone: 'info' });
            break;
          case 'connected':
          case 'completed':
            setPublishStatus({ text: 'ICE 已联通，浏览器推流中', tone: 'ok' });
            break;
          case 'failed':
            setPublishStatus({ text: 'ICE 连接失败：请确认服务器 UDP 8000 / TCP 8000 已放行且 CANDIDATE 为公网 IP', tone: 'error' });
            break;
          default:
            break;
        }
      };

      const offer = await pc.createOffer();
      if (publisher.current !== runtime) return;
      await pc.setLocalDescription(offer);
      if (publisher.current !== runtime) return;
      setPublishStatus({ text: '正在收集 ICE 候选（通常 1-12 秒）…', tone: 'info' });
      const gathering = await waitForIceGathering(pc, controller.signal, 12000);
      if (publisher.current !== runtime) return;
      if (gathering === 'timeout') {
        setPublishStatus({ text: 'ICE 候选收集超时（12 秒），已用已收集的候选继续协商…', tone: 'warn' });
      }

      // 6. POST the offer to the authenticated WHIP proxy; the answer completes the session.
      const whipResponse = await fetch(`${API}${publishPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/sdp',
          Accept: 'application/sdp',
        },
        body: pc.localDescription?.sdp || offer.sdp,
        signal: controller.signal,
      });
      const answer = await whipResponse.text();
      if (publisher.current !== runtime) return;
      if (!whipResponse.ok) throw new Error(describeWhipFailure(whipResponse.status, answer));
      if (!looksLikeSdp(answer)) throw new Error('媒体服务器返回的 SDP Answer 无效（可能被网关拦截或 SRS 异常）');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (publisher.current !== runtime) return;
      const overlayLabel = runtime.composite ? ' · Live2D 叠加' : '';
      setPublishStatus({
        text: `推流中：#${streamId} · ${resolution.label} · ${fps}fps · ${source === 'screen' ? '屏幕共享' : '摄像头 + 麦克风'}${overlayLabel}`,
        tone: 'ok',
      });
      setMessage(
        `浏览器开播已启动：直播间 #${streamId}（${title}）\n`
        + `推流地址：${API}${publishPath}\n`
        + `画面：${resolution.label} · ${fps}fps · ${source === 'screen' ? '屏幕共享' : '摄像头 + 麦克风'}${overlayLabel}`
        + coverNote + overlayNote,
      );
      await load();
    } catch (error: any) {
      if (publisher.current !== runtime) return;
      const aborted = error?.name === 'AbortError' || controller.signal.aborted;
      if (aborted) {
        releasePublisher({ text: '已停止开播：本地预览与音视频采集已释放', tone: 'idle' });
        return;
      }
      const text = PUBLISH_MEDIA_ERRORS.includes(String(error?.name))
        ? describeMediaFailure(error, source)
        : `浏览器开播失败：${error?.message || '未知错误'}`;
      releasePublisher({ text, tone: 'error' });
      setMessage(`${text}\n如果直播间已创建但推流失败，可重试；成功后大厅会显示该直播间。`);
    }
  }

  function joinRoom(stream: LiveStream) {
    if (!token) { setMessage('观看直播需要登录：请先在上方登录，再进入房间观看 WHEP 直播并发送弹幕'); return; }
    setChatStreamId(stream.id);
    setChatState(`正在加入：${stream.title}`);
  }

  function leaveRoom() {
    // Closes the PeerConnection and detaches the video immediately, then resets state.
    playbackTeardown.current?.();
    playbackTeardown.current = null;
    chatSocket.current?.close();
    chatSocket.current = null;
    if (video.current) {
      video.current.srcObject = null;
      video.current.muted = false;
    }
    setChatStreamId(null);
  }

  function logout() {
    stopPublish('已退出登录，浏览器推流已停止');
    leaveRoom();
    setToken('');
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    setMessage('已退出登录');
  }

  function sendChat(event: React.FormEvent) {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content) return;
    if (!token) { setChatState('请先登录'); return; }
    if (chatSocket.current?.readyState !== WebSocket.OPEN) { setChatState('弹幕尚未连接，请重新加入房间'); return; }
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

  const selected = streams.find((stream) => stream.id === chatStreamId);
  const canRetry = !!chatStreamId && (rtcStatus.tone === 'error' || rtcStatus.tone === 'warn');
  const live2dLoading = live2dState.phase === 'core' || live2dState.phase === 'model';
  const live2dTone: RtcTone = live2dState.phase === 'ready'
    ? 'ok'
    : live2dState.phase === 'error'
      ? 'error'
      : live2dLoading
        ? 'info'
        : 'idle';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="葱直播首页">
            <span className="brand-mark" aria-hidden="true">葱</span>
            <span className="brand-text">葱直播<small>CONGLIVE</small></span>
          </a>
          <nav className="topnav" aria-label="页面导航">
            <a href="#lobby">直播大厅</a>
            <a href="#watch">观看</a>
            <a href="#publish">开播</a>
            <a href="#live2d">Live2D</a>
            <a href="#chat">弹幕</a>
          </nav>
          <div className="top-actions">
            <span className={`conn-pill ${token ? 'online' : ''}`}>
              <i aria-hidden="true" />
              {token ? (username || '已登录') : '未登录'}
            </span>
            {token
              ? <button type="button" className="ghost small" onClick={logout}>退出登录</button>
              : <a className="button small" href="#auth">登录 / 注册</a>}
          </div>
        </div>
      </header>

      <main className="page" id="top">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">WEBRTC · ULTRA LOW LATENCY</span>
            <h1>分享你的实时世界<span>低延迟 · 高互动</span></h1>
            <p className="hero-lead">
              浏览器里的实时直播：WHEP 低延迟观看、WHIP 一键开播、实时弹幕，
              还能让 Live2D 看板娘陪你一起出镜。
            </p>
            <div className="hero-badges">
              <span>WHEP 观看</span>
              <span>WHIP 开播</span>
              <span>Live2D 叠加</span>
              <span>实时弹幕</span>
            </div>
          </div>
          <div className="auth-card" id="auth">
            {token ? (
              <div className="signed-in">
                <span className="eyebrow">SIGNED IN</span>
                <h2>{username || '已登录用户'}</h2>
                <p className="hint">令牌已保存在本机，可以观看直播、发送弹幕，并直接在浏览器开播。</p>
                <div className="auth-actions">
                  <button type="button" className="secondary" onClick={() => void create()}>创建直播间</button>
                  <button type="button" className="ghost" onClick={logout}>退出登录</button>
                </div>
                {lastCreated && (
                  <p className="hint">最近创建：#{lastCreated.id} · {lastCreated.title}</p>
                )}
              </div>
            ) : (
              <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void auth('login'); }}>
                <span className="eyebrow">登录后开始</span>
                <h2>欢迎回来</h2>
                <label className="field">
                  用户名
                  <input
                    value={username}
                    autoComplete="username"
                    placeholder="用户名"
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label className="field">
                  密码
                  <input
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    placeholder="密码（至少 8 位）"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <div className="auth-actions">
                  <button type="submit">登录</button>
                  <button type="button" className="secondary" onClick={() => void auth('register')}>注册</button>
                </div>
                <p className="hint">观看直播需要登录；注册后即可进入大厅观看并发送弹幕。</p>
              </form>
            )}
          </div>
        </section>

        {message && <pre className="message" role="status" aria-live="polite">{message}</pre>}

        <div className="main-grid">
          <section className="panel watch-panel" id="watch">
            <div className="panel-head">
              <div>
                <span className="eyebrow">WHEP PLAYER</span>
                <h2>WebRTC 直播观看</h2>
              </div>
              <span className={`status-dot ${rtcStatus.tone}`}>
                <i aria-hidden="true" />{selected ? selected.title : '等待选择房间'}
              </span>
            </div>
            <div className={`player ${chatStreamId ? 'has-stream' : ''}`}>
              <video
                ref={video}
                controls
                autoPlay
                playsInline
                aria-label="直播画面"
                onClick={() => { void video.current?.play().catch(() => undefined); }}
              />
              {!chatStreamId && (
                <div className="player-empty">
                  <span className="player-empty-icon" aria-hidden="true">▶</span>
                  <p>{token ? '从直播大厅选择一间正在直播的房间' : '登录后即可观看 WHEP 实时直播'}</p>
                </div>
              )}
            </div>
            <div className="playrow">
              <p className={`hint rtc-status ${rtcStatus.tone}`} role="status" aria-live="polite">{rtcStatus.text}</p>
              {canRetry && (
                <button type="button" className="secondary small" onClick={() => setRetryNonce((value) => value + 1)}>
                  重新连接
                </button>
              )}
            </div>
            <p className="hint">加入直播间后通过 WHEP 与 SRS 建立 WebRTC 连接；不再使用 HLS 或 HTTP-FLV 播放直播。</p>
          </section>

          <aside className="panel lobby-panel" id="lobby">
            <div className="panel-head">
              <div>
                <span className="eyebrow">LIVE NOW</span>
                <h2>直播大厅 <span className="count">{streams.length}</span></h2>
              </div>
              <button type="button" className="secondary small" onClick={() => void load()}>刷新列表</button>
            </div>
            <p className="hint">仅展示正在直播且提供 WHEP 播放地址的房间。</p>
            {!token && <p className="hint warn-text">未登录：观看直播需要先登录。登录后即可进入房间观看并发送弹幕。</p>}
            {streams.length === 0 ? (
              <div className="lobby-empty">
                <span className="lobby-empty-mark" aria-hidden="true">LIVE</span>
                <p>当前没有正在直播的房间</p>
                <small>主播在浏览器开播后，这里会自动出现直播卡片。</small>
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
                      onClick={() => joinRoom(stream)}
                      aria-label={`观看 ${stream.title}`}
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
                        <span className="live-badge"><i aria-hidden="true" />直播中</span>
                      </div>
                      <div className="live-meta">
                        <b>{stream.title}</b>
                        <span className="live-owner">主播：{stream.username}</span>
                        <span className="live-cta">{token ? '观看 / 弹幕 →' : '登录后观看 →'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>
        </div>

        <section className="panel publish-panel" id="publish">
          <div className="panel-head">
            <div>
              <span className="eyebrow">BROWSER PUBLISH · WHIP</span>
              <h2>浏览器开播</h2>
              <p className="hint">
                本页直接用摄像头或屏幕推流给 SRS，观众仍通过 WHEP 观看；停止后 SRS 收到 on_unpublish，直播间自动下线。
              </p>
            </div>
            <span className={`state-pill ${publishing ? 'ok' : 'idle'}`}>{publishing ? '推流中' : '未开播'}</span>
          </div>
          <div className="publish-grid">
            <div className="publish-form">
              <div className="field-row">
                <label className="field">视频源
                  <select value={publishSource} disabled={publishing} onChange={(e) => setPublishSource(e.target.value as PublishSource)}>
                    <option value="camera">摄像头 + 麦克风</option>
                    <option value="screen">屏幕共享</option>
                  </select>
                </label>
                <label className="field">分辨率
                  <select value={publishResolution} disabled={publishing} onChange={(e) => setPublishResolution(e.target.value as PublishResolutionKey)}>
                    {PUBLISH_RESOLUTIONS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                  </select>
                </label>
                <label className="field">帧率
                  <select value={publishFps} disabled={publishing} onChange={(e) => setPublishFps(Number(e.target.value))}>
                    {PUBLISH_FPS.map((value) => <option key={value} value={value}>{value} fps</option>)}
                  </select>
                </label>
              </div>
              <label className="field">直播标题（可选）
                <input
                  value={publishTitle}
                  maxLength={120}
                  disabled={publishing}
                  placeholder={`${username || '用户'}的直播`}
                  onChange={(e) => setPublishTitle(e.target.value)}
                />
              </label>

              <div className="cover-field">
                <div className="cover-field-head">
                  <span>直播封面（可选）</span>
                  <small>选图后自动压缩到 2MB 以内的 JPEG dataURL，开播时上传</small>
                </div>
                <div className="cover-picker">
                  <div className="cover-thumb" style={cover ? undefined : { background: 'linear-gradient(135deg,#1d2742,#121a2e)' }}>
                    {cover ? (
                      <img src={cover.dataUrl} alt="封面预览" />
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
                      {coverBusy ? '处理中…' : cover ? '更换图片' : '选择图片'}
                    </button>
                    {cover && (
                      <>
                        <button type="button" className="ghost small" disabled={publishing} onClick={() => { setCover(null); setCoverError(''); }}>
                          移除
                        </button>
                        <span className="hint">{describeCoverSize(cover)}</span>
                      </>
                    )}
                  </div>
                </div>
                {coverError && <p className="hint err-text" role="status">{coverError}</p>}
                {!coverError && cover && cover.bytes <= MAX_COVER_BYTES && (
                  <p className="hint">开播时会先创建直播间、上传封面，再开始推流；上传失败不会影响开播。</p>
                )}
                {lastCreated && cover && (
                  <p className="hint">
                    已创建直播间 #{lastCreated.id}
                    <button
                      type="button"
                      className="link-button"
                      disabled={coverBusy || publishing}
                      onClick={() => void uploadCoverToLastCreated()}
                    >
                      上传封面到该直播间
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
                  叠加 Live2D 看板娘
                  <small>
                    {live2dState.hasModel
                      ? '开播时把摄像头/屏幕画面与模型画布合成，只替换视频轨，音频保留'
                      : '尚未加载模型：开播将保持原始画面，可先到 Live2D 面板加载模型'}
                  </small>
                </span>
              </label>

              <div className="publish-actions">
                <button type="button" onClick={() => void startPublish()} disabled={!secureContext || publishing}>
                  {publishing ? '推流中…' : '开始开播'}
                </button>
                <button type="button" className="secondary" onClick={() => stopPublish()} disabled={!publishing}>停止推流</button>
                <a className="button ghost small" href="#live2d">配置 Live2D</a>
              </div>
              {!secureContext && (
                <p className="hint warn-text">
                  浏览器推流需要 HTTPS：当前页面不是安全上下文（http://IP 访问），开播按钮已禁用；观看、WHEP 播放与弹幕不受影响，请改用 https:// 域名访问后开播。
                </p>
              )}
              <p className={`hint rtc-status ${publishStatus.tone}`} role="status" aria-live="polite">{publishStatus.text}</p>
              <p className="hint">开播流程：创建直播间 → 上传封面（可选）→ 采集音视频 → 合成 Live2D（可选）→ WHIP 协商（SDP offer/answer）→ SRS 推流。</p>
            </div>
            <div className="publish-preview">
              <div className={`player preview ${publishing ? 'has-stream' : ''}`}>
                <video ref={previewVideo} muted autoPlay playsInline aria-label="本地预览" />
                {!publishing && (
                  <div className="player-empty">
                    <span className="player-empty-icon" aria-hidden="true">◉</span>
                    <p>本地预览</p>
                  </div>
                )}
              </div>
              <p className="hint">{publishing
                ? '本地预览：只在本机显示；开启 Live2D 叠加后显示合成后的画面'
                : secureContext
                  ? '本地预览：点击「开始开播」后显示画面'
                  : '浏览器推流需要 HTTPS，无法获取本地预览'}</p>
            </div>
          </div>
        </section>

        <div className="lower-grid">
          <section className="panel live2d-panel" id="live2d">
            <div className="panel-head">
              <div>
                <span className="eyebrow">LIVE2D WIDGET</span>
                <h2>Live2D 看板娘</h2>
                <p className="hint">输入 Cubism 3/4/5 模型（.model3.json）地址加载，模型与 Cubism Core 都从网络加载，不内置任何模型。</p>
              </div>
              <span className={`state-pill ${live2dTone}`}>{live2dPhaseLabel(live2dState.phase)}</span>
            </div>
            <div className="live2d-form">
              <input
                value={live2dInput}
                onChange={(e) => setLive2dInput(e.target.value)}
                placeholder="https://example.com/model/model3.json"
                aria-label="Live2D 模型地址"
                disabled={live2dLoading}
                spellCheck={false}
              />
              <button type="button" onClick={() => void loadLive2DModel()} disabled={live2dLoading}>
                {live2dLoading ? '加载中…' : '加载看板娘'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={toggleLive2DVisible}
                disabled={!live2dState.hasModel}
              >
                {live2dState.visible ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => unloadLive2D()}
                disabled={!live2dState.hasModel}
              >
                卸载
              </button>
            </div>
            <p className={`hint rtc-status ${live2dTone}`} role="status" aria-live="polite">{live2dState.message}</p>
            <div className="live2d-stage-wrap">
              <div ref={live2dHost} className={`live2d-stage ${live2dState.visible ? '' : 'is-hidden'}`} />
              {!live2dState.hasModel && (
                <div className="live2d-placeholder" aria-hidden="true">
                  <span className="live2d-placeholder-mark" aria-hidden="true">L2D</span>
                  <p>还没有加载看板娘</p>
                  <small>支持 .model3.json；加载失败会在这里提示原因</small>
                </div>
              )}
            </div>
            <p className="hint">提示：模型服务器需要允许跨域（CORS）；开播时可在「浏览器开播」卡片勾选「叠加 Live2D 看板娘」把模型合成进直播画面。</p>
          </section>

          <section className="panel chat-panel" id="chat">
            <div className="panel-head">
              <div>
                <span className="eyebrow">LIVE CHAT</span>
                <h2>实时弹幕评论</h2>
                <p className="hint">{selected ? `当前房间：${selected.title} · ` : ''}{chatState}</p>
              </div>
              {chatStreamId && <button type="button" className="secondary small" onClick={leaveRoom}>离开房间</button>}
            </div>
            <div className="chat-messages">
              {chatMessages.length === 0
                ? <p className="hint">还没有评论，加入直播间后即可参与互动。</p>
                : chatMessages.map((m, i) => (
                  <div className="chat-line" key={`${m.id}-${i}`}>
                    <b>{m.username}</b>
                    <span>{m.content}</span>
                    <time>{new Date(m.createdAt).toLocaleTimeString()}</time>
                  </div>
                ))}
              <div ref={chatEnd} />
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                maxLength={500}
                placeholder={token ? '输入弹幕评论，最多 500 字' : '登录后加入直播间发送弹幕'}
                disabled={!token || !chatStreamId}
              />
              <button disabled={!token || !chatStreamId}>发送</button>
            </form>
          </section>
        </div>

        <footer className="footer">
          <span>葱直播 CongLive</span>
          <span>WebRTC · WHIP · WHEP · Live2D</span>
          <span>请勿直播未经授权的私人内容</span>
        </footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
