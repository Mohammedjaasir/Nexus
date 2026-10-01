import { useSyncExternalStore } from 'react';
import { formatRoute, parseHash, type Route } from './routes';

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
const snapshot = () => window.location.hash;

/** Current route, derived from location.hash (back/forward work for free). */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
  return parseHash(hash);
}

export function navigate(r: Route): void {
  const next = formatRoute(r);
  if (window.location.hash !== next) window.location.hash = next;
}
