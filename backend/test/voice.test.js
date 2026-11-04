import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createVoiceSignaling, handleVoiceMessage, VOICE_LIMITS } from '../src/voice.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Unit helpers: the signaling module only needs objects with readyState/send.
// ---------------------------------------------------------------------------

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(String(raw)));
    },
    messages(type) {
      return this.sent.filter((message) => message.type === type);
    },
  };
}

function fakeSession(streamId, userId, username = `user-${userId}`) {
  return { streamId, userId, username };
}

function unitSignaling() {
  return createVoiceSignaling({ limits: { rateBurst: 100, ratePerSecond: 100 } });
}

function joinPair(signaling) {
  const alice = fakeSocket();
  const bob = fakeSocket();
  const aliceJoin = signaling.join(alice, fakeSession(7, 1, 'alice'));
  const bobJoin = signaling.join(bob, fakeSession(7, 2, 'bob'));
  return { alice, bob, aliceJoin, bobJoin };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test('voice join returns existing peers and broadcasts voice-peer-joined', () => {
  const signaling = unitSignaling();
  const alice = fakeSocket();
  const bob = fakeSocket();

  const aliceJoin = signaling.join(alice, fakeSession(7, 1, 'alice'));
  assert.equal(aliceJoin.ok, true);
  assert.equal(aliceJoin.alreadyJoined, false);
  assert.deepEqual(aliceJoin.peers, []);
  assert.equal(aliceJoin.self.userId, 1);
  assert.equal(aliceJoin.self.username, 'alice');
  assert.equal(typeof aliceJoin.self.peerId, 'string');
  assert.ok(aliceJoin.self.peerId.length >= 8);
  // The first participant only receives its own peer list.
  assert.deepEqual(alice.messages('voice-peers'), [{
    type: 'voice-peers',
    streamId: 7,
    self: aliceJoin.self,
    peers: [],
  }]);
  assert.equal(alice.messages('voice-peer-joined').length, 0);
  assert.equal(signaling.size(7), 1);

  const bobJoin = signaling.join(bob, fakeSession(7, 2, 'bob'));
  assert.deepEqual(bobJoin.peers, [aliceJoin.self]);
  assert.equal(bob.sent[0].type, 'voice-peers');
  assert.deepEqual(bob.sent[0].peers, [aliceJoin.self]);
  assert.deepEqual(bob.sent[0].self, bobJoin.self);

  // Existing participants are told about the newcomer exactly once; peer
  // objects never leak the underlying socket.
  assert.equal(alice.messages('voice-peer-joined').length, 1);
  assert.deepEqual(alice.messages('voice-peer-joined')[0], {
    type: 'voice-peer-joined',
    streamId: 7,
    peer: bobJoin.self,
  });
  assert.equal(Object.hasOwn(alice.messages('voice-peer-joined')[0].peer, 'ws'), false);
  assert.equal(signaling.size(7), 2);
});

test('repeated voice-join is idempotent and never duplicates broadcasts', () => {
  const signaling = unitSignaling();
  const alice = fakeSocket();
  const bob = fakeSocket();
  signaling.join(alice, fakeSession(7, 1, 'alice'));
  const bobJoin = signaling.join(bob, fakeSession(7, 2, 'bob'));

  const again = signaling.join(bob, fakeSession(7, 2, 'bob'));
  assert.equal(again.ok, true);
  assert.equal(again.alreadyJoined, true);
  // The peer list refreshes with the same peerId the existing peer already saw.
  assert.deepEqual(again.peers, [{ peerId: bobJoin.peers[0].peerId, userId: 1, username: 'alice' }]);
  // The existing peer is not spammed with another joined broadcast...
  assert.equal(alice.messages('voice-peer-joined').length, 1);
  // ...and the re-join reply refreshes the peer list for the reconnecting tab.
  assert.equal(bob.messages('voice-peers').length, 2);
  assert.equal(bob.messages('voice-peers')[1].peers.length, 1);
  assert.equal(signaling.size(7), 2);
  assert.equal(bobJoin.peers.length, 1);
});

test('voice relay forwards offer/answer/candidate only to the target', () => {
  const signaling = unitSignaling();
  const { alice, bob, aliceJoin, bobJoin } = joinPair(signaling);

  const offer = signaling.relay(alice, {
    type: 'voice-offer',
    target: bobJoin.self.peerId,
    sdp: 'v=0\r\no=alice',
  });
  assert.equal(offer.ok, true);
  assert.equal(offer.delivered, true);
  assert.deepEqual(bob.messages('voice-offer'), [{
    type: 'voice-offer',
    streamId: 7,
    from: aliceJoin.self,
    sdp: 'v=0\r\no=alice',
  }]);
  // The sender must not receive its own relayed message.
  assert.equal(alice.messages('voice-offer').length, 0);
  // Chat payloads are not injected by the relay.
  assert.equal(bob.messages('message').length, 0);

  const answer = { type: 'answer', sdp: 'v=0\r\no=bob' };
  assert.equal(signaling.relay(bob, {
    type: 'voice-answer',
    target: aliceJoin.self.peerId,
    sdp: answer,
  }).ok, true);
  assert.deepEqual(alice.messages('voice-answer'), [{
    type: 'voice-answer',
    streamId: 7,
    from: bobJoin.self,
    sdp: answer,
  }]);

  const candidate = { candidate: 'candidate:1 1 udp 2113937151 203.0.113.5 54000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  assert.equal(signaling.relay(bob, {
    type: 'voice-candidate',
    target: aliceJoin.self.peerId,
    candidate,
  }).ok, true);
  assert.deepEqual(alice.messages('voice-candidate'), [{
    type: 'voice-candidate',
    streamId: 7,
    from: bobJoin.self,
    candidate,
  }]);

  // A numeric userId target also resolves inside the same room.
  assert.equal(signaling.relay(bob, {
    type: 'voice-candidate',
    target: 1,
    candidate: 'candidate:2 1 udp 1 198.51.100.7 54001 typ host',
  }).ok, true);
  assert.equal(alice.messages('voice-candidate').length, 2);

  // end-of-candidates (null) is relayed verbatim.
  assert.equal(signaling.relay(alice, {
    type: 'voice-candidate',
    target: bobJoin.self.peerId,
    candidate: null,
  }).ok, true);
  assert.equal(bob.messages('voice-candidate').at(-1).candidate, null);
});

