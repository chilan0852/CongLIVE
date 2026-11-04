/**
 * Mesh voice room for the standalone `/room/<id>` page.
 *
 * The backend reuses the authenticated `/ws/chat` WebSocket for signaling:
 * after the normal `auth` → `ready` handshake the client sends `voice-join`,
 * receives `voice-peers` and then builds one RTCPeerConnection per remote
 * participant (full-mesh full-duplex audio). No PeerConnection, microphone
 * capture or AudioContext is created before the user clicks "join" — the lobby
 * and a room page that never joined voice stay completely media-free.
 *
 * Teardown is exhaustive and idempotent: `leave()` (and the React unmount
 * cleanup) sends `voice-leave`, closes every PeerConnection, stops the local
 * microphone tracks, removes the hidden <audio> elements and clears all levels,
 * so switching rooms or the host ending the stream can never leak media.
 *
 * Signal types follow `backend task-7`:
 *   C→S: voice-join | voice-leave | voice-offer {target} | voice-answer {target}
 *        | voice-candidate {target, candidate|null}
 *   S→C: voice-peers {self, peers} | voice-peer-joined {peer}
 *        | voice-peer-left {peer, reason} | voice-offer/answer/candidate {from}
 *        | voice-error {code, message}
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { chatSocketUrl } from './api';
import { createLevelMeter, type LevelMeter } from './audioLevel';
import { LocalizedError, backendText, msg, rawText, type TextMessage } from './i18n';

export type VoicePeer = { peerId: string; userId: number; username: string };
export type VoicePhase = 'idle' | 'connecting' | 'joining' | 'joined' | 'error';
export type VoicePeerState = 'connecting' | 'connected' | 'failed';

export type VoiceSnapshot = {
  phase: VoicePhase;
  /** This connection's own participant record (from `voice-peers`). */
  self: VoicePeer | null;
  /** Other participants in the voice room (excluding self). */
  peers: VoicePeer[];
  /** PeerConnection state per peerId (for the participant list). */
  peerStates: Record<string, VoicePeerState>;
  muted: boolean;
  /** Smoothed microphone level 0..1; 0 while muted. */
  localLevel: number;
  /** True while a remote peer's audio is above the speech threshold. */
  speaking: Record<string, boolean>;
  error: TextMessage | null;
  /** Browser blocked remote audio autoplay; a click is needed to resume. */
  audioBlocked: boolean;
};

export const INITIAL_VOICE_SNAPSHOT: VoiceSnapshot = {
  phase: 'idle',
  self: null,
  peers: [],
  peerStates: {},
  muted: false,
  localLevel: 0,
  speaking: {},
  error: null,
  audioBlocked: false,
};

type PeerConnectionState = {
  info: VoicePeer;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  audio: HTMLAudioElement | null;
  meter: LevelMeter | null;
  pendingCandidates: Array<RTCIceCandidateInit | null>;
  /** Serializes SDP offer/answer handling for this peer (avoids glare). */
  chain: Promise<void>;
};

export type VoiceClientOptions = {
  token: string;
  streamId: number;
  onChange: (snapshot: VoiceSnapshot) => void;
  /** Container for the hidden remote <audio> elements (may be null → detached). */
  getAudioHost?: () => HTMLElement | null;
};

const SPEAKING_THRESHOLD = 0.07;
const LEVEL_TICK_MS = 150;

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Normalize a `{peerId,userId,username}` record from the server. */
function normalizePeer(raw: any): VoicePeer | null {
  if (!raw || typeof raw !== 'object') return null;
  const peerId = typeof raw.peerId === 'string' ? raw.peerId : '';
  if (!peerId) return null;
  return {
    peerId,
    userId: finiteNumber(raw.userId) ?? 0,
    username: typeof raw.username === 'string' ? raw.username : '',
  };
}

/** Extract the SDP text from a string or `{type, sdp}` object. */
function sdpText(raw: any): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.sdp === 'string') return raw.sdp;
  return '';
}

/** Explain microphone capture failures with dedicated voice-room messages. */
function describeMicFailure(error: any): TextMessage {
  const name = String(error?.name || '');
  const detail: TextMessage = error?.message ? rawText(String(error.message)) : msg('common.unknownError');
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return msg('voice.error.micDenied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return msg('voice.error.micNotFound');
    case 'NotReadableError':
      return msg('voice.error.micBusy');
    case 'NotSupportedError':
      return msg('voice.error.micUnsupported');
    default:
      return msg('voice.error.micFailed', { detail });
  }
}

