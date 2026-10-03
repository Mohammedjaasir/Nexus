import { useSyncExternalStore } from 'react';

/** Subscribes to a CSS media query. CSS still does the layout; this only
 *  decides what to mount (sheet vs inline passport, no Monaco on mobile). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