test('voice relay rejects unjoined senders, bad targets and invalid payloads', () => {
  const signaling = unitSignaling();
  const { alice, bob, aliceJoin, bobJoin } = joinPair(signaling);
  const outsider = fakeSocket();
  signaling.join(outsider, fakeSession(8, 3, 'carol'));

  // Not joined at all.
  const stranger = fakeSocket();
  assert.equal(signaling.relay(stranger, {
    type: 'voice-offer', target: aliceJoin.self.peerId, sdp: 'v=0',
  }).code, 'not-joined');

  // Target in a different room (both by peerId and by numeric userId).
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: signaling.participant(outsider).peerId, sdp: 'v=0',
  }).code, 'target-not-found');
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: 3, sdp: 'v=0',
  }).code, 'target-not-found');
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: 'missing-peer-id', sdp: 'v=0',
  }).code, 'target-not-found');

  // Self target and malformed targets.
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: aliceJoin.self.peerId, sdp: 'v=0',
  }).code, 'invalid-target');
  for (const target of [undefined, null, '', 0, -1, 3.5, {}, [], 'x'.repeat(200)]) {
    assert.equal(signaling.relay(alice, { type: 'voice-offer', target, sdp: 'v=0' }).code, 'invalid-target');
  }

  // Payload validation.
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: bobJoin.self.peerId,
  }).code, 'invalid-payload');
  assert.equal(signaling.relay(alice, {
    type: 'voice-answer', target: bobJoin.self.peerId, sdp: { nope: true },
  }).code, 'invalid-payload');
  assert.equal(signaling.relay(alice, {
    type: 'voice-candidate', target: bobJoin.self.peerId, candidate: 42,
  }).code, 'invalid-payload');
  assert.equal(signaling.relay(alice, {
    type: 'voice-candidate', target: bobJoin.self.peerId,
  }).code, 'invalid-payload');

  // Nothing invalid was ever delivered to Bob.
  assert.equal(bob.sent.filter((message) => message.type !== 'voice-peer-joined' && message.type !== 'voice-peers').length, 0);

  // Unknown voice-* subtypes are reported, not forwarded.
  assert.equal(signaling.relay(alice, { type: 'voice-bogus', target: bobJoin.self.peerId }).code, 'unknown-message');
});

