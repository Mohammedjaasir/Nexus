import { useState, type CSSProperties, type ReactNode } from 'react';
import { TRIGGER_MODES, type TriggerMode } from '@shared/triggers';

/**
 * Shared chrome for the Triggers tab, on the Nexus hosted classes
 * (nexus/styles/hosted.css): bordered surfaces, 4px controls, 8px objects,
 * sentence-case labels. The collapse behaviour is unchanged — four types of
 * dense config do not fit down a sidebar as flat forms.
 */

/* ───────────────────────────── text helpers ──────────────────────────────── */

export function Muted({ children }: { children: ReactNode }) {
  return <p className="nxh-muted">{children}</p>;
}

/** One line of explanation under a control. Smaller than Muted, never a tooltip —
 *  a sidebar hides tooltips behind the window edge half the time. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="nxh-hint">{children}</p>;
}

export function Chip({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'on' | 'off' }) {
  return <span className="nxh-chip" data-tone={tone === 'on' ? 'on' : undefined}>{children}</span>;
}

export function Callout({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'note' }) {
  return <div className="nxh-callout" data-tone={tone === 'warn' ? 'bad' : 'note'}>{children}</div>;
}

/* ─────────────────────────────── controls ────────────────────────────────── */

/** A small Nexus button (replaces the pixel button in this tab). */
export function SmallButton({ children, onClick, variant = 'secondary', disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'quiet'; disabled?: boolean; type?: 'button' | 'submit';
}) {
  const v = variant === 'primary' ? ' nx-btn--primary' : variant === 'quiet' ? ' nx-btn--quiet' : '';
  return <button type={type} className={`nx-btn nx-btn--sm${v}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function Toggle({ on, onClick, onLabel = 'on', offLabel = 'off' }: {
  on: boolean; onClick: () => void; onLabel?: string; offLabel?: string;
}) {
  return (
    <button type="button" className="nx-btn nx-btn--sm" aria-pressed={on} onClick={onClick}>
      {on ? onLabel : offLabel}
    </button>
  );
}

export function MiniButton({ children, onClick, tone = 'plain', disabled }: {
  children: ReactNode; onClick: () => void; tone?: 'plain' | 'danger' | 'good'; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`nx-btn nx-btn--sm${tone === 'danger' ? ' nx-btn--danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >{children}</button>
  );
}

export function Select({ value, onChange, children, style }: {
  value: string; onChange: (v: string) => void; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <select className="nxh-select" value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      {children}
    </select>
  );
}

/** Label above a control. Stacked, never side-by-side — the sidebar is too
 *  narrow for a label column that does not truncate the thing it labels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="nxh-field">
      <div className="nxh-label">{label}</div>
      {children}
    </div>
  );
}

/* ───────────────────────────── containers ───────────────────────────────── */

export function Scroll({ children }: { children: ReactNode }) {
  return <div className="nxh">{children}</div>;
}

/**
 * One of the four trigger types. Collapsed it is a title, a one-line "what this
 * is", and a live summary — so opening the tab reads as four kinds of trigger
 * rather than a wall of forms.
 *
 * Children stay MOUNTED while collapsed (hidden, not unmounted) for two reasons:
 * the summary chip is fed by the section itself and would go blank the moment
 * you closed it, and a section's own open rows survive collapsing its parent.
 */
export function TriggerCard({ title, blurb, summary, defaultOpen = false, children }: {
  title: string; blurb: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="nxh-disc">
      <button type="button" className="nxh-disc__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="nxh-caret" aria-hidden="true" />
        <span className="nxh-grow">
          <span className="nxh-disc__title">{title}</span>
          <span className="nxh-disc__blurb">{blurb}</span>
        </span>
        {summary !== undefined && summary !== '' && <Chip>{summary}</Chip>}
      </button>
      <div className="nxh-disc__body" hidden={!open}>{children}</div>
    </div>
  );
}

/** A card inside a card — one webhook, one context rule. */
export function SubCard({ children }: { children: ReactNode }) {
  return <div className="nxh-card nxh-card--sub">{children}</div>;
}

/** Header row inside a SubCard: a disclosure caret, a title, and controls. */
export function SubHeader({ open, onToggle, title, sub, right }: {
  open: boolean; onToggle: () => void; title: ReactNode; sub?: ReactNode; right?: ReactNode;
}) {
  return (
    <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
      <button type="button" className="nxh-sub__head" aria-expanded={open} onClick={onToggle}>
        <span className="nxh-caret" aria-hidden="true" />
        <span className="nxh-grow">
          <span className="nxh-sub__title">{title}</span>
          {sub !== undefined && <span className="nxh-sub__sub">{sub}</span>}
        </span>
      </button>
      {right}
    </div>
  );
}

/* ──────────────────────────── trigger mode ───────────────────────────────── */

/** The shared `strict / allow-all / communication-only` gate. Labels and blurbs
 *  come from `TRIGGER_MODES` so webhooks and org can never drift apart. */
export function ModePicker({ value, onChange }: { value: TriggerMode; onChange: (m: TriggerMode) => void }) {
  const current = TRIGGER_MODES.find((m) => m.value === value) ?? TRIGGER_MODES[0];
  return (
    <>
      <Select value={value} onChange={(v) => onChange(v as TriggerMode)} style={{ width: '100%' }}>
        {TRIGGER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </Select>
      <Hint>{current.blurb}</Hint>
    </>
  );
}

/* ──────────────────────────── interval picker ────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

export const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 15 * MINUTE, label: '15m' },
  { ms: 30 * MINUTE, label: '30m' },
  { ms: HOUR, label: '1h' },
  { ms: 2 * HOUR, label: '2h' },
  { ms: 6 * HOUR, label: '6h' },
  { ms: 12 * HOUR, label: '12h' },
  { ms: DAY, label: '24h' },
  { ms: WEEK, label: 'weekly' }
];

/** A truthful label for ANY stored interval, preset or not. Arbitrary intervals
 *  persist now, so the label is computed rather than looked up — a select that
 *  falls back to the nearest preset would quietly lie about the stored value. */
export function fmtInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'off';
  if (ms === WEEK) return 'weekly';
  if (ms % WEEK === 0) return `${ms / WEEK}w`;
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}

const CUSTOM = '__custom';

/**
 * @param minMs/maxMs the range MAIN will actually store. Context rules are
 * clamped to 1 minute … 24 hours on the way in, so offering "weekly" there would
 * put a label on screen that the saved value does not match. Schedules take any
 * interval and pass the default range.
 */
export function IntervalPicker({ value, onChange, minMs = MINUTE, maxMs = Number.POSITIVE_INFINITY }: {
  value: number; onChange: (ms: number) => void; minMs?: number; maxMs?: number;
}) {
  const opts = INTERVAL_OPTS.filter((o) => o.ms >= minMs && o.ms <= maxMs);
  const preset = opts.some((o) => o.ms === value);
  const [custom, setCustom] = useState(!preset);
  const showCustom = custom || !preset;
  const clamp = (ms: number) => Math.min(maxMs, Math.max(minMs, ms));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Select
        value={showCustom ? CUSTOM : String(value)}
        onChange={(v) => {
          if (v === CUSTOM) { setCustom(true); return; }
          setCustom(false);
          onChange(Number(v));
        }}
      >
        {!preset && <option value={CUSTOM}>{fmtInterval(value)} (custom)</option>}
        {opts.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
        {preset && <option value={CUSTOM}>custom…</option>}
      </Select>
      {showCustom && (
        <span className="nxh-row" style={{ gap: 4 }}>
          <input
            type="number"
            className="nxh-input nxh-input--id nxh-input--num"
            aria-label="Minutes"
            min={Math.max(1, Math.round(minMs / MINUTE))}
            max={Number.isFinite(maxMs) ? Math.round(maxMs / MINUTE) : undefined}
            value={Math.max(1, Math.round(value / MINUTE))}
            onChange={(e) => {
              const mins = Number(e.target.value);
              if (Number.isFinite(mins) && mins > 0) onChange(clamp(Math.round(mins) * MINUTE));
            }}
          />
          <span className="nxh-muted">min</span>
        </span>
      )}
    </div>
  );
}

/* ───────────────────────────── percent field ─────────────────────────────── */

export function PctField({ value, onChange }: { value: number; onChange: (pct: number) => void }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
      <input
        type="number"
        className="nxh-input nxh-input--id nxh-input--num"
        aria-label="Percent"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);
        }}
      />
      <span className="nxh-muted">%</span>
      <span className="nxh-meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

/* ────────────────────────────── secret field ─────────────────────────────── */

/** Masked by default; reveals only on demand. The value never lands in a
 *  `title`/tooltip — those leak into screenshots and accessibility trees. */
export function SecretField({ value, revealed, onReveal, onCopy, copied, placeholder, onChange, onBlur }: {
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onCopy?: () => void;
  copied?: boolean;
  placeholder?: string;
  onChange?: (v: string) => void;
  onBlur?: () => void;
}) {
  const readOnly = !onChange;
  return (
    <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
      <input
        type={revealed ? 'text' : 'password'}
        className="nxh-input nxh-input--id"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={onBlur}
      />
      <MiniButton onClick={onReveal}>{revealed ? 'hide' : 'show'}</MiniButton>
      {onCopy && <MiniButton onClick={onCopy} tone={copied ? 'good' : 'plain'}>{copied ? 'copied' : 'copy'}</MiniButton>}
    </div>
  );
}
