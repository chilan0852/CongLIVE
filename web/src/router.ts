/**
 * Tiny History-API router for the CongLive web client.
 *
 * There are exactly two views:
 *   `/`          the lobby (plus the publish and Live2D cards)
 *   `/room/<id>` the standalone live room (WHEP player + chat)
 *
 * Only the pathname is used for routing, so `/#publish` style in-page anchors keep
 * working. Deep links are served by the SPA fallback in nginx (`try_files ... /index.html`),
 * which means a refresh on `/room/12` must always boot the app and parse the route
 * from `window.location.pathname`.
 */
import { useSyncExternalStore } from 'react';

export type Route = { name: 'lobby' } | { name: 'room'; streamId: number };

const ROOM_PATH = /^\/room\/(\d+)\/?$/i;
const NAVIGATE_EVENT = 'conglive:routechange';

/** Parse a pathname into a route; unknown paths fall back to the lobby. */
export function parseRoute(pathname: string): Route {
  const match = ROOM_PATH.exec(pathname || '/');
  if (match) {
    const streamId = Number(match[1]);
    if (Number.isSafeInteger(streamId) && streamId > 0) return { name: 'room', streamId };
  }
  return { name: 'lobby' };
}

export function roomPath(streamId: number): string {
  return `/room/${streamId}`;
}

export function lobbyPath(): string {
  return '/';
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not block the router.
    }
  }
}

/** Push (or replace) a history entry and re-render every routed component. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname + window.location.search + window.location.hash) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  emit();
}

export function subscribeRoute(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

function getPathname(): string {
  return window.location.pathname;
}

/** Current route; re-renders on pushState (via navigate) and on browser back/forward. */
export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribeRoute, getPathname, getPathname));
}

/** Scroll an in-page section into view after a (possibly deferred) render. */
export function scrollToSection(id: string, delayMs = 60): void {
  window.setTimeout(() => {
    const element = document.getElementById(id);
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, delayMs);
}