test('voice relay enforces SDP and candidate size limits', () => {
  const signaling = unitSignaling();
  const { alice, bob, bobJoin } = joinPair(signaling);

  const biggestSdp = 'v=0' + 'x'.repeat(VOICE_LIMITS.maxSdpLength - 3);
  assert.equal(biggestSdp.length, VOICE_LIMITS.maxSdpLength);
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: bobJoin.self.peerId, sdp: biggestSdp,
  }).ok, true);
  const tooLongSdp = biggestSdp + 'x';
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: bobJoin.self.peerId, sdp: tooLongSdp,
  }).code, 'sdp-too-long');
  // Objects are measured through their serialized form, so extra properties
  // cannot bypass the limit.
  assert.equal(signaling.relay(alice, {
    type: 'voice-answer', target: bobJoin.self.peerId,
    sdp: { type: 'answer', sdp: 'v=0', junk: 'y'.repeat(VOICE_LIMITS.maxSdpLength) },
  }).code, 'sdp-too-long');

  const biggestCandidate = 'candidate:' + 'z'.repeat(VOICE_LIMITS.maxCandidateLength - 10);
  assert.equal(biggestCandidate.length, VOICE_LIMITS.maxCandidateLength);
  assert.equal(signaling.relay(alice, {
    type: 'voice-candidate', target: bobJoin.self.peerId, candidate: biggestCandidate,
  }).ok, true);
  assert.equal(signaling.relay(alice, {
    type: 'voice-candidate', target: bobJoin.self.peerId, candidate: biggestCandidate + 'z',
  }).code, 'candidate-too-long');

  // Exactly the two valid payloads reached Bob.
  assert.equal(bob.messages('voice-offer').length, 1);
  assert.equal(bob.messages('voice-answer').length, 0);
  assert.equal(bob.messages('voice-candidate').length, 1);
});

test('voice messages are rate limited per connection but leave always works', () => {
  const signaling = createVoiceSignaling({ limits: { rateBurst: 2, ratePerSecond: 0 }, now: () => 1000 });
  const alice = fakeSocket();
  const bob = fakeSocket();
  const aliceJoin = signaling.join(alice, fakeSession(7, 1, 'alice')); // consumes 1 token
  const bobJoin = signaling.join(bob, fakeSession(7, 2, 'bob'));
  assert.equal(aliceJoin.ok, true);

  const sender = { type: 'voice-candidate', target: bobJoin.self.peerId, candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' };
  assert.equal(signaling.relay(alice, sender).ok, true); // 0 tokens left
  assert.equal(signaling.relay(alice, sender).code, 'rate-limited');

  // A rate-limited connection can still leave the voice room.
  assert.equal(handleVoiceMessage(signaling, alice, fakeSession(7, 1, 'alice'), { type: 'voice-leave' }), true);
  assert.equal(signaling.size(7), 1);
  assert.equal(signaling.relay(alice, sender).code, 'not-joined');
  assert.equal(bob.messages('voice-peer-left').length, 1);

  // The bucket is independent per connection: Bob is unaffected.
  assert.equal(signaling.relay(bob, {
    type: 'voice-candidate', target: signaling.participant(bob).peerId, candidate: null,
  }).code, 'invalid-target');
});

test('voice leave and clearRoom clean up participants and notify the room', () => {
  const signaling = unitSignaling();
  const { alice, bob, bobJoin } = joinPair(signaling);
  const carol = fakeSocket();
  signaling.join(carol, fakeSession(8, 3, 'carol'));

  const left = signaling.leave(bob, 'leave');
  assert.equal(left.userId, 2);
  assert.deepEqual(alice.messages('voice-peer-left'), [{
    type: 'voice-peer-left',
    streamId: 7,
    peer: bobJoin.self,
    reason: 'leave',
  }]);
  assert.equal(signaling.size(7), 1);
  assert.equal(signaling.participant(bob), null);
  // The leaver is no longer a valid relay target.
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: bobJoin.self.peerId, sdp: 'v=0',
  }).code, 'target-not-found');
  // Leaving twice or never joining is harmless.
  assert.equal(signaling.leave(bob, 'leave'), null);
  assert.equal(signaling.leave(fakeSocket(), 'close'), null);

  // Room-closed cleanup drops everyone without per-peer traffic.
  signaling.join(bob, fakeSession(7, 2, 'bob'));
  assert.equal(signaling.size(7), 2);
  const closed = signaling.clearRoom(7, 'blocked');
  assert.equal(closed, 2);
  assert.equal(signaling.size(7), 0);
  assert.equal(signaling.roomCount(), 1);
  assert.equal(signaling.participant(alice), null);
  assert.equal(signaling.relay(alice, {
    type: 'voice-offer', target: bobJoin.self.peerId, sdp: 'v=0',
  }).code, 'not-joined');
  assert.equal(signaling.clearRoom(999), 0);
});