function closeError(code: number): TextMessage {
  switch (code) {
    case 4401:
      return msg('voice.error.auth');
    case 4403:
      return msg('voice.error.unavailable');
    default:
      return msg('voice.error.disconnected');
  }
}

/** Map a server `voice-error` code to a translatable message. */
function signalError(data: any): TextMessage {
  switch (String(data?.code || '')) {
    case 'not-joined':
      return msg('voice.error.notJoined');
    case 'target-not-found':
      return msg('voice.error.targetLeft');
    case 'invalid-payload':
    case 'invalid-target':
      return msg('voice.error.invalidSignal');
    case 'sdp-too-long':
    case 'candidate-too-long':
      return msg('voice.error.signalTooLarge');
    case 'rate-limited':
      return msg('voice.error.rateLimited');
    default:
      return typeof data?.message === 'string' && data.message
        ? backendText(data.message)
        : msg('voice.error.signal');
  }
}

export class VoiceClient {
  private readonly options: VoiceClientOptions;
  private snapshot: VoiceSnapshot = INITIAL_VOICE_SNAPSHOT;
  private ws: WebSocket | null = null;
  private local: MediaStream | null = null;
  private localMeter: LevelMeter | null = null;
  private peers = new Map<string, PeerConnectionState>();
  private self: VoicePeer | null = null;
  private levelTimer: number | undefined;
  private disposed = false;
  /** True while `leave()` is running so the socket close handler stays silent. */
  private leaving = false;
  /** Bumped on every join/leave so stale async continuations can bail out. */
  private generation = 0;

  constructor(options: VoiceClientOptions) {
    this.options = options;
  }

  get state(): VoiceSnapshot {
    return this.snapshot;
  }

  private patch(patch: Partial<VoiceSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChange(this.snapshot);
  }

  private send(payload: Record<string, unknown>): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Join / leave
   * ------------------------------------------------------------------ */

