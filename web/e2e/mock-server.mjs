/**
 * Test doubles for the Playwright E2E suite: mocked REST API responses and a
 * tiny in-test WebSocket voice-signaling relay shared by several pages.
 *
 * The relay mirrors the backend task-7 contract (auth → ready → voice-join →
 * voice-peers / peer-joined / peer-left, offer/answer/candidate forwarding) so
 * two browser pages can build a REAL RTCPeerConnection mesh against each other
 * while the signaling itself stays deterministic and offline.
 */

export const MOCK_STREAM = {
  id: 7,
  title: 'E2E 测试直播',
  username: 'hostuser',
  is_live: true,
  whepPath: '/api/streams/7/whep',
  transport: 'WebRTC',
  coverUrl: null,
  viewers: 3,
};

const json = (route, status, body) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Install REST mocks; returns captured request logs for assertions. */
export async function mockApi(page, options = {}) {
  const calls = { createStream: [], whip: [], whep: [], cover: [], createResponder: options.createResponder };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/capacity') {
      return json(route, 200, {
        cpuCores: 2,
        memoryFreeMb: 420,
        memoryTotalMb: 2048,
        activeRooms: 1,
        allow1080p: false,
        allow1080p60: false,
        reason: 'e2e 2C2G',
        recommended: { w: 1280, h: 720, fps: 30, bitrate: 2500000 },
      });
    }
    if (path === '/api/streams' && method === 'GET') return json(route, 200, [MOCK_STREAM]);
    if (path === '/api/streams/7' && method === 'GET') return json(route, 200, MOCK_STREAM);
    if (path === '/api/streams' && method === 'POST') {
      calls.createStream.push(request.postData() || '');
      const responder = calls.createResponder;
      if (responder) return responder(route, request);
      return json(route, 200, {
        id: 21,
        title: 'E2E 工作台直播',
        publishPath: '/api/streams/21/whip',
        transport: 'WebRTC',
      });
    }
    if (path === '/api/streams/21/whip') {
      calls.whip.push(request.postData() || '');
      return json(route, 409, { error: '主播尚未开播' });
    }
    if (path === '/api/streams/7/whep') {
      calls.whep.push(request.postData() || '');
      return json(route, 409, { error: '主播尚未开播' });
    }
    if (/^\/api\/streams\/\d+\/cover$/.test(path)) {
      calls.cover.push(request.postData() || '');
      return json(route, 200, { coverUrl: '/covers/e2e.jpg' });
    }
    if (path.startsWith('/api/auth/')) {
      return json(route, 200, { token: 'mock-token', user: { username: 'mock' } });
    }
    return json(route, 404, { error: 'not found' });
  });
  return calls;
}

/** One simulated signaling connection. */
class RelayClient {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.peerId = null;
    this.userId = 0;
    this.username = '';
    this.streamId = 0;
    this.voiceJoined = false;
  }

  info() {
    return { peerId: this.peerId, userId: this.userId, username: this.username };
  }

  send(payload) {
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // Page navigated away.
    }
  }
}

export class MockVoiceServer {
  constructor() {
    this.clients = new Map();
    this.nextPeer = 0;
    this.events = [];
    /** Close the next voice-join with 4403 (simulates revoked permission). */
    this.denyNextJoin = false;
    /** Answer the next voice-join with a voice-error (simulates device unavailable). */
    this.rejectNextJoin = false;
    this.connections = 0;
  }

  /** Playwright `page.routeWebSocket` handler factory. */
  handler() {
    return (webSocket) => {
      this.connections += 1;
      const client = new RelayClient(this, webSocket);
      webSocket.onMessage((raw) => this.onMessage(client, raw));
      webSocket.onClose(() => this.remove(client, true));
    };
  }