test('handleVoiceMessage only intercepts voice-* messages and reports errors', () => {
  const signaling = unitSignaling();
  const ws = fakeSocket();
  const session = fakeSession(7, 1, 'alice');

  // Chat/auth/ready payloads fall through to the existing handler untouched.
  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'chat', content: 'hi' }), false);
  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'ready' }), false);
  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'auth', token: 'x' }), false);
  assert.equal(handleVoiceMessage(signaling, ws, session, null), false);
  assert.equal(ws.sent.length, 0);

  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'voice-join' }), true);
  assert.equal(ws.messages('voice-peers').length, 1);
  const self = ws.messages('voice-peers')[0].self;

  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'voice-join' }), true);
  assert.equal(ws.messages('voice-peers').length, 2);
  assert.equal(ws.messages('voice-error').length, 0);

  assert.equal(handleVoiceMessage(signaling, ws, session, { type: 'voice-bogus' }), true);
  assert.equal(ws.messages('voice-error').at(-1).code, 'unknown-message');
  assert.match(ws.messages('voice-error').at(-1).message, /\S/);

  // Unjoined connections get voice-error not-joined for signaling.
  const other = fakeSocket();
  assert.equal(handleVoiceMessage(signaling, other, fakeSession(7, 2, 'bob'), {
    type: 'voice-offer', target: self.peerId, sdp: 'v=0',
  }), true);
  assert.equal(other.messages('voice-error')[0].code, 'not-joined');
  assert.equal(other.messages('voice-error')[0].message, '请先加入语音');

  // leave without joining is a silent no-op (no spurious error).
  assert.equal(handleVoiceMessage(signaling, other, fakeSession(7, 2, 'bob'), { type: 'voice-leave' }), true);
  assert.equal(other.messages('voice-error').length, 1);

  // Invalid session is reported instead of throwing.
  assert.equal(handleVoiceMessage(signaling, fakeSocket(), fakeSession(0, 1), { type: 'voice-join' }), true);
});

test('index.js wires voice signaling into the authenticated room WebSocket', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /import \{ createVoiceSignaling, handleVoiceMessage, VOICE_LIMITS \} from '\.\/voice\.js';/);
  assert.match(source, /const voiceSignaling = createVoiceSignaling\(\);/);
  // Voice frames are allowed to be larger than chat frames.
  assert.match(source, /new WebSocketServer\(\{ noServer: true, maxPayload: VOICE_LIMITS\.maxFrameBytes \}\)/);
  assert.match(source, /if \(handleVoiceMessage\(voiceSignaling, ws, session, message\)\) return;/);
  assert.match(source, /voiceSignaling\.leave\(ws, 'close'\)/);
  assert.match(source, /function closeChatRoom[\s\S]*?voiceSignaling\.clearRoom\(streamId, reason\)/);
  // The existing chat protocol stays byte-for-byte compatible.
  assert.match(source, /sendWs\(ws, \{ type: 'ready', streamId, messages: history\.reverse\(\), viewers \}\)/);
  assert.match(source, /if \(message\.type !== 'chat' \|\| typeof message\.content !== 'string'\) return;/);
  assert.match(source, /broadcastChat\(session\.streamId, \{ type: 'message', message: saved \}\)/);
  assert.match(source, /type: 'warning', message: '发送太快了，请稍后再试'/);
});

test('npm test syntax-checks the new voice module', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  assert.match(pkg.scripts.test, /node --check src\/voice\.js/);
});

// ---------------------------------------------------------------------------
// Integration tests: a real WS server wired exactly like index.js (auth session
// provided by the connection, voice dispatch before the chat fallback).
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function nextMessage(ws, predicate = () => true, timeoutMs = 2000) {
  const index = ws.inbox.findIndex(predicate);
  if (index >= 0) return Promise.resolve(ws.inbox.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        ws.waiters = ws.waiters.filter((item) => item !== waiter);
        reject(new Error('timeout waiting for a WebSocket message'));
      }, timeoutMs),
    };
    ws.waiters.push(waiter);
  });
}

