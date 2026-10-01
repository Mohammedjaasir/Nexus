import { useEffect } from 'react';
import { useNexusUi } from '../state/uiStore';

/** Ctrl/⌘K → palette, Ctrl/⌘J → assistant (sheet on compact layouts; focuses
 *  the composer on wide ones). Ignored while an xterm terminal has focus so
 *  terminal shortcuts keep working. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('.xterm')) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); useNexusUi.getState().setPaletteOpen(true); }
      else if (k === 'j') { e.preventDefault(); useNexusUi.getState().focusComposer(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
