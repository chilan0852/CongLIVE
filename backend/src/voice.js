// Full-duplex room voice signaling.
//
// The backend relays signaling only: browsers and PC clients build a
// peer-to-peer WebRTC mesh, and the already-authenticated room WebSocket
// (/ws/chat) carries voice-join / voice-leave / voice-offer / voice-answer /
// voice-candidate messages. No media ever passes through the server.
//
// This module deliberately has no HTTP, database or ws dependency: a
// participant is a plain object with `readyState` and `send(string)`, so the
// relay rules (membership, target validation, SDP/candidate limits, rate
// limiting) can be tested directly and the index.js wiring stays tiny.

import crypto from 'node:crypto';

const WS_OPEN = 1;

export const VOICE_LIMITS = Object.freeze({
  // Whole WebSocket frame budget. Chat content is still trimmed to 500 chars.
  maxFrameBytes: 32 * 1024,
  // A normal SDP is ~1-6 KB; 16 KB leaves room for many codec/ICE lines.
  maxSdpLength: 16000,
  // One ICE candidate line (with IPv6/ufrag) is well below 1 KB.
  maxCandidateLength: 2000,
  // Per-connection token bucket: absorbs trickle-ICE bursts, then throttles.
  rateBurst: 80,
  ratePerSecond: 30,
});

const RELAY_TYPES = new Set(['voice-offer', 'voice-answer', 'voice-candidate']);

const VOICE_ERROR_MESSAGES = Object.freeze({
  'invalid-session': '语音会话无效',
  'not-joined': '请先加入语音',
  'invalid-target': '语音目标无效',
  'target-not-found': '语音目标不在当前直播间',
  'invalid-payload': '语音信令格式无效',
  'sdp-too-long': '语音协商数据过大',
  'candidate-too-long': '语音候选地址数据过大',
  'rate-limited': '语音信令发送太快，请稍后再试',
  'unknown-message': '未知的语音消息',
});

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WS_OPEN || typeof ws.send !== 'function') return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    // The socket may close between the readyState check and send().
    return false;
  }
}

function publicPeer(participant) {
  return {
    peerId: participant.peerId,
    userId: participant.userId,
    username: participant.username,
  };
}

// SDP may be a raw string or an RTCSessionDescriptionInit-like object.
function sdpText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.sdp === 'string') return value.sdp;
  return null;
}

// candidate may be a raw string, an RTCIceCandidateInit-like object, or null
// (end-of-candidates marker).
function candidateText(value) {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.candidate === 'string') return value.candidate;
  return null;
}

