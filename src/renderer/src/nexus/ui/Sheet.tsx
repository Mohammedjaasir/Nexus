import { useEffect, useRef, type ReactNode } from 'react';

/** Modal side/bottom sheet: Esc closes, focus moves in on open and returns on
 *  close, Tab is trapped inside. */
export function Sheet({ open, onClose, side = 'right', labelledBy, children }: {
  open: boolean; onClose: () => void; side?: 'right' | 'bottom'; labelledBy: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('textarea, input, button, [tabindex="0"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea,input,select,[tabindex="0"]'));
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="nx-sheet-layer">
      <div className="nx-sheet-scrim" onClick={onClose} />
      <div ref={ref} className={`nx-sheet nx-sheet--${side}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}