async function expectNoMessage(ws, predicate = () => true, waitMs = 150) {
  await delay(waitMs);
  assert.deepEqual(ws.inbox.filter(predicate), [], 'no matching message expected');
}

async function startRelay() {
  const signaling = createVoiceSignaling({ limits: { rateBurst: 200, ratePerSecond: 200 } });
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_LIMITS.maxFrameBytes });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      const url = new URL(request.url, 'http://localhost');
      const session = {
        streamId: Number(url.searchParams.get('room')),
        userId: Number(url.searchParams.get('uid')),
        username: decodeURIComponent(url.searchParams.get('name') || ''),
      };
      ws.on('error', () => {});
      ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        // Voice dispatch comes first, exactly like index.js.
        if (handleVoiceMessage(signaling, ws, session, message)) return;
        // Chat keeps its own path; the echo proves voice did not swallow it.
        if (message.type === 'chat') {
          ws.send(JSON.stringify({ type: 'message', message: { username: session.username, content: message.content } }));
        }
      });
      ws.on('close', () => { signaling.leave(ws, 'close'); });
      ws.send(JSON.stringify({ type: 'ready', streamId: session.streamId, messages: [], viewers: 0 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const clients = new Set();

  return {
    signaling,
    async connect(room, uid, name) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?room=${room}&uid=${uid}&name=${encodeURIComponent(name)}`);
      ws.inbox = [];
      ws.waiters = [];
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        const index = ws.waiters.findIndex((waiter) => waiter.predicate(message));
        if (index >= 0) {
          const [waiter] = ws.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          ws.inbox.push(message);
        }
      });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      clients.add(ws);
      await nextMessage(ws, (message) => message.type === 'ready');
      return ws;
    },
    send(ws, payload) {
      ws.send(JSON.stringify(payload));
    },
    async dispose() {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 250);
            ws.once('close', () => { clearTimeout(timer); resolve(); });
            ws.close();
          });
        }
      }
      clients.clear();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('two authenticated WS clients exchange the full voice signal flow', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.dispose());

  const alice = await relay.connect(7, 1, 'alice');
  const bob = await relay.connect(7, 2, 'bob');

  // Alice joins: she is alone and gets her own identity.
  relay.send(alice, { type: 'voice-join' });
  const alicePeers = await nextMessage(alice, (message) => message.type === 'voice-peers');
  assert.equal(alicePeers.streamId, 7);
  assert.deepEqual(alicePeers.peers, []);
  assert.equal(alicePeers.self.userId, 1);
  assert.equal(alicePeers.self.username, 'alice');
  assert.equal(typeof alicePeers.self.peerId, 'string');

  // Bob joins: he sees Alice, Alice is told about Bob.
  relay.send(bob, { type: 'voice-join' });
  const bobPeers = await nextMessage(bob, (message) => message.type === 'voice-peers');
  assert.deepEqual(bobPeers.peers, [alicePeers.self]);
  const joined = await nextMessage(alice, (message) => message.type === 'voice-peer-joined');
  assert.deepEqual(joined.peer, bobPeers.self);
  // The ready handshake is not repeated by voice traffic.
  assert.equal(alice.inbox.filter((message) => message.type === 'ready').length, 0);

  // Offer goes only to Alice; the offerer never receives its own message.
  relay.send(bob, { type: 'voice-offer', target: alicePeers.self.peerId, sdp: 'v=0\r\no=bob' });
  const offer = await nextMessage(alice, (message) => message.type === 'voice-offer');
  assert.equal(offer.streamId, 7);
  assert.equal(offer.from.peerId, bobPeers.self.peerId);
  assert.equal(offer.from.userId, 2);
  assert.equal(offer.from.username, 'bob');
  assert.equal(offer.sdp, 'v=0\r\no=bob');
  assert.equal(bob.inbox.filter((message) => message.type === 'voice-offer').length, 0);

  // Answer goes back only to Bob, SDP object preserved verbatim.
  relay.send(alice, { type: 'voice-answer', target: bobPeers.self.peerId, sdp: { type: 'answer', sdp: 'v=0\r\no=alice' } });
  const answer = await nextMessage(bob, (message) => message.type === 'voice-answer');
  assert.deepEqual(answer.sdp, { type: 'answer', sdp: 'v=0\r\no=alice' });
  assert.equal(answer.from.peerId, alicePeers.self.peerId);

  // Trickle ICE both ways, plus the null end-of-candidates marker.
  const candidate = { candidate: 'candidate:1 1 udp 2113937151 203.0.113.5 54000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  relay.send(bob, { type: 'voice-candidate', target: alicePeers.self.peerId, candidate });
  assert.deepEqual((await nextMessage(alice, (message) => message.type === 'voice-candidate')).candidate, candidate);
  relay.send(alice, { type: 'voice-candidate', target: bobPeers.self.peerId, candidate: null });
  assert.equal((await nextMessage(bob, (message) => message.type === 'voice-candidate')).candidate, null);

  // Chat still flows through the unchanged chat path.
  relay.send(alice, { type: 'chat', content: '你好' });
  const chat = await nextMessage(alice, (message) => message.type === 'message');
  assert.equal(chat.message.username, 'alice');
  assert.equal(chat.message.content, '你好');

  // Leave notifies the remaining participant and frees the participant slot.
  relay.send(bob, { type: 'voice-leave' });
  const left = await nextMessage(alice, (message) => message.type === 'voice-peer-left');
  assert.deepEqual(left.peer, bobPeers.self);
  assert.equal(left.reason, 'leave');
  assert.equal(relay.signaling.size(7), 1);
});

test('voice relay enforces membership and room scoping over real sockets', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.dispose());

  const alice = await relay.connect(7, 1, 'alice');
  const bob = await relay.connect(7, 2, 'bob');
  const carol = await relay.connect(8, 3, 'carol');

  relay.send(alice, { type: 'voice-join' });
  const alicePeers = await nextMessage(alice, (message) => message.type === 'voice-peers');
  relay.send(carol, { type: 'voice-join' });
  const carolPeers = await nextMessage(carol, (message) => message.type === 'voice-peers');

  // Signaling before join is refused and never forwarded.
  relay.send(bob, { type: 'voice-offer', target: alicePeers.self.peerId, sdp: 'v=0' });
  const notJoined = await nextMessage(bob, (message) => message.type === 'voice-error');
  assert.equal(notJoined.code, 'not-joined');
  await expectNoMessage(alice, (message) => message.type === 'voice-offer');

  relay.send(bob, { type: 'voice-join' });
  const bobPeers = await nextMessage(bob, (message) => message.type === 'voice-peers');

  // A peer in a different room is unreachable, whether addressed by peerId or
  // by numeric userId.
  relay.send(alice, { type: 'voice-offer', target: carolPeers.self.peerId, sdp: 'v=0' });
  assert.equal((await nextMessage(alice, (message) => message.type === 'voice-error')).code, 'target-not-found');
  relay.send(alice, { type: 'voice-offer', target: 3, sdp: 'v=0' });
  assert.equal((await nextMessage(alice, (message) => message.type === 'voice-error')).code, 'target-not-found');
  await expectNoMessage(carol, (message) => message.type === 'voice-offer');

  // Self-targeting is invalid and not looped back.
  relay.send(alice, { type: 'voice-offer', target: alicePeers.self.peerId, sdp: 'v=0' });
  assert.equal((await nextMessage(alice, (message) => message.type === 'voice-error')).code, 'invalid-target');

  // Oversized payloads are rejected before reaching the peer.
  relay.send(bob, { type: 'voice-offer', target: alicePeers.self.peerId, sdp: 'v=0' + 'x'.repeat(VOICE_LIMITS.maxSdpLength) });
  assert.equal((await nextMessage(bob, (message) => message.type === 'voice-error')).code, 'sdp-too-long');
  relay.send(bob, { type: 'voice-candidate', target: alicePeers.self.peerId, candidate: 'candidate:' + 'x'.repeat(VOICE_LIMITS.maxCandidateLength) });
  assert.equal((await nextMessage(bob, (message) => message.type === 'voice-error')).code, 'candidate-too-long');
  await expectNoMessage(alice, (message) => message.type === 'voice-offer' || message.type === 'voice-candidate');

  // Closing a socket broadcasts voice-peer-left with reason "close".
  const closed = new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    bob.once('close', () => { clearTimeout(timer); resolve(); });
    bob.close();
  });
  const left = await nextMessage(alice, (message) => message.type === 'voice-peer-left');
  assert.deepEqual(left.peer, bobPeers.self);
  assert.equal(left.reason, 'close');
  await closed;
  assert.equal(relay.signaling.size(7), 1);
});