// Size counts the serialized payload, so a small `candidate` field cannot hide
// a huge extra property.
function serializedLength(value, text) {
  if (typeof value === 'string') return text.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createVoiceSignaling(options = {}) {
  const limits = { ...VOICE_LIMITS, ...(options.limits || {}) };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createPeerId = typeof options.createPeerId === 'function' ? options.createPeerId : () => crypto.randomUUID();

  // streamId (string key) -> Map<ws, participant>
  const rooms = new Map();
  // ws -> participant (only while joined)
  const joined = new Map();
  // ws -> { tokens, updatedAt } token bucket
  const buckets = new Map();

  const roomKey = (streamId) => String(Number(streamId));

  function takeToken(ws) {
    const time = now();
    let bucket = buckets.get(ws);
    if (!bucket) {
      bucket = { tokens: limits.rateBurst, updatedAt: time };
      buckets.set(ws, bucket);
    } else {
      const elapsed = Math.max(0, time - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(limits.rateBurst, bucket.tokens + elapsed * limits.ratePerSecond);
      bucket.updatedAt = time;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function roomOf(participant) {
    return rooms.get(roomKey(participant.streamId));
  }

  function peersOf(participant) {
    const room = roomOf(participant);
    if (!room) return [];
    return [...room.values()].filter((peer) => peer !== participant).map(publicPeer);
  }

  function peersPayload(participant) {
    return {
      type: 'voice-peers',
      streamId: participant.streamId,
      self: publicPeer(participant),
      peers: peersOf(participant),
    };
  }

  function broadcast(participant, payload) {
    const room = roomOf(participant);
    if (!room) return;
    for (const peer of room.values()) {
      if (peer !== participant) sendJson(peer.ws, payload);
    }
  }

  // Locate the relay target inside the sender's own room. Strings are matched
  // as peerId first (the normal case) and then as a numeric userId; numbers are
  // treated as userId. Returns the participant or an error code string.
  function findTarget(participant, rawTarget) {
    const room = roomOf(participant);
    if (!room) return 'not-joined';
    let value = rawTarget;
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') return 'invalid-target';
    if (typeof value !== 'number' && typeof value !== 'string') return 'invalid-target';
    if (typeof value === 'string' && value.length > 128) return 'invalid-target';

    if (typeof value === 'string') {
      for (const peer of room.values()) {
        if (peer.peerId === value) return peer;
      }
      // Numeric strings fall back to a userId lookup; anything else is a peerId.
      if (!/^\d+$/.test(value)) return 'target-not-found';
      value = Number(value);
    }
    if (!Number.isSafeInteger(value) || value < 1) return 'invalid-target';
    const matches = [...room.values()].filter((peer) => peer.userId === value);
    if (matches.length === 1) return matches[0];
    // Two tabs of the same account are ambiguous; clients must use peerId.
    if (matches.length > 1) return 'invalid-target';
    return 'target-not-found';
  }

  function join(ws, session) {
    const streamId = Number(session?.streamId);
    const userId = Number(session?.userId);
    if (!Number.isSafeInteger(streamId) || streamId < 1 || !Number.isSafeInteger(userId) || userId < 1) {
      return { ok: false, code: 'invalid-session' };
    }
    const existing = joined.get(ws);
    if (existing) {
      // Idempotent re-join: refresh the peer list, never duplicate broadcasts.
      if (existing.streamId === streamId) {
        if (!takeToken(ws)) return { ok: false, code: 'rate-limited' };
        sendJson(ws, peersPayload(existing));
        return { ok: true, alreadyJoined: true, self: publicPeer(existing), peers: peersOf(existing) };
      }
      leave(ws, 'switch');
    }
    if (!takeToken(ws)) return { ok: false, code: 'rate-limited' };

    const participant = {
      ws,
      streamId,
      userId,
      username: String(session.username ?? ''),
      peerId: String(createPeerId()),
    };
    const key = roomKey(streamId);
    const room = rooms.get(key) || new Map();
    rooms.set(key, room);

    // Snapshot the existing participants before adding the newcomer.
    const peers = [...room.values()].map(publicPeer);
    room.set(ws, participant);
    joined.set(ws, participant);

    sendJson(ws, { type: 'voice-peers', streamId, self: publicPeer(participant), peers });
    broadcast(participant, { type: 'voice-peer-joined', streamId, peer: publicPeer(participant) });
    return { ok: true, alreadyJoined: false, self: publicPeer(participant), peers };
  }

  function leave(ws, reason = 'leave') {
    const participant = joined.get(ws);
    if (!participant) return null;
    joined.delete(ws);
    buckets.delete(ws);
    const key = roomKey(participant.streamId);
    const room = rooms.get(key);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(key);
      for (const peer of room.values()) {
        sendJson(peer.ws, {
          type: 'voice-peer-left',
          streamId: participant.streamId,
          peer: publicPeer(participant),
          reason,
        });
      }
    }
    return participant;
  }

  function relay(ws, message) {
    const participant = joined.get(ws);
    if (!participant) return { ok: false, code: 'not-joined' };
    const type = message?.type;
    if (!RELAY_TYPES.has(type)) return { ok: false, code: 'unknown-message' };
    if (!takeToken(ws)) return { ok: false, code: 'rate-limited' };

    const target = findTarget(participant, message.target);
    if (typeof target === 'string') return { ok: false, code: target };
    if (target === participant) return { ok: false, code: 'invalid-target' };

    let payload;
    if (type === 'voice-candidate') {
      const text = candidateText(message.candidate);
      if (text === null) return { ok: false, code: 'invalid-payload' };
      if (serializedLength(message.candidate, text) > limits.maxCandidateLength) {
        return { ok: false, code: 'candidate-too-long' };
      }
      payload = { candidate: message.candidate };
    } else {
      const text = sdpText(message.sdp);
      if (text === null || text.length === 0) return { ok: false, code: 'invalid-payload' };
      if (serializedLength(message.sdp, text) > limits.maxSdpLength) return { ok: false, code: 'sdp-too-long' };
      payload = { sdp: message.sdp };
    }

    const delivered = sendJson(target.ws, {
      type,
      streamId: participant.streamId,
      from: publicPeer(participant),
      ...payload,
    });
    return { ok: true, delivered, target: publicPeer(target) };
  }

  // Drop every participant of a room. Used when the room itself is closed
  // (blocked/deleted): all sockets are about to be closed anyway, so no
  // per-peer voice-peer-left traffic is generated.
  function clearRoom(streamId, reason = 'room-closed') {
    const key = roomKey(streamId);
    const room = rooms.get(key);
    if (!room) return 0;
    rooms.delete(key);
    for (const participant of room.values()) {
      joined.delete(participant.ws);
      buckets.delete(participant.ws);
    }
    return room.size;
  }

  return {
    limits,
    join,
    leave,
    relay,
    clearRoom,
    /** Test/debug helpers. */
    size(streamId) {
      return rooms.get(roomKey(streamId))?.size || 0;
    },
    participant(ws) {
      const participant = joined.get(ws);
      return participant ? { ...publicPeer(participant), streamId: participant.streamId } : null;
    },
    roomCount() {
      return rooms.size;
    },
  };
}

function sendVoiceError(ws, code) {
  sendJson(ws, {
    type: 'voice-error',
    code,
    message: VOICE_ERROR_MESSAGES[code] || '语音信令处理失败',
  });
}

// Dispatch one message parsed from an authenticated room WebSocket.
// Returns true when the message was a voice-* message and has been handled;
// returns false for chat/viewers/other messages so index.js keeps its existing
// behavior untouched.
export function handleVoiceMessage(signaling, ws, session, message) {
  if (!message || typeof message !== 'object') return false;
  const type = typeof message.type === 'string' ? message.type : '';
  if (!type.startsWith('voice-')) return false;

  if (type === 'voice-leave') {
    signaling.leave(ws, 'leave');
    return true;
  }
  const result = type === 'voice-join' ? signaling.join(ws, session) : signaling.relay(ws, message);
  if (result && result.ok === false) sendVoiceError(ws, result.code);
  return true;
}
