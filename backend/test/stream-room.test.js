import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewerRegistry } from '../src/viewers.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('viewer registry counts unique SRS client ids per room', () => {
  const registry = createViewerRegistry();
  assert.equal(registry.count(7), 0);
  assert.deepEqual(registry.add(7, 'client-a'), { changed: true, viewers: 1 });
  assert.deepEqual(registry.add(7, 'client-b'), { changed: true, viewers: 2 });
  assert.deepEqual(registry.add(7, 'client-c'), { changed: true, viewers: 3 });
  assert.equal(registry.count(7), 3);
  // Rooms are independent.
  assert.equal(registry.count(8), 0);
  assert.deepEqual(registry.add(8, 'client-a'), { changed: true, viewers: 1 });
  assert.equal(registry.count(7), 3);
  assert.equal(registry.count(8), 1);
});

test('repeated on_play callbacks for the same client are idempotent', () => {
  const registry = createViewerRegistry();
  assert.equal(registry.add(1, 'client-a').viewers, 1);
  assert.deepEqual(registry.add(1, 'client-a'), { changed: false, viewers: 1 });
  assert.equal(registry.add(1, 'client-a').viewers, 1);
  assert.equal(registry.count(1), 1);
});

test('on_stop removes exactly the client that stopped', () => {
  const registry = createViewerRegistry();
  registry.add(1, 'client-a');
  registry.add(1, 'client-b');
  assert.deepEqual(registry.remove(1, 'client-b'), { changed: true, viewers: 1 });
  assert.equal(registry.count(1), 1);
  // Unknown client ids and already-stopped clients do not go negative.
  assert.deepEqual(registry.remove(1, 'client-b'), { changed: false, viewers: 1 });
  assert.deepEqual(registry.remove(1, 'never-played'), { changed: false, viewers: 1 });
  assert.equal(registry.count(1), 1);
  registry.remove(1, 'client-a');
  assert.equal(registry.count(1), 0);
  assert.equal(registry.roomsWithViewers(), 0);
});

test('on_stop by client id cleans every room that client watched', () => {
  const registry = createViewerRegistry();
  registry.add(11, 'client-a');
  registry.add(11, 'client-b');
  registry.add(12, 'client-a');
  const updates = registry.removeClient('client-a');
  assert.deepEqual(updates, [
    { streamId: '11', viewers: 1 },
    { streamId: '12', viewers: 0 },
  ]);
  assert.equal(registry.count(11), 1);
  assert.equal(registry.count(12), 0);
  assert.equal(registry.roomsWithViewers(), 1);
  assert.deepEqual(registry.removeClient('client-a'), []);
  assert.deepEqual(registry.removeClient(''), []);
});

test('on_unpublish clear drops all viewers and the room restarts from zero', () => {
  const registry = createViewerRegistry();
  registry.add(3, 'client-a');
  registry.add(3, 'client-b');
  assert.deepEqual(registry.clear(3), { changed: true, viewers: 0, previous: 2 });
  assert.equal(registry.count(3), 0);
  assert.deepEqual(registry.clear(3), { changed: false, viewers: 0, previous: 0 });
  // A stale on_stop for a cleared client must not resurrect the room.
  assert.deepEqual(registry.removeClient('client-a'), []);
  assert.equal(registry.count(3), 0);
  assert.equal(registry.add(3, 'client-c').viewers, 1);
});

test('viewer registry normalises numeric and string stream/client ids', () => {
  const registry = createViewerRegistry();
  assert.equal(registry.add(42, 99).viewers, 1);
  assert.equal(registry.count('42'), 1);
  assert.equal(registry.add('42', '99').changed, false);
  assert.equal(registry.remove('42', 99).viewers, 0);
  // Empty client ids are ignored so a hook without client_id never invents a viewer.
  assert.deepEqual(registry.add(42, ''), { changed: false, viewers: 0 });
  assert.equal(registry.count(42), 0);
});

test('SRS hooks maintain viewer counts and broadcast viewer updates', async () => {
  const source = await read('../src/index.js');
  // on_play: validate the WHEP token, then add the SRS client id to the room.
  assert.match(source, /app\.post\('\/api\/srs\/on_play'[\s\S]*?viewerRegistry\.add\(stream\.id, clientId\)/);
  assert.match(source, /if \(changed\) \{[\s\S]*?broadcastViewers\(stream\.id, viewers\)/);
  // on_stop: remove by client_id only.
  assert.match(source, /app\.post\('\/api\/srs\/on_stop'[\s\S]*?viewerRegistry\.removeClient\(clientId\)/);
  // on_unpublish: the whole room is cleared.
  assert.match(source, /app\.post\('\/api\/srs\/on_unpublish'[\s\S]*?viewerRegistry\.clear\(row\.id\)/);
});

test('GET /api/streams attaches the in-memory viewer count to every room', async () => {
  const source = await read('../src/index.js');
  const lobby = /app\.get\('\/api\/streams', asyncRoute[\s\S]*?return res\.json\(rows\.map\([\s\S]*?\}\)\)\);/.exec(source)?.[0] || '';
  assert.match(lobby, /viewers: streamViewers\(stream\.id\)/);
});

test('public GET /api/streams/:id returns detail with viewers and whepPath', async () => {
  const source = await read('../src/index.js');
  const detail = /app\.get\('\/api\/streams\/:id', asyncRoute\(async \(req, res\) => \{[\s\S]*?\n\}\)\);/.exec(source)?.[0] || '';
  assert.ok(detail, 'detail route exists');
  assert.match(detail, /Number\.isSafeInteger\(streamId\)/);
  assert.match(detail, /is_live: mysqlBoolean\(stream\.is_live\)/);
  assert.match(detail, /viewers: streamViewers\(stream\.id\)/);
  assert.match(detail, /whepPath: `\/api\/streams\/\$\{stream\.id\}\/whep`/);
  assert.match(detail, /res\.status\(404\)\.json\(\{ error: '直播不存在或不可用' \}\)/);
  // The literal /api/streams/mine route must be registered first.
  assert.ok(source.indexOf("app.get('/api/streams/mine'") < source.indexOf("app.get('/api/streams/:id'"));
});

test('WebSocket ready and viewer changes broadcast the viewers message', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /function broadcastViewers\(streamId, viewers\) \{[\s\S]*?broadcastChat\(streamId, \{ type: 'viewers', streamId: Number\(streamId\), viewers \}\);/);
  // Ready handshake carries the current count, then one authoritative broadcast.
  assert.match(source, /sendWs\(ws, \{ type: 'ready', streamId, messages: history\.reverse\(\), viewers \}\)/);
  assert.match(source, /broadcastViewers\(streamId, viewers\);/);
  // Lobby pages that only know the REST snapshot still receive the same type.
  assert.match(source, /type: 'viewers', streamId: Number\(streamId\), viewers/);
});

test('viewer state is cleared when a room is blocked or deleted', async () => {
  const source = await read('../src/index.js');
  assert.match(source, /if \(blocked\) \{[\s\S]*?viewerRegistry\.clear\(req\.params\.id\)/);
  assert.match(source, /const disconnected = await disconnectSrsClients\(rows\[0\]\.stream_key\);\s*\n\s*viewerRegistry\.clear\(req\.params\.id\);/);
});
