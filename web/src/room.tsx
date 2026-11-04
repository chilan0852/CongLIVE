/**
 * Standalone live room page (`/room/<id>`).
 *
 * The room is rendered only while the route is a room, so the lobby never mounts a
 * second player/chat. The page owns the presentation (cover, title, host, viewer and
 * latency chips, WHEP player, chat) while the App owns the actual WHEP/WS connections,
 * which keeps a single PeerConnection for the current room.
 */
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useVoiceRoom, type VoicePeer, type VoicePhase } from './voice';
import {
  STUN_FALLBACK_ICE_SERVERS,
  coverFallbackChar,
  coverFallbackStyle,
  fetchTurnCredentials,
  streamCoverUrl,
  type ChatMessage,
  type RoomDetail,
  type RtcStatus,
} from './api';
import { t, translateMessage, type TextMessage } from './i18n';
import type { LatencySample } from './latency';

export type RoomChat = {
  messages: ChatMessage[];
  state: TextMessage;
  input: string;
  setInput: (value: string) => void;
  submit: (event: FormEvent) => void;
};

export type RoomPageProps = {
  roomId: number;
  detail: RoomDetail | null;
  loading: boolean;
  notFound: boolean;
  loadError: TextMessage | null;
  /** The host stopped publishing (detail says offline, or the room disappeared). */
  ended: boolean;
  token: string;
  viewers: number | null;
  latency: LatencySample | null;
  videoRef: RefObject<HTMLVideoElement>;
  rtcStatus: RtcStatus;
  /** A WHEP session is active (or should be): signed in, live room known. */
  canConnect: boolean;
  canRetry: boolean;
  canChat: boolean;
  chat: RoomChat;
  onBack: () => void;
  onLogin: () => void;
  onRetryLoad: () => void;
  onRetryConnect: () => void;
  /** Signed-in username (used for the host badge / studio entry). */
  currentUsername: string;
  /** Open the PC-first broadcast workbench (`/studio`). */
  onOpenStudio: () => void;
};

function latencyTone(sample: LatencySample | null): string {
  if (!sample) return 'idle';
  if (sample.totalMs < 400) return 'ok';
  if (sample.totalMs < 1000) return 'warn';
  return 'error';
}

/** Viewer count chip: a dash until the first count arrives. */
function ViewersChip({ viewers }: { viewers: number | null }) {
  return (
    <span className="room-chip viewers" role="status" aria-live="polite">
      <span aria-hidden="true">◉</span>
      {t('room.viewers', { count: viewers === null ? '—' : viewers })}
    </span>
  );
}

function LatencyChip({ latency }: { latency: LatencySample | null }) {
  const tone = latencyTone(latency);
  return (
    <span className={`room-chip latency ${tone}`} role="status" aria-live="polite" title={t('room.latencyTitle')}>
      <span aria-hidden="true">⏱</span>
      {latency ? t('room.latency', { ms: latency.totalMs }) : t('room.latencyPending')}
    </span>
  );
}


type VoicePanelProps = {
  token: string;
  streamId: number;
  enabled: boolean;
  /** Signed-in username (self avatar). */
  currentUsername: string;
  /** Room owner name (host badge on their row). */
  hostName: string;
  isHostSelf: boolean;
};

/** Voice room state pill label. */
function voicePhaseLabel(phase: VoicePhase): string {
  switch (phase) {
    case 'joined': return t('voice.liveBadge');
    case 'connecting':
    case 'joining': return t('voice.joining');
    case 'error': return t('voice.errorBadge');
    default: return t('voice.idleBadge');
  }
}

function voicePhaseTone(phase: VoicePhase): string {
  switch (phase) {
    case 'joined': return 'ok';
    case 'connecting':
    case 'joining': return 'info';
    case 'error': return 'error';
    default: return 'idle';
  }
}

/** One participant row (self or a remote mesh peer). */
function VoicePeerRow(props: {
  name: string;
  initial: string;
  stateLabel: string;
  speaking: boolean;
  badge?: string | null;
  dotOn: boolean;
}) {
  const { name, initial, stateLabel, speaking, badge, dotOn } = props;
  return (
    <li className={`voice-peer${speaking ? ' speaking' : ''}`}>
      <span className="voice-avatar" aria-hidden="true">{initial}</span>
      <span className="voice-name">
        {name}
        {badge ? <em>{badge}</em> : null}
      </span>
      <span className="voice-state">{stateLabel}</span>
      <i className={`voice-dot${dotOn ? ' on' : ''}`} aria-hidden="true" />
    </li>
  );
}

/**
 * Voice room ("语音房") inside the standalone room page.
 *
 * The hook is mounted with the room page but does nothing until the listener
 * clicks "Join voice": no microphone capture, WebSocket or PeerConnection
 * exists before that click, and unmount (leave / switch room / host ended)
 * releases everything. Remote audio elements are appended to the hidden host.
 */
