/**
 * In-memory viewer counters for live rooms.
 *
 * SRS calls on_play once a WHEP viewer is admitted and on_stop when that
 * client goes away. Each room keeps a Set of SRS client ids, so retries and
 * duplicate callbacks are idempotent and counting a room is O(1) with no DB
 * round-trips per lobby request.
 *
 * The registry is intentionally process-local: viewer counts are live-state
 * only, rebuilt from on_play callbacks after any restart.
 */
const normalizeId = (value) => (value == null ? '' : String(value).trim());

export function createViewerRegistry() {
  /** @type {Map<string, Set<string>>} streamId -> client ids currently watching */
  const rooms = new Map();
  /** @type {Map<string, Set<string>>} clientId -> stream ids that client is watching */
  const clients = new Map();

  function roomKey(streamId) {
    const key = normalizeId(streamId);
    if (!key) throw new TypeError('streamId is required');
    return key;
  }

  function count(streamId) {
    return rooms.get(roomKey(streamId))?.size || 0;
  }

  /** Register a viewer. Returns the new count and whether it actually changed. */
  function add(streamId, clientId) {
    const client = normalizeId(clientId);
    const key = roomKey(streamId);
    if (!client) return { changed: false, viewers: count(key) };
    let room = rooms.get(key);
    if (!room) {
      room = new Set();
      rooms.set(key, room);
    }
    const changed = !room.has(client);
    room.add(client);
    let watched = clients.get(client);
    if (!watched) {
      watched = new Set();
      clients.set(client, watched);
    }
    watched.add(key);
    return { changed, viewers: room.size };
  }

  /** Remove one viewer; used when on_stop tells us both stream and client. */
  function remove(streamId, clientId) {
    const client = normalizeId(clientId);
    const key = roomKey(streamId);
    if (!client) return { changed: false, viewers: count(key) };
    const room = rooms.get(key);
    if (!room || !room.delete(client)) return { changed: false, viewers: room?.size || 0 };
    const watched = clients.get(client);
    if (watched) {
      watched.delete(key);
      if (!watched.size) clients.delete(client);
    }
    if (!room.size) rooms.delete(key);
    return { changed: true, viewers: room.size };
  }

  /**
   * Remove a client from every room it watches (on_stop only carries a
   * client_id). Returns one update per room whose count changed.
   */
  function removeClient(clientId) {
    const client = normalizeId(clientId);
    const watched = client ? clients.get(client) : null;
    if (!watched) return [];
    clients.delete(client);
    const updates = [];
    for (const key of watched) {
      const room = rooms.get(key);
      if (!room) continue;
      room.delete(client);
      updates.push({ streamId: key, viewers: room.size });
      if (!room.size) rooms.delete(key);
    }
    return updates;
  }

  /** Drop every viewer of a room (on_unpublish / block / delete). */
  function clear(streamId) {
    const key = roomKey(streamId);
    const room = rooms.get(key);
    if (!room) return { changed: false, viewers: 0, previous: 0 };
    const previous = room.size;
    for (const client of room) {
      const watched = clients.get(client);
      if (!watched) continue;
      watched.delete(key);
      if (!watched.size) clients.delete(client);
    }
    rooms.delete(key);
    return { changed: previous > 0, viewers: 0, previous };
  }

  /** Number of rooms that currently have at least one counted viewer. */
  function roomsWithViewers() {
    return rooms.size;
  }

  return { add, remove, removeClient, clear, count, roomsWithViewers };
}