  onMessage(client, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (!client.peerId) {
      if (message.type !== 'auth') return;
      client.peerId = `peer-${++this.nextPeer}`;
      client.streamId = Number(message.streamId) || 0;
      client.userId = 100 + this.nextPeer;
      client.username = '';
      this.clients.set(client.peerId, client);
      client.send({ type: 'ready', streamId: client.streamId, messages: [], viewers: 3 });
      return;
    }
    switch (message.type) {
      case 'voice-join': {
        client.username = client.username || `listener-${client.peerId}`;
        if (this.denyNextJoin) {
          this.denyNextJoin = false;
          this.events.push({ type: 'voice-denied', peerId: client.peerId });
          client.socket.close({ code: 4403, reason: 'stream chat unavailable' });
          return;
        }
        if (this.rejectNextJoin) {
          this.rejectNextJoin = false;
          this.events.push({ type: 'voice-rejected', peerId: client.peerId });
          client.send({ type: 'voice-error', code: 'device-unavailable', message: '语音设备不可用' });
          return;
        }
        client.voiceJoined = true;
        this.events.push({ type: 'voice-join', peerId: client.peerId });
        const others = [...this.clients.values()].filter((other) => (
          other !== client && other.voiceJoined && other.streamId === client.streamId
        ));
        client.send({
          type: 'voice-peers',
          streamId: client.streamId,
          self: client.info(),
          peers: others.map((other) => other.info()),
        });
        for (const other of others) {
          other.send({ type: 'voice-peer-joined', streamId: client.streamId, peer: client.info() });
        }
        return;
      }
      case 'voice-leave': {
        this.events.push({ type: 'voice-leave', peerId: client.peerId });
        this.remove(client, true);
        return;
      }
      case 'voice-offer':
      case 'voice-answer':
      case 'voice-candidate': {
        const target = this.clients.get(String(message.target));
        if (!target || !target.voiceJoined) return;
        this.events.push({ type: message.type, from: client.peerId, to: target.peerId });
        target.send({
          type: message.type,
          streamId: client.streamId,
          from: client.info(),
          ...(message.type === 'voice-candidate' ? { candidate: message.candidate } : { sdp: message.sdp }),
        });
        return;
      }
      default:
        break;
    }
  }

  remove(client, broadcast) {
    if (!this.clients.has(client.peerId)) return;
    this.clients.delete(client.peerId);
    if (!broadcast || !client.voiceJoined) return;
    for (const other of this.clients.values()) {
      if (other.streamId === client.streamId) {
        other.send({ type: 'voice-peer-left', streamId: client.streamId, peer: client.info(), reason: 'leave' });
      }
    }
  }
}

/** Context options shared by every E2E page (fake camera/mic + instrumentation). */
export const INSTRUMENTATION = `
  (() => {
    const state = {
      pcCreated: 0,
      pcClosed: 0,
      // PeerConnections that send local media (voice/publish) vs receive-only (WHEP).
      trackPcCreated: 0,
      trackPcClosed: 0,
      gumCalls: 0,
      audioContexts: 0,
      tracksStopped: 0,
      streams: [],
    };
    window.__e2e = state;
    const trackPCs = new WeakSet();
    const OrigPC = window.RTCPeerConnection;
    if (OrigPC) {
      window.RTCPeerConnection = function (...args) {
        const pc = new OrigPC(...args);
        state.pcCreated += 1;
        const addTrack = pc.addTrack.bind(pc);
        pc.addTrack = (...trackArgs) => {
          if (!trackPCs.has(pc)) {
            trackPCs.add(pc);
            state.trackPcCreated += 1;
          }
          return addTrack(...trackArgs);
        };
        const close = pc.close.bind(pc);
        pc.close = () => {
          state.pcClosed += 1;
          if (trackPCs.has(pc)) state.trackPcClosed += 1;
          return close();
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = OrigPC.prototype;
      Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
    }
    const OrigGUM = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;
    if (OrigGUM) {
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        state.gumCalls += 1;
        const stream = await OrigGUM(constraints);
        state.streams.push(stream);
        return stream;
      };
    }
    const OrigAC = window.AudioContext || window.webkitAudioContext;
    if (OrigAC) {
      const Wrapped = function (...args) {
        state.audioContexts += 1;
        return new OrigAC(...args);
      };
      Wrapped.prototype = OrigAC.prototype;
      Object.setPrototypeOf(Wrapped, OrigAC);
      window.AudioContext = Wrapped;
      if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
    }
    const OrigStop = MediaStreamTrack.prototype.stop;
    if (OrigStop) {
      MediaStreamTrack.prototype.stop = function () {
        state.tracksStopped += 1;
        return OrigStop.call(this);
      };
    }
  })();
`;

/** Aggregate track/PC cleanup state from the instrumented page. */
export async function mediaStats(page) {
  return page.evaluate(() => {
    const state = window.__e2e;
    const localTracks = [];
    for (const stream of state.streams) {
      for (const track of stream.getTracks()) localTracks.push(track.readyState);
    }
    const audioHosts = Array.from(document.querySelectorAll('.voice-audio-host audio'));
    const remote = audioHosts.map((audio) => ({
      hasStream: !!audio.srcObject,
      tracks: audio.srcObject ? audio.srcObject.getTracks().map((track) => track.kind) : [],
      paused: audio.paused,
    }));
    return {
      pcCreated: state.pcCreated,
      pcClosed: state.pcClosed,
      trackPcCreated: state.trackPcCreated,
      trackPcClosed: state.trackPcClosed,
      gumCalls: state.gumCalls,
      audioContexts: state.audioContexts,
      tracksStopped: state.tracksStopped,
      localTracks,
      remote,
    };
  });
}