function VoicePanel({ token, streamId, enabled, currentUsername, hostName, isHostSelf }: VoicePanelProps) {
  const voice = useVoiceRoom({ token, streamId, enabled });
  const { snapshot, audioHostRef } = voice;
  const joined = snapshot.phase === 'joined';
  const busy = snapshot.phase === 'connecting' || snapshot.phase === 'joining';
  const participants = snapshot.peers.length + (joined ? 1 : 0);
  const localSpeaking = joined && !snapshot.muted && snapshot.localLevel > 0.07;
  const selfName = t('voice.self');
  // TURN credentials are fetched right before joining; failures fall back to STUN.
  const [relay, setRelay] = useState<'idle' | 'checking' | 'turn' | 'stun'>('idle');
  const [relayCode, setRelayCode] = useState<number | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const fetchController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  // Abort an in-flight credential fetch when the panel unmounts / the room changes.
  useEffect(() => () => {
    mounted.current = false;
    fetchController.current?.abort();
  }, []);
  useEffect(() => {
    setRelay('idle');
    setRelayCode(null);
    setJoinBusy(false);
    fetchController.current?.abort();
    fetchController.current = null;
    return () => { fetchController.current?.abort(); };
  }, [streamId, enabled]);

  /**
   * Join flow: fetch short-lived TURN credentials first, then hand the ready
   * `iceServers` (or the two-STUN fallback) to the mesh client. A failed/503
   * credential request must not block voice — it only switches to direct mode.
   */
  async function handleJoin(): Promise<void> {
    if (joinBusy || !token || !enabled) return;
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    setJoinBusy(true);
    setRelay('checking');
    setRelayCode(null);
    let servers: RTCIceServer[] = STUN_FALLBACK_ICE_SERVERS;
    let mode: 'turn' | 'stun' = 'stun';
    let code: number | null = null;
    try {
      const result = await fetchTurnCredentials(token, controller.signal);
      if (result.status === 'ok') {
        servers = result.credentials.iceServers;
        mode = 'turn';
      } else {
        code = result.code;
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      code = null;
    }
    if (controller.signal.aborted || !mounted.current) return;
    fetchController.current = null;
    setJoinBusy(false);
    setRelay(mode);
    setRelayCode(mode === 'stun' ? code : null);
    voice.join(servers);
  }

  function handleLeave(): void {
    setRelay('idle');
    setRelayCode(null);
    voice.leave();
  }

  return (
    <section className="panel voice-panel" id="voice" aria-labelledby="voice-title">
      <div className="panel-head">
        <div>
          <span className="eyebrow">{t('voice.eyebrow')}</span>
          <h2 id="voice-title">
            {t('voice.title')}
            {' '}
            <span className={`state-pill ${voicePhaseTone(snapshot.phase)}`}>
              {busy ? t('voice.joining') : voicePhaseLabel(snapshot.phase)}
            </span>
          </h2>
          <p className="hint">{t('voice.hint')}</p>
          {relay !== 'idle' && (
            <p
              className={`voice-relay ${relay === 'turn' ? 'ok' : relay === 'stun' ? 'warn' : 'info'}`}
              role="status"
              aria-live="polite"
            >
              <i aria-hidden="true" />
              {relay === 'checking'
                ? t('voice.relay.checking')
                : relay === 'turn'
                  ? t('voice.relay.turn')
                  : t('voice.relay.stun')}
            </p>
          )}
          {relay === 'stun' && (
            <p className="hint warn-text voice-relay-fallback">
              {t('voice.relay.fallback', { status: relayCode === null ? '—' : relayCode })}
            </p>
          )}
        </div>
        {joined && (
          <span className="hint">{t('voice.participants', { count: participants })}</span>
        )}
      </div>

      {/* Hidden container for the remote <audio> elements created by VoiceClient. */}
      <div ref={audioHostRef} className="voice-audio-host" aria-hidden="true" />

      {!token && <p className="hint warn-text">{t('voice.signInRequired')}</p>}
      {token && !enabled && <p className="hint warn-text">{t('voice.unavailable')}</p>}
      {snapshot.error && (
        <p className="hint err-text" role="alert" aria-live="polite">{translateMessage(snapshot.error)}</p>
      )}
      {snapshot.audioBlocked && (
        <button type="button" className="link-button" onClick={voice.resumeAudio}>
          {t('voice.audioBlocked')}
        </button>
      )}

      {!joined && !busy ? (
        <div className="voice-join">
          <button
            type="button"
            onClick={() => void handleJoin()}
            disabled={!token || !enabled || joinBusy}
          >
            {joinBusy
              ? t('voice.relay.checking')
              : snapshot.phase === 'error'
                ? t('voice.retry')
                : t('voice.join')}
          </button>
          <p className="hint">{t('voice.joinHint')}</p>
        </div>
      ) : (
        <>
          <div className="voice-toolbar">
            <button
              type="button"
              className="secondary small"
              onClick={voice.toggleMute}
              disabled={!joined}
            >
              {snapshot.muted ? t('voice.unmute') : t('voice.mute')}
            </button>
            <button type="button" className="ghost small" onClick={handleLeave}>
              {t('voice.leave')}
            </button>
          </div>
          {joined && (
            <ul className="voice-peers">
              <VoicePeerRow
                name={selfName}
                initial={(currentUsername || selfName).slice(0, 1).toUpperCase()}
                stateLabel={snapshot.muted
                  ? t('voice.mutedBadge')
                  : localSpeaking
                    ? t('voice.speaking')
                    : t('voice.connected')}
                speaking={localSpeaking}
                badge={isHostSelf ? t('voice.host') : null}
                dotOn={localSpeaking}
              />
              {snapshot.peers.map((peer: VoicePeer) => {
                const state = snapshot.peerStates[peer.peerId] ?? 'connecting';
                const speaking = state === 'connected' && !!snapshot.speaking[peer.peerId];
                return (
                  <VoicePeerRow
                    key={peer.peerId}
                    name={peer.username || `#${peer.userId}`}
                    initial={(peer.username || '?').slice(0, 1).toUpperCase()}
                    stateLabel={speaking
                      ? t('voice.speaking')
                      : state === 'connected'
                        ? t('voice.connected')
                        : state === 'failed'
                          ? t('voice.error.signal')
                          : t('voice.connecting')}
                    speaking={speaking}
                    badge={hostName && peer.username === hostName ? t('voice.host') : null}
                    dotOn={speaking}
                  />
                );
              })}
            </ul>
          )}
          {joined && snapshot.peers.length === 0 && <p className="hint">{t('voice.empty')}</p>}
        </>
      )}
    </section>
  );
}

export function RoomPage(props: RoomPageProps) {
  const {
    roomId,
    detail,
    loading,
    notFound,
    loadError,
    ended,
    token,
    viewers,
    latency,
    videoRef,
    rtcStatus,
    canConnect,
    canRetry,
    canChat,
    chat,
    onBack,
    onLogin,
    onRetryLoad,
    onRetryConnect,
    currentUsername,
    onOpenStudio,
  } = props;
  const isHost = !!currentUsername && !!detail && detail.username === currentUsername;

  const chatList = useRef<HTMLDivElement>(null);

  // Keep the newest comment visible by scrolling the message list only; using
  // scrollIntoView here would also scroll the whole page on mount.
  useEffect(() => {
    const element = chatList.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.messages]);

  const title = detail?.title || t('room.fallbackTitle', { id: roomId });
  const host = detail?.username || '';
  const coverUrl = detail ? streamCoverUrl(detail) : '';
  const stateText = notFound
    ? t('room.notFoundTitle')
    : ended || (detail && !detail.is_live)
      ? t('room.ended')
      : t('room.live');

  return (
    <main className="page room-page">
      <div className="room-topbar">
        <button type="button" className="secondary small room-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {t('room.back')}
        </button>
        <div className="room-topbar-actions">
          {isHost && (
            <>
              <span className="room-chip host">
                <i aria-hidden="true" />
                {t('room.hostBadge')}
              </span>
              <button type="button" className="small" onClick={onOpenStudio}>
                {t('room.studioEntry')}
              </button>
            </>
          )}
          <span className={`status-dot ${notFound || ended ? 'warn' : 'ok'}`}>
            <i aria-hidden="true" />
            {stateText}
          </span>
        </div>
      </div>

      {notFound ? (
        <section className="panel room-missing" role="alert">
          <span className="lobby-empty-mark" aria-hidden="true">404</span>
          <h1>{t('room.notFoundTitle')}</h1>
          <p className="hint">{t('room.notFoundHint')}</p>
          <div className="room-missing-actions">
            <button type="button" onClick={onBack}>{t('room.backToLobby')}</button>
          </div>
        </section>
      ) : loadError && !detail ? (
        <section className="panel room-missing" role="alert">
          <span className="lobby-empty-mark" aria-hidden="true">!</span>
          <h1>{t('room.loadFailedTitle')}</h1>
          <p className="hint">{translateMessage(loadError)}</p>
          <div className="room-missing-actions">
            <button type="button" onClick={onRetryLoad}>{t('room.retry')}</button>
            <button type="button" className="secondary" onClick={onBack}>{t('room.backToLobby')}</button>
          </div>
        </section>
      ) : (
        <>
          <section className="room-head">
            <div className="room-cover" style={coverUrl ? undefined : coverFallbackStyle({ id: roomId })}>
              <span className="live-cover-char" aria-hidden="true">
                {detail ? coverFallbackChar(detail) : t('brand.mark')}
              </span>
              {coverUrl && (
                <img
                  src={coverUrl}
                  alt={t('room.coverAlt', { title })}
                  onError={(event) => { event.currentTarget.style.display = 'none'; }}
                />
              )}
              <span className={`live-badge${ended || (detail && !detail.is_live) ? ' off' : ''}`}>
                <i aria-hidden="true" />
                {ended || (detail && !detail.is_live) ? t('room.endedBadge') : t('lobby.liveBadge')}
              </span>
            </div>
            <div className="room-info">
              <span className="eyebrow">{t('room.eyebrow')}</span>
              <h1>{title}</h1>
              <p className="room-owner">
                {host ? t('room.host', { name: host }) : loading ? t('room.loading') : ''}
              </p>
              <div className="room-stats">
                <ViewersChip viewers={viewers} />
                {canConnect && <LatencyChip latency={latency} />}
                <span className={`room-chip status ${rtcStatus.tone}`}>
                  <i aria-hidden="true" />
                  {translateMessage(rtcStatus.text)}
                </span>
              </div>
              {isHost && <p className="hint room-host-hint">{t('room.studioEntryHint')}</p>}
            </div>
          </section>

          <div className="room-grid">
            <section className="panel watch-panel room-player-panel" id="watch">
              <div className={`player${canConnect ? ' has-stream' : ''}`}>
                <video
                  ref={videoRef}
                  controls
                  autoPlay
                  playsInline
                  aria-label={t('watch.videoLabel')}
                  onClick={() => { void videoRef.current?.play().catch(() => undefined); }}
                />
                {!token && (
                  <div className="player-state">
                    <span className="player-empty-icon" aria-hidden="true">▶</span>
                    <h2>{t('room.loginRequiredTitle')}</h2>
                    <p>{t('room.loginRequired')}</p>
                    <div className="player-state-actions">
                      <button type="button" onClick={onLogin}>{t('room.loginCta')}</button>
                      <button type="button" className="secondary" onClick={onBack}>{t('room.backToLobby')}</button>
                    </div>
                  </div>
                )}
                {token && (ended || (detail && !detail.is_live)) && (
                  <div className="player-state">
                    <span className="player-empty-icon" aria-hidden="true">■</span>
                    <h2>{t('room.endedTitle')}</h2>
                    <p>{t('room.endedHint')}</p>
                    <div className="player-state-actions">
                      <button type="button" onClick={onBack}>{t('room.backToLobby')}</button>
                    </div>
                  </div>
                )}
                {token && !ended && !detail && (
                  <div className="player-state">
                    <span className="player-empty-icon" aria-hidden="true">▶</span>
                    <p>{loading ? t('room.loading') : t('room.waitingDetail')}</p>
                  </div>
                )}
              </div>
              <div className="playrow">
                <p className={`hint rtc-status ${rtcStatus.tone}`} role="status" aria-live="polite">
                  {translateMessage(rtcStatus.text)}
                </p>
                {canRetry && (
                  <button type="button" className="secondary small" onClick={onRetryConnect}>
                    {t('watch.reconnect')}
                  </button>
                )}
              </div>
              <p className="hint">{t('room.playerHint')}</p>
            </section>

            <div className="room-side">
            <VoicePanel
              token={token}
              streamId={roomId}
              enabled={canConnect}
              currentUsername={currentUsername}
              hostName={host}
              isHostSelf={isHost}
            />

            <aside className="panel chat-panel room-chat" id="chat">
              <div className="panel-head">
                <div>
                  <span className="eyebrow">{t('chat.eyebrow')}</span>
                  <h2>{t('chat.title')}</h2>
                  <p className="hint">{translateMessage(chat.state)}</p>
                </div>
                <button type="button" className="secondary small" onClick={onBack}>{t('room.back')}</button>
              </div>
              <div className="chat-messages" ref={chatList}>
                {chat.messages.length === 0
                  ? <p className="hint">{t('chat.empty')}</p>
                  : chat.messages.map((message, index) => (
                    <div className="chat-line" key={`${message.id}-${index}`}>
                      <b>{message.username}</b>
                      <span>{message.content}</span>
                      <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                    </div>
                  ))}
              </div>
              <form className="chat-form" onSubmit={chat.submit}>
                <input
                  value={chat.input}
                  onChange={(event) => chat.setInput(event.target.value)}
                  maxLength={500}
                  placeholder={canChat ? t('chat.inputPlaceholder') : t('chat.inputPlaceholderSignedOut')}
                  disabled={!canChat}
                  aria-label={t('chat.inputLabel')}
                />
                <button disabled={!canChat}>{t('chat.send')}</button>
              </form>
            </aside>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
