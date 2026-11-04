/**
 * Standalone live room page (`/room/<id>`).
 *
 * The room is rendered only while the route is a room, so the lobby never mounts a
 * second player/chat. The page owns the presentation (cover, title, host, viewer and
 * latency chips, WHEP player, chat) while the App owns the actual WHEP/WS connections,
 * which keeps a single PeerConnection for the current room.
 */
import { useEffect, useRef, type FormEvent, type RefObject } from 'react';
import {
  coverFallbackChar,
  coverFallbackStyle,
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
  } = props;

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
        <span className={`status-dot ${notFound || ended ? 'warn' : 'ok'}`}>
          <i aria-hidden="true" />
          {stateText}
        </span>
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
        </>
      )}
    </main>
  );
}
