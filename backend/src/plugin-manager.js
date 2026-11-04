import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../plugins');
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const SAFE_EVENT = /^[a-z][a-z0-9.]{1,63}$/;

/**
 * Plugins are trusted server-side JavaScript (not a sandbox). All installed
 * plugins are discoverable; routes and hooks are guarded by their runtime state.
 */
export async function createPluginManager({ app, db, auth, dataDir, enabledCsv = '', overrides = {}, logger = console }) {
  const requested = new Set(String(enabledCsv).split(',').map((x) => x.trim()).filter(Boolean));
  const states = new Map();
  const listeners = new Map();
  const enabledOverride = new Map(Object.entries(overrides).map(([id, value]) => [id, Boolean(value)]));

  const hooks = Object.freeze({
    on(eventName, handler) {
      if (!SAFE_EVENT.test(eventName) || typeof handler !== 'function') throw new TypeError('Invalid plugin hook registration');
      const entries = listeners.get(eventName) || [];
      entries.push({ state: currentRegisteringState, handler });
      listeners.set(eventName, entries);
    },
  });
  let currentRegisteringState = null;

  const guardedAppFor = (state) => {
    const facade = Object.create(app);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']) {
      facade[method] = (route, ...handlers) => app[method](route, (req, res, next) => {
        if (!state.enabled) return res.status(404).json({ error: '插件未启用' });
        return next();
      }, ...handlers);
    }
    return facade;
  };

  async function load(state) {
    if (state.loaded) return;
    const pluginDir = path.resolve(PLUGIN_ROOT, state.id);
    if (!pluginDir.startsWith(`${PLUGIN_ROOT}${path.sep}`)) throw new Error('Invalid plugin path');
    const manifest = JSON.parse(await readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
    if (manifest.id !== state.id || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Plugin manifest is invalid');
    const entry = manifest.entry || 'index.js';
    if (path.basename(entry) !== entry || !entry.endsWith('.js')) throw new Error('Invalid plugin entry');
    const mod = await import(pathToFileURL(path.join(pluginDir, entry)).href);
    if (typeof mod.register !== 'function') throw new Error('Plugin must export register(context)');
    currentRegisteringState = state;
    try {
      await mod.register({ app: guardedAppFor(state), db, auth, hooks, logger, dataDir, plugin: { id: state.id, name: manifest.name, version: manifest.version } });
    } finally {
      currentRegisteringState = null;
    }
    state.name = manifest.name;
    state.version = manifest.version;
    state.description = String(manifest.description || '').slice(0, 240);
    state.loaded = true;
    state.status = state.enabled ? 'enabled' : 'disabled';
    logger.info(`[plugin] registered ${state.id}@${state.version}`);
  }

  const directories = await readdir(PLUGIN_ROOT, { withFileTypes: true });
  for (const entry of directories) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    const id = entry.name;
    const enabled = enabledOverride.has(id) ? enabledOverride.get(id) : requested.has(id);
    const state = { id, enabled, loaded: false, status: enabled ? 'loading' : 'disabled' };
    states.set(id, state);
    if (enabled) {
      try { await load(state); }
      catch (error) { state.status = 'error'; state.error = String(error?.message || error).slice(0, 180); logger.error(`[plugin] failed to load ${id}:`, error?.message || error); }
    } else {
      try {
        const manifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, id, 'plugin.json'), 'utf8'));
        state.name = manifest.name;
        state.version = manifest.version;
        state.description = String(manifest.description || '').slice(0, 240);
      } catch { state.status = 'invalid'; }
    }
  }

  const emit = async (eventName, payload) => {
    for (const item of listeners.get(eventName) || []) {
      if (!item.state.enabled) continue;
      try { await item.handler(payload); }
      catch (error) { logger.error(`[plugin hook ${eventName}]`, error?.message || error); }
    }
  };

  return {
    emit,
    list: () => [...states.values()].map(({ id, name, version, description, enabled, loaded, status, error }) => ({ id, name, version, description, enabled, loaded, status, ...(error ? { error } : {}) })),
    async setEnabled(id, enabled) {
      const state = states.get(id);
      if (!state) throw new Error('插件不存在');
      if (enabled) {
        try { await load(state); }
        catch (error) { state.status = 'error'; state.error = String(error?.message || error).slice(0, 180); throw error; }
      }
      state.enabled = Boolean(enabled);
      state.status = state.enabled ? 'enabled' : 'disabled';
      delete state.error;
      return { ...state };
    },
  };
}
