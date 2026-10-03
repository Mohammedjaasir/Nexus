import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

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
      <div ref={ref} className={`nx-sheet nx-sheet--${side} nx-float`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]),[role="option"]:not([disabled]):not([aria-disabled="true"])';

/** The one popover pattern for menus and switchers. The trigger carries
 *  aria-haspopup/aria-expanded; opening moves focus to the selected (or first)
 *  item; Arrow keys, Home and End move between items; Escape closes and
 *  returns focus to the trigger; Tab or a click outside closes.
 *  `children(close)` renders the items: buttons with role "menuitem" (kind
 *  "menu") or role "option" plus aria-selected (kind "listbox"). */
export function Popover({ kind, label, trigger, triggerLabel, triggerClassName = '', align = 'start', children }: {
  kind: 'menu' | 'listbox';
  /** Accessible name of the popup. */
  label: string;
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  align?: 'start' | 'end';
  children: (close: (refocus?: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Fixed position from the trigger's rect, so a clipping ancestor (the
  // context bar's path) cannot cut the panel off.
  const [pos, setPos] = useState<CSSProperties>({});
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const popId = useId();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  const items = () => Array.from(pop.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((el) => el.getAttribute('aria-selected') === 'true') ?? all[0])?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(false); };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onResize); };
  }, [open, close]);

  const onPopKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(false); return; }
    const all = items();
    if (all.length === 0) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % all.length;
    else if (e.key === 'ArrowUp') next = i < 0 ? all.length - 1 : (i - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next >= 0) { e.preventDefault(); all[next].focus(); }
  };

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos(align === 'end' ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : { top: r.bottom + 4, left: Math.max(8, r.left) });
    setOpen(true);
  };

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); show(); }
  };

  return (
    <div ref={wrap} className="nx-popover">
      <button
        ref={btn}
        type="button"
        className={`${triggerClassName} cth-titlebar-nodrag`}
        aria-haspopup={kind}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={triggerLabel}
        onClick={() => { if (open) close(false); else show(); }}
        onKeyDown={onTriggerKey}
      >
        {trigger}
      </button>
      {open && (
        <div ref={pop} id={popId} className="nx-popover__panel nx-float cth-titlebar-nodrag" style={pos} role={kind} aria-label={label} onKeyDown={onPopKey}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