  /** Join the voice room: capture the mic, connect signaling and build the mesh. */
  async join(): Promise<void> {
    if (this.disposed) return;
    if (this.snapshot.phase === 'connecting' || this.snapshot.phase === 'joining' || this.snapshot.phase === 'joined') return;
    if (!this.options.token) {
      this.patch({ phase: 'error', error: msg('voice.error.auth') });
      return;
    }
    this.teardown();
    const generation = ++this.generation;
    const muted = this.snapshot.muted;
    this.patch({
      phase: 'connecting',
      error: null,
      audioBlocked: false,
      self: null,
      peers: [],
      peerStates: {},
      speaking: {},
      localLevel: 0,
      muted,
    });
    // 1. Microphone capture only happens here — never on page load.
    let local: MediaStream;
    try {
      const devices = navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== 'function') {
        throw new LocalizedError(msg('voice.error.micUnsupported'));
      }
      local = await devices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error: any) {
      if (this.generation !== generation || this.disposed) return;
      this.patch({
        phase: 'error',
        error: error instanceof LocalizedError ? error.text : describeMicFailure(error),
      });
      return;
    }
    if (this.generation !== generation || this.disposed) {
      stopTracks(local);
      return;
    }
    this.local = local;
    for (const track of local.getAudioTracks()) track.enabled = !muted;
    this.localMeter = createLevelMeter(local);
    this.startLevelTimer();
    // 2. Signaling uses a dedicated /ws/chat connection; joining it does not
    //    affect the chat socket used for comments.
    this.openSocket(generation);
  }

  /** Leave the voice room and release everything (idempotent). */
  leave(): void {
    const wasActive = this.snapshot.phase !== 'idle';
    // Abort any in-flight join (mic permission prompt / socket opening).
    this.generation += 1;
    this.leaving = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'voice-leave' });
    this.teardown();
    this.leaving = false;
    if (wasActive) {
      this.patch({
        ...INITIAL_VOICE_SNAPSHOT,
        muted: this.snapshot.muted,
      });
    }
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted;
    if (this.local) {
      for (const track of this.local.getAudioTracks()) track.enabled = !muted;
    }
    this.patch({ muted, localLevel: muted ? 0 : this.snapshot.localLevel });
  }

  /** A user gesture can unblock remote audio playback (autoplay policy). */
  async resumeAudio(): Promise<void> {
    let blocked = false;
    for (const peer of this.peers.values()) {
      if (!peer.audio) continue;
      try {
        await peer.audio.play();
      } catch {
        blocked = true;
      }
    }
    this.patch({ audioBlocked: blocked });
  }

  /** Stop timers, close the socket and release every peer + local track. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.leaving = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'voice-leave' });
    this.teardown();
  }

  /* ------------------------------------------------------------------ *
   * Signaling
   * ------------------------------------------------------------------ */

  private openSocket(generation: number): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(chatSocketUrl());
    } catch {
      this.patch({ phase: 'error', error: msg('voice.error.connectFailed') });
      return;
    }
    this.ws = socket;
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.send({ type: 'auth', token: this.options.token, streamId: this.options.streamId });
    };
    socket.onmessage = (event) => {
      if (this.ws !== socket || this.generation !== generation) return;
      this.handleSignal(event.data);
    };
    socket.onerror = () => {
      if (this.ws !== socket) return;
      if (this.snapshot.phase === 'connecting') {
        this.patch({ phase: 'error', error: msg('voice.error.connectFailed') });
      }
    };
    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.teardown();
      if (this.leaving || this.disposed) return;
      this.patch({ phase: 'error', error: closeError(event.code) });
    };
  }

  private handleSignal(raw: unknown): void {
    let data: any;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'ready':
        this.send({ type: 'voice-join' });
        this.patch({ phase: 'joining' });
        break;
      case 'voice-peers':
        this.handlePeers(data);
        break;
      case 'voice-peer-joined': {
        const peer = normalizePeer(data.peer);
        if (peer && peer.peerId !== this.self?.peerId) {
          this.ensurePeer(peer);
          // Glare-free mesh: only the lexicographically smaller peerId offers.
          if (this.self && this.self.peerId < peer.peerId) void this.initiateOffer(peer.peerId);
        }
        break;
      }
      case 'voice-peer-left': {
        const peer = normalizePeer(data.peer);
        if (peer) this.removePeer(peer.peerId);
        break;
      }
      case 'voice-offer':
        this.handleOffer(data);
        break;
      case 'voice-answer':
        this.handleAnswer(data);
        break;
      case 'voice-candidate':
        this.handleCandidate(data);
        break;
      case 'voice-error':
        this.patch({ error: signalError(data) });
        break;
      case 'warning':
      case 'error':
        if (typeof data.message === 'string' && data.message) {
          this.patch({ error: backendText(data.message) });
        }
        break;
      default:
        break;
    }
  }

  private handlePeers(data: any): void {
    const self = normalizePeer(data.self);
    if (self) this.self = self;
    const incoming = Array.isArray(data.peers)
      ? data.peers.map(normalizePeer).filter((peer: VoicePeer | null): peer is VoicePeer => peer !== null)
      : [];
    this.patch({ phase: 'joined', self: this.self, error: null });
    for (const peer of incoming) {
      if (peer.peerId === self?.peerId) continue;
      this.ensurePeer(peer);
      // Glare-free mesh: only the lexicographically smaller peerId sends the offer.
      if (this.self && this.self.peerId < peer.peerId) void this.initiateOffer(peer.peerId);
    }
    this.publishPeers();
  }

  private ensurePeer(info: VoicePeer): PeerConnectionState | null {
    if (!this.local) return null;
    const existing = this.peers.get(info.peerId);
    if (existing) {
      existing.info = info;
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const remoteStream = new MediaStream();
    const state: PeerConnectionState = {
      info,
      pc,
      remoteStream,
      audio: null,
      meter: null,
      pendingCandidates: [],
      chain: Promise.resolve(),
    };
    for (const track of this.local.getAudioTracks()) {
      try { pc.addTrack(track, this.local); } catch { /* track ended mid-join */ }
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : null;
      if (!candidate) return;
      this.send({ type: 'voice-candidate', target: info.peerId, candidate });
    };
    pc.ontrack = (event) => {
      const track = event.track;
      if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      track.onended = () => {
        remoteStream.removeTrack(track);
      };
      this.attachRemoteAudio(state);
    };
    pc.onconnectionstatechange = () => {
      this.updatePeerState(info.peerId);
    };
    this.peers.set(info.peerId, state);
    this.publishPeers();
    return state;
  }

  private updatePeerState(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const connection = peer.pc.connectionState;
    const next: VoicePeerState = connection === 'connected'
      ? 'connected'
      : connection === 'failed' || connection === 'closed'
        ? 'failed'
        : 'connecting';
    if (this.snapshot.peerStates[peerId] === next) return;
    this.patch({ peerStates: { ...this.snapshot.peerStates, [peerId]: next } });
  }

  private publishPeers(): void {
    const peers = Array.from(this.peers.values()).map((peer) => peer.info);
    const peerStates: Record<string, VoicePeerState> = {};
    for (const [peerId, peer] of this.peers) {
      peerStates[peerId] = this.snapshot.peerStates[peerId]
        ?? (peer.pc.connectionState === 'connected' ? 'connected' : 'connecting');
    }
    this.patch({ peers, peerStates, self: this.self });
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try { peer.pc.close(); } catch { /* already closed */ }
    for (const track of peer.remoteStream.getTracks()) {
      try { track.stop(); } catch { /* already ended */ }
      peer.remoteStream.removeTrack(track);
    }
    peer.meter?.stop();
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
      peer.audio = null;
    }
    const speaking = { ...this.snapshot.speaking };
    delete speaking[peerId];
    const peerStates = { ...this.snapshot.peerStates };
    delete peerStates[peerId];
    this.patch({
      peers: Array.from(this.peers.values()).map((item) => item.info),
      peerStates,
      speaking,
    });
  }

  /* ------------------------------------------------------------------ *
   * SDP / ICE mesh
   * ------------------------------------------------------------------ */

  private queue(peerId: string, task: () => Promise<void>): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.chain = peer.chain
      .then(() => (this.peers.get(peerId) === peer ? task() : undefined))
      .catch(() => {
        if (this.peers.get(peerId) === peer) this.patch({ error: msg('voice.error.peerFailed') });
      });
  }

  private async initiateOffer(peerId: string): Promise<void> {
    this.queue(peerId, async () => {
      const peer = this.peers.get(peerId);
      if (!peer || peer.pc.signalingState !== 'stable') return;
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      const sdp = peer.pc.localDescription?.sdp || offer.sdp || '';
      if (!sdp) return;
      this.send({ type: 'voice-offer', target: peerId, sdp: { type: 'offer', sdp } });
    });
  }

  private handleOffer(data: any): void {
    const from = normalizePeer(data.from);
    const sdp = sdpText(data.sdp);
    if (!from || !sdp) return;
    this.ensurePeer(from);
    this.queue(from.peerId, async () => {
      const peer = this.peers.get(from.peerId);
      if (!peer) return;
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      await this.flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      const answerSdp = peer.pc.localDescription?.sdp || answer.sdp || '';
      if (!answerSdp) return;
      this.send({ type: 'voice-answer', target: from.peerId, sdp: { type: 'answer', sdp: answerSdp } });
    });
  }

  private handleAnswer(data: any): void {
    const from = normalizePeer(data.from);
    const sdp = sdpText(data.sdp);
    if (!from || !sdp) return;
    this.queue(from.peerId, async () => {
      const peer = this.peers.get(from.peerId);
      if (!peer) return;
      if (peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      }
      await this.flushCandidates(peer);
    });
  }

  private handleCandidate(data: any): void {
    const from = normalizePeer(data.from);
    if (!from) return;
    const peer = this.peers.get(from.peerId);
    if (!peer) return;
    const candidate = data.candidate === undefined ? null : data.candidate;
    const normalized: RTCIceCandidateInit | null = candidate && typeof candidate === 'object'
      ? candidate as RTCIceCandidateInit
      : typeof candidate === 'string' && candidate
        ? { candidate }
        : null;
    if (peer.pc.remoteDescription) {
      void peer.pc.addIceCandidate(normalized ?? undefined).catch(() => undefined);
    } else {
      peer.pendingCandidates.push(normalized);
    }
  }

  private async flushCandidates(peer: PeerConnectionState): Promise<void> {
    const pending = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
    for (const candidate of pending) {
      try {
        await peer.pc.addIceCandidate(candidate ?? undefined);
      } catch {
        // A candidate can be rejected after the remote description changed; ignore.
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Remote audio + level metering
   * ------------------------------------------------------------------ */

  private attachRemoteAudio(peer: PeerConnectionState): void {
    if (peer.audio) {
      peer.audio.srcObject = peer.remoteStream;
      return;
    }
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.dataset.voicePeer = peer.info.peerId;
    audio.srcObject = peer.remoteStream;
    const host = this.options.getAudioHost?.() ?? null;
    (host ?? document.body).appendChild(audio);
    peer.audio = audio;
    peer.meter = createLevelMeter(peer.remoteStream);
    void audio.play().catch(() => {
      // Autoplay with sound may need one user gesture; the panel offers a resume button.
      this.patch({ audioBlocked: true });
    });
  }

  private startLevelTimer(): void {
    this.stopLevelTimer();
    this.levelTimer = window.setInterval(() => this.tickLevels(), LEVEL_TICK_MS);
  }

  private stopLevelTimer(): void {
    if (this.levelTimer !== undefined) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = undefined;
    }
  }

  private tickLevels(): void {
    if (this.snapshot.phase !== 'joined') return;
    const localLevel = this.snapshot.muted ? 0 : (this.localMeter?.read() ?? 0);
    const speaking: Record<string, boolean> = {};
    let speakingChanged = false;
    for (const [peerId, peer] of this.peers) {
      const isSpeaking = (peer.meter?.read() ?? 0) > SPEAKING_THRESHOLD;
      speaking[peerId] = isSpeaking;
      if (this.snapshot.speaking[peerId] !== isSpeaking) speakingChanged = true;
    }
    const rounded = Math.round(localLevel * 100) / 100;
    if (roundingEqual(this.snapshot.localLevel, rounded) && !speakingChanged
      && Object.keys(speaking).length === Object.keys(this.snapshot.speaking).length) {
      return;
    }
    this.patch({ localLevel: rounded, speaking });
  }

  /* ------------------------------------------------------------------ *
   * Teardown
   * ------------------------------------------------------------------ */

  private teardown(): void {
    this.stopLevelTimer();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* already closing */ }
    }
    for (const peerId of Array.from(this.peers.keys())) this.removePeer(peerId);
    this.peers.clear();
    this.localMeter?.stop();
    this.localMeter = null;
    if (this.local) {
      stopTracks(this.local);
      this.local = null;
    }
    this.self = null;
  }
}

function roundingEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

/* -------------------------------------------------------------------- *
 * React hook
 * -------------------------------------------------------------------- */

export type UseVoiceRoomOptions = {
  token: string;
  streamId: number | null;
  /** False when the room ended / no auth: joining is disabled and state resets. */
  enabled: boolean;
};

export type VoiceRoomApi = {
  snapshot: VoiceSnapshot;
  audioHostRef: RefObject<HTMLDivElement>;
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
  resumeAudio: () => void;
};

export function useVoiceRoom(options: UseVoiceRoomOptions): VoiceRoomApi {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(INITIAL_VOICE_SNAPSHOT);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  const onChange = useCallback((next: VoiceSnapshot) => setSnapshot(next), []);

  useEffect(() => {
    if (!options.enabled || options.streamId === null || !options.token) {
      clientRef.current?.dispose();
      clientRef.current = null;
      setSnapshot(INITIAL_VOICE_SNAPSHOT);
      return;
    }
    const client = new VoiceClient({
      token: options.token,
      streamId: options.streamId,
      onChange,
      getAudioHost: () => audioHostRef.current,
    });
    clientRef.current = client;
    return () => {
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      setSnapshot(INITIAL_VOICE_SNAPSHOT);
    };
  }, [options.enabled, options.streamId, options.token, onChange]);

  const join = useCallback(() => { void clientRef.current?.join(); }, []);
  const leave = useCallback(() => { clientRef.current?.leave(); }, []);
  const toggleMute = useCallback(() => { clientRef.current?.toggleMute(); }, []);
  const resumeAudio = useCallback(() => { void clientRef.current?.resumeAudio(); }, []);

  return { snapshot, audioHostRef, join, leave, toggleMute, resumeAudio };
}
