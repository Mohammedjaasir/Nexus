# Nexus Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interim title bar and view switch with the Nexus shell. The shell has a registry-driven island launcher, workspace, project and placeholder pages, and an assistant panel wired to the real lead agent. Every existing feature stays reachable, and no backend changes.

**Architecture:**
- **Location:** a self-contained `src/renderer/src/nexus/` module.
- **Pure logic:** `routes`, `registry`, `mapping`, `selectors`, `hotspotNav` and `context` have no React and no `@/` imports, so `test/load-ts.cjs` can unit-test them.
- **React layer:** consumes the existing zustand store and `window.cth` IPC.
- **`App.tsx`:** keeps the gates, hooks and global overlays, and renders `<NexusShell>` with typed `ShellActions` callbacks.
- **Assistant:** sits behind an `AssistantPort` interface. The lead-agent port is the only implementation.

**Tech Stack:**
- Electron 32, electron-vite 2, React 18, TypeScript 5.6, zustand 4
- plain CSS with `--nx-*` custom properties
- `lucide-react` (new; verified absent)
- node:test through `test/load-ts.cjs`

**Spec:** `nexus-phase-a-spec.md` (same folder; to be copied to `docs/superpowers/specs/2026-10-01-nexus-phase-a-design.md` in Task 1)

## Global Constraints

- Real or absent: no invented users, avatars, activity, counts, metrics or progress anywhere in `nexus/`.
- The project bar renders only from `Project.health.healthScore` when it is a finite number in [0, 100], labelled "Repo health", with a tooltip naming the heuristic.
- Features without a backend are disabled controls or `PlannedPage` explainers, labelled "Not available yet" or "Planned".
- `nexus/` never imports `Pixel*` components and never uses `--cth-*` tokens or the retired palette. Only `--nx-*` tokens and class-based CSS (no `style={{}}` except for computed geometry such as hotspot `left`/`top` and bar width).
- No changes to `src/main/**` or `src/preload/**`. No new IPC.
- Inner screens are not redesigned: ProjectCommandCenter, IdePanel, FullscreenTerminal, TaskDetailOverlay, SettingsModal (except one line), AgentStrip, OfficeFloor, OnboardingWizard, HivePicker.
- `localStorage` keys use the `nx.` prefix, and every access is wrapped in try/catch.
- Breakpoints: ≥1280 three columns · 900–1279 rail + assistant sheet · 640–899 workspace grid instead of the island stage · <640 bottom nav.
- `prefers-reduced-motion`: no float, no shimmer, no transform transitions.
- Contrast: text ≥ 4.5:1 and UI boundaries ≥ 3:1 for every `--nx-*` pair used together.
- Run Electron with `ELECTRON_RUN_AS_NODE` unset (this VS Code environment sets it to 1).
- Baseline: `npm run test:focused` and `node --test test/` currently have exactly 11 known failures (`expand-tilde`, `transcript-project-dir`, `cli-install-ladder`, `codex-remote`). "Pass" below means no failures beyond those 11.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `our-platform`; never touch `main`.

## Review Focus

1. **A project whose `domainId` maps to no workspace** (`cybersecurity`, or a future/unknown string). It must still appear in Recent projects and Projects as "Unassigned" and never crash a lookup. → tests in Task 2 (`workspaceForDomain('nope')`) and Task 4 (`recentProjects` with unknown domain).
2. **A project record with `health` missing, or a `healthScore` that is `NaN`, `null`, `-5` or `140`** (older DB rows, analyzer bugs). The bar must not render. → Task 4 `repoHealth` cases.
3. **A hand-typed or stale hash** (`#/w/unknown`, `#/p/` with an empty id, `#/p/a%2Fb`, trailing slashes, `#`). Expect not-found or home, never a throw. → Task 3 cases.
4. **The assistant sending while no lead agent exists, or while the lead agent is booting.** It must not enqueue to a missing id. While booting it queues and says so. → Task 9 `resolveAssistantStatus` pure tests.
5. **`localStorage` throwing** (private mode or quota). The shell must still render, with preferences falling back to defaults. → Task 6 `readPref`/`writePref` tests with a throwing storage stub.

---

### Task 1: Foundation — dependency, tokens, icon names, primitives

**Files:**
- Modify: `package.json`, `package-lock.json` (add `lucide-react`)
- Create: `docs/superpowers/specs/2026-10-01-nexus-phase-a-design.md` (copy of the spec), `docs/superpowers/plans/2026-10-01-nexus-phase-a.md` (this plan)
- Create: `src/renderer/src/nexus/styles/tokens.css`
- Create: `src/renderer/src/nexus/styles/ui.css`
- Create: `src/renderer/src/nexus/iconNames.ts`
- Create: `src/renderer/src/nexus/icons.ts`
- Create: `src/renderer/src/nexus/ui/Button.tsx`, `ui/IconTile.tsx`, `ui/Badge.tsx`, `ui/EmptyState.tsx`, `ui/Skeleton.tsx`, `ui/Sheet.tsx`
- Create: `src/renderer/src/nexus/styles/index.css` (imports every nexus stylesheet)
- Modify: `src/renderer/src/main.tsx` (import `./nexus/styles/index.css` after `./design/global.css`)

**Interfaces:**
- Produces:
  - `NEXUS_ICON_NAMES: readonly string[]` and `type NexusIconName` (from `iconNames.ts`)
  - `ICONS: Record<NexusIconName, LucideIcon>` (from `icons.ts`)
  - `type Hue = 'violet'|'blue'|'orange'|'teal'|'green'|'amber'|'pink'|'slate'` (from `iconNames.ts`)
  - `<Button variant="primary|secondary|ghost" size="sm|md" icon? disabled? onClick? title? type?>`
  - `<IconTile icon hue size="sm|md|lg">`
  - `<Badge tone="neutral|planned|accent">`
  - `<EmptyState icon title body actions?>`
  - `<Skeleton className?>`
  - `<Sheet open onClose side="right|bottom" labelledBy>`

- [ ] **Step 1: Save the spec and plan into the repo**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp "<scratchpad>/nexus-phase-a-spec.md" docs/superpowers/specs/2026-10-01-nexus-phase-a-design.md
cp "<scratchpad>/nexus-phase-a-plan.md" docs/superpowers/plans/2026-10-01-nexus-phase-a.md
```

- [ ] **Step 2: Add lucide-react without re-running the native postinstall**

Run: `npm install --ignore-scripts lucide-react@^1.49.0`
Then run: `npm ls lucide-react react`
Expected: `lucide-react@1.49.x` with no `UNMET PEER DEPENDENCY` for react 18. If the peer range excludes React 18, pin the newest 0.x that supports it (`npm view lucide-react@0 peerDependencies`) instead.

- [ ] **Step 3: Write `iconNames.ts`**

```ts
// Pure: the icon vocabulary Nexus uses. Kept free of the lucide import so pure
// modules (registry, prompts) and node tests can reference names without React.
export const NEXUS_ICON_NAMES = [
  'home', 'workspaces', 'projects', 'artifacts', 'handoffs', 'deployments',
  'files', 'agents', 'integrations', 'settings', 'search', 'sun', 'moon',
  'assistant', 'panel', 'chevronRight', 'chevronLeft', 'more', 'send', 'plus',
  'import', 'refresh', 'lock', 'check', 'circle', 'close', 'sparkles',
  'sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops', 'yourProjects',
  'dataset', 'appBox', 'rocket', 'help'
] as const;
export type NexusIconName = (typeof NEXUS_ICON_NAMES)[number];

export const HUES = ['violet', 'blue', 'orange', 'teal', 'green', 'amber', 'pink', 'slate'] as const;
export type Hue = (typeof HUES)[number];
```

- [ ] **Step 4: Verify the lucide exports exist before mapping them**

Run:
```bash
node -e "const l=require('lucide-react');for(const n of ['House','LayoutGrid','FolderClosed','Boxes','ArrowLeftRight','Rocket','FileCode2','SquareTerminal','Plug','Settings','Search','Sun','Moon','Sparkles','PanelRight','ChevronRight','ChevronLeft','Ellipsis','SendHorizontal','Plus','FolderInput','RefreshCw','Lock','Check','Circle','X','CodeXml','Brain','Atom','ChartColumn','BookOpen','CircleCheckBig','Palette','Cloud','FolderOpen','Database','Package','LifeBuoy'])if(!l[n])console.log('MISSING',n)"
```
Expected: no output. For any `MISSING` name, pick the replacement listed in `node -e "console.log(Object.keys(require('lucide-react')).filter(k=>/<stem>/i.test(k)).slice(0,20))"` and use it in Step 5.

- [ ] **Step 5: Write `icons.ts`**

```ts
import {
  House, LayoutGrid, FolderClosed, Boxes, ArrowLeftRight, Rocket, FileCode2, SquareTerminal,
  Plug, Settings, Search, Sun, Moon, Sparkles, PanelRight, ChevronRight, ChevronLeft, Ellipsis,
  SendHorizontal, Plus, FolderInput, RefreshCw, Lock, Check, Circle, X, CodeXml, Brain, Atom,
  ChartColumn, BookOpen, CircleCheckBig, Palette, Cloud, FolderOpen, Database, Package, LifeBuoy,
  type LucideIcon
} from 'lucide-react';
import type { NexusIconName } from './iconNames';

export type { NexusIconName } from './iconNames';

/** The single import surface for icons inside nexus/. `Record` makes the
 *  compiler reject a name in iconNames.ts that has no glyph here. */
export const ICONS: Record<NexusIconName, LucideIcon> = {
  home: House, workspaces: LayoutGrid, projects: FolderClosed, artifacts: Boxes,
  handoffs: ArrowLeftRight, deployments: Rocket, files: FileCode2, agents: SquareTerminal,
  integrations: Plug, settings: Settings, search: Search, sun: Sun, moon: Moon,
  assistant: Sparkles, panel: PanelRight, chevronRight: ChevronRight, chevronLeft: ChevronLeft,
  more: Ellipsis, send: SendHorizontal, plus: Plus, import: FolderInput, refresh: RefreshCw,
  lock: Lock, check: Check, circle: Circle, close: X, sparkles: Sparkles,
  sde: CodeXml, ml: Brain, dl: Atom, data: ChartColumn, research: BookOpen, qa: CircleCheckBig,
  uiux: Palette, devops: Cloud, yourProjects: FolderOpen, dataset: Database, appBox: Package,
  rocket: Rocket, help: LifeBuoy
};

export function Icon({ name, size = 18, className }: { name: NexusIconName; size?: number; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={1.75} className={className} aria-hidden="true" focusable="false" />;
}
```
Rename the file to `icons.tsx`, since it contains JSX. Every import in this plan uses `'../icons'` / `'./icons'` without an extension.

- [ ] **Step 6: Write `styles/tokens.css`**

```css
/* Nexus design tokens. Semantic, theme-aware. Breakpoints (used verbatim in
   media queries): 1280 (rail+sheet below), 900 (grid instead of stage below),
   640 (bottom nav below). */
:root {
  --nx-font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --nx-font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

  /* Frame: top bar + sidebar (navy in both themes) */
  --nx-frame: #0B1120;
  --nx-frame-raised: #111A2E;
  --nx-frame-hover: #17223A;
  --nx-frame-active: #1F2D4D;
  --nx-frame-border: #1E2A42;
  --nx-frame-text: #E7ECF5;
  --nx-frame-muted: #9AA6BD;
  --nx-frame-faint: #7D8AA3;

  /* Content */
  --nx-canvas: #EEF2F8;
  --nx-surface: #FFFFFF;
  --nx-surface-2: #F5F7FB;
  --nx-surface-hover: #EDF1F8;
  --nx-border: #DDE3EE;
  --nx-border-strong: #7A859A;
  --nx-text: #0F172A;
  --nx-text-2: #334155;
  --nx-text-muted: #5B6578;

  /* Signature */
  --nx-accent: #2457D6;
  --nx-accent-hover: #1D47B3;
  --nx-accent-text: #FFFFFF;
  --nx-accent-2: #7C4DFF;
  --nx-gradient: linear-gradient(90deg, #2F6BFF 0%, #7C4DFF 100%);
  --nx-focus: #2F6BFF;
  --nx-danger: #C2352F;
  --nx-success: #1E7F4F;

  /* Workspace hues: solid (icon tile) + soft (tile background) */
  --nx-hue-violet: #7C4DFF;  --nx-hue-violet-soft: #EEE8FF;
  --nx-hue-blue:   #2F6BFF;  --nx-hue-blue-soft:   #E5EDFF;
  --nx-hue-orange: #E8621C;  --nx-hue-orange-soft: #FFEADD;
  --nx-hue-teal:   #0E8C9A;  --nx-hue-teal-soft:   #DDF4F6;
  --nx-hue-green:  #1E8A4C;  --nx-hue-green-soft:  #DFF3E7;
  --nx-hue-amber:  #8A5A06;  --nx-hue-amber-soft:  #FBEFD3;
  --nx-hue-pink:   #C2338A;  --nx-hue-pink-soft:   #FBE3F1;
  --nx-hue-slate:  #3E5A86;  --nx-hue-slate-soft:  #E3E9F3;

  /* Launcher */
  --nx-sky-top: #BFD8FF;
  --nx-sky-bottom: #F3E8FF;
  --nx-hotspot-bg: rgba(11, 17, 32, 0.84);
  --nx-hotspot-text: #F3F6FC;
  --nx-hotspot-muted: #B7C1D6;

  /* Shape, depth, motion */
  --nx-radius-sm: 8px;
  --nx-radius-md: 12px;
  --nx-radius-lg: 16px;
  --nx-shadow-card: 0 1px 2px rgba(15, 23, 42, 0.06), 0 6px 18px rgba(15, 23, 42, 0.06);
  --nx-shadow-pop: 0 12px 32px rgba(15, 23, 42, 0.22);
  --nx-ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --nx-fast: 140ms;
  --nx-base: 220ms;

  /* Layout */
  --nx-topbar-h: 56px;
  --nx-sidebar-w: 240px;
  --nx-rail-w: 64px;
  --nx-assistant-w: 360px;
  --nx-bottomnav-h: 60px;
}

:root[data-cth-theme='dark'] {
  --nx-canvas: #0E1526;
  --nx-surface: #151E33;
  --nx-surface-2: #1A2540;
  --nx-surface-hover: #1F2B49;
  --nx-border: #26324D;
  --nx-border-strong: #6E7A94;
  --nx-text: #E7ECF5;
  --nx-text-2: #C3CCDD;
  --nx-text-muted: #9AA6BD;
  --nx-accent: #5B8CFF;
  --nx-accent-hover: #7AA2FF;
  --nx-accent-text: #0B1120;
  --nx-focus: #7AA2FF;
  --nx-hue-violet-soft: #2A2350;  --nx-hue-blue-soft: #1C2A52;  --nx-hue-orange-soft: #3D2516;
  --nx-hue-teal-soft: #13353B;    --nx-hue-green-soft: #163626;  --nx-hue-amber-soft: #3A2E12;
  --nx-hue-pink-soft: #3C1A30;    --nx-hue-slate-soft: #22304B;
  --nx-sky-top: #1B2A52;
  --nx-sky-bottom: #2B2147;
  --nx-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4), 0 6px 18px rgba(0, 0, 0, 0.3);
}
```

- [ ] **Step 7: Write the primitives**

`ui/Button.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  icon?: NexusIconName;
  children?: ReactNode;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
  ariaLabel?: string;
}

export function Button({ variant = 'secondary', size = 'md', icon, children, disabled, title, type = 'button', onClick, ariaLabel }: ButtonProps) {
  return (
    <button
      type={type}
      className={`nx-btn nx-btn--${variant} nx-btn--${size}`}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}
```

`ui/IconTile.tsx`:
```tsx
import { Icon, type NexusIconName } from '../icons';
import type { Hue } from '../iconNames';

export function IconTile({ icon, hue, size = 'md' }: { icon: NexusIconName; hue: Hue; size?: 'sm' | 'md' | 'lg' }) {
  const px = size === 'lg' ? 22 : size === 'md' ? 18 : 15;
  return (
    <span className={`nx-tile nx-tile--${size}`} data-hue={hue}>
      <Icon name={icon} size={px} />
    </span>
  );
}
```

`ui/Badge.tsx`:
```tsx
import type { ReactNode } from 'react';
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'planned' | 'accent'; children: ReactNode }) {
  return <span className={`nx-badge nx-badge--${tone}`}>{children}</span>;
}
```

`ui/EmptyState.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';
export function EmptyState({ icon, title, body, actions }: { icon: NexusIconName; title: string; body: ReactNode; actions?: ReactNode }) {
  return (
    <div className="nx-empty" role="status">
      <span className="nx-empty__icon"><Icon name={icon} size={22} /></span>
      <h3 className="nx-empty__title">{title}</h3>
      <div className="nx-empty__body">{body}</div>
      {actions && <div className="nx-empty__actions">{actions}</div>}
    </div>
  );
}
```

`ui/Skeleton.tsx`:
```tsx
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`nx-skeleton ${className}`} aria-hidden="true" />;
}
```

`ui/Sheet.tsx`:
```tsx
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
```

- [ ] **Step 8: Write `styles/ui.css`**

```css
.nx-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font: 500 14px/1 var(--nx-font); border-radius: var(--nx-radius-sm);
  border: 1px solid transparent; cursor: pointer; white-space: nowrap;
  transition: background var(--nx-fast) var(--nx-ease), border-color var(--nx-fast) var(--nx-ease);
}
.nx-btn--md { height: 36px; padding: 0 14px; }
.nx-btn--sm { height: 30px; padding: 0 10px; font-size: 13px; }
.nx-btn--primary { background: var(--nx-accent); color: var(--nx-accent-text); }
.nx-btn--primary:hover:not(:disabled) { background: var(--nx-accent-hover); }
.nx-btn--secondary { background: var(--nx-surface); color: var(--nx-text); border-color: var(--nx-border); }
.nx-btn--secondary:hover:not(:disabled) { background: var(--nx-surface-hover); }
.nx-btn--ghost { background: transparent; color: var(--nx-text-2); }
.nx-btn--ghost:hover:not(:disabled) { background: var(--nx-surface-hover); }
.nx-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.nx-btn:focus-visible, .nx-focusable:focus-visible { outline: 2px solid var(--nx-focus); outline-offset: 2px; }

.nx-tile { display: inline-grid; place-items: center; border-radius: 10px; color: #fff; flex-shrink: 0; }
.nx-tile--sm { width: 28px; height: 28px; border-radius: 8px; }
.nx-tile--md { width: 36px; height: 36px; }
.nx-tile--lg { width: 44px; height: 44px; border-radius: 12px; }
.nx-tile[data-hue='violet'] { background: var(--nx-hue-violet); }
.nx-tile[data-hue='blue']   { background: var(--nx-hue-blue); }
.nx-tile[data-hue='orange'] { background: var(--nx-hue-orange); }
.nx-tile[data-hue='teal']   { background: var(--nx-hue-teal); }
.nx-tile[data-hue='green']  { background: var(--nx-hue-green); }
.nx-tile[data-hue='amber']  { background: var(--nx-hue-amber); }
.nx-tile[data-hue='pink']   { background: var(--nx-hue-pink); }
.nx-tile[data-hue='slate']  { background: var(--nx-hue-slate); }

.nx-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; font: 600 11px/1 var(--nx-font); letter-spacing: 0.02em; }
.nx-badge--neutral { background: var(--nx-surface-2); color: var(--nx-text-muted); border: 1px solid var(--nx-border); }
.nx-badge--planned { background: var(--nx-hue-amber-soft); color: var(--nx-hue-amber); }
.nx-badge--accent  { background: var(--nx-hue-blue-soft); color: var(--nx-accent); }

.nx-empty { display: grid; justify-items: start; gap: 8px; padding: 28px; border: 1px dashed var(--nx-border); border-radius: var(--nx-radius-lg); background: var(--nx-surface); color: var(--nx-text-2); max-width: 640px; }
.nx-empty__icon { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--nx-surface-2); color: var(--nx-text-muted); }
.nx-empty__title { margin: 4px 0 0; font: 600 16px/1.3 var(--nx-font); color: var(--nx-text); }
.nx-empty__body { font: 400 14px/1.55 var(--nx-font); }
.nx-empty__actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }

.nx-skeleton { display: block; border-radius: var(--nx-radius-sm); background: linear-gradient(90deg, var(--nx-surface-2), var(--nx-surface-hover), var(--nx-surface-2)); background-size: 200% 100%; animation: nx-shimmer 1.4s linear infinite; }
@keyframes nx-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.nx-sheet-layer { position: fixed; inset: 0; z-index: 300; }
.nx-sheet-scrim { position: absolute; inset: 0; background: rgba(11, 17, 32, 0.45); }
.nx-sheet { position: absolute; background: var(--nx-surface); box-shadow: var(--nx-shadow-pop); display: flex; flex-direction: column; }
.nx-sheet--right { top: 0; right: 0; bottom: 0; width: min(var(--nx-assistant-w), 100vw); }
.nx-sheet--bottom { left: 0; right: 0; bottom: 0; max-height: 88vh; border-radius: var(--nx-radius-lg) var(--nx-radius-lg) 0 0; }

.nx-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  .nx-skeleton { animation: none; }
}
```

`styles/index.css`:
```css
@import './tokens.css';
@import './ui.css';
```
Later tasks append `@import` lines for `shell.css`, `launcher.css`, `pages.css` and `assistant.css`.

- [ ] **Step 9: Import the styles**

In `src/renderer/src/main.tsx`, after `import './design/global.css';`, add:
```ts
import './nexus/styles/index.css';
```

- [ ] **Step 10: Verify and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add package.json package-lock.json docs/superpowers src/renderer/src/nexus src/renderer/src/main.tsx
git commit -m "feat(nexus): foundation — lucide-react, --nx-* tokens, icon set, primitives"
```

---

### Task 2: Workspace registry and domain mapping (pure, tested)

**Files:**
- Create: `src/renderer/src/nexus/workspaces/types.ts`
- Create: `src/renderer/src/nexus/workspaces/registry.ts`
- Create: `src/renderer/src/nexus/workspaces/mapping.ts`
- Test: `test/nexus-registry.test.cjs`

**Interfaces:**
- Consumes: `NexusIconName`, `NEXUS_ICON_NAMES`, `Hue` from `../iconNames`; `DomainId` from `@shared/domain`; `Project` from `@shared/project`
- Produces:
  - `WORKSPACE_IDS`, `type WorkspaceId`, `interface WorkspaceConfig`, `interface LauncherShortcut`, `interface IslandPoint {x:number;y:number}`
  - `WORKSPACES: WorkspaceConfig[]` (sorted by `order`), `LAUNCHER_SHORTCUTS: LauncherShortcut[]`, `UNMAPPED_DOMAINS: DomainId[]`, `getWorkspace(id: string): WorkspaceConfig | null`
  - `workspaceForDomain(domainId: string): WorkspaceConfig | null`
  - `projectsForWorkspace(projects: Project[], id: WorkspaceId): Project[]`
  - `countsByWorkspace(projects: Project[]): Record<WorkspaceId, number>`
  - `UNASSIGNED_LABEL = 'Unassigned'`

- [ ] **Step 1: Write the failing test** — `test/nexus-registry.test.cjs`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WORKSPACES, LAUNCHER_SHORTCUTS, UNMAPPED_DOMAINS, getWorkspace, WORKSPACE_IDS } =
  loadTs('src/renderer/src/nexus/workspaces/registry.ts');
const { workspaceForDomain, projectsForWorkspace, countsByWorkspace } =
  loadTs('src/renderer/src/nexus/workspaces/mapping.ts');
const { NEXUS_ICON_NAMES, HUES } = loadTs('src/renderer/src/nexus/iconNames.ts');
const { listDomainDefinitions } = loadTs('src/shared/domain.ts');

const ALL_DOMAINS = listDomainDefinitions().map((d) => d.id);

test('registry: phase A workspaces, in order, with unique ids', () => {
  assert.deepEqual(WORKSPACES.map((w) => w.id), ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops']);
  assert.equal(new Set(WORKSPACES.map((w) => w.id)).size, WORKSPACES.length);
  assert.deepEqual([...WORKSPACE_IDS].sort(), WORKSPACES.map((w) => w.id).sort());
});

test('registry: every DomainId is mapped to exactly one workspace or explicitly unmapped', () => {
  for (const d of ALL_DOMAINS) {
    const owners = WORKSPACES.filter((w) => w.domainIds.includes(d));
    const unmapped = UNMAPPED_DOMAINS.includes(d);
    assert.ok(owners.length + (unmapped ? 1 : 0) === 1, `${d}: owners=${owners.map((w) => w.id)} unmapped=${unmapped}`);
  }
  for (const w of WORKSPACES) for (const d of w.domainIds) assert.ok(ALL_DOMAINS.includes(d), `${w.id} lists unknown domain ${d}`);
});

test('registry: defaultDomainId is one of the workspace domains', () => {
  for (const w of WORKSPACES) if (w.defaultDomainId) assert.ok(w.domainIds.includes(w.defaultDomainId), w.id);
});

test('registry: icons and hues are known; copy fields are non-empty', () => {
  for (const w of WORKSPACES) {
    assert.ok(NEXUS_ICON_NAMES.includes(w.icon), `${w.id} icon ${w.icon}`);
    assert.ok(HUES.includes(w.hue), `${w.id} hue ${w.hue}`);
    for (const k of ['label', 'name', 'tagline', 'description']) assert.ok(w[k] && w[k].trim(), `${w.id}.${k}`);
  }
  for (const s of LAUNCHER_SHORTCUTS) assert.ok(NEXUS_ICON_NAMES.includes(s.icon), s.id);
});

test('registry: island points are inside the safe area and not crowded', () => {
  const pts = [...WORKSPACES.map((w) => ({ id: w.id, ...w.island })), ...LAUNCHER_SHORTCUTS.map((s) => ({ id: s.id, ...s.island }))];
  for (const p of pts) {
    assert.ok(p.x >= 10 && p.x <= 90 && p.y >= 10 && p.y <= 90, `${p.id} at ${p.x},${p.y}`);
  }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    assert.ok(d >= 15, `${pts[i].id} and ${pts[j].id} only ${d.toFixed(1)} apart`);
  }
});

test('getWorkspace: known id → config, unknown → null', () => {
  assert.equal(getWorkspace('ml').label, 'ML');
  assert.equal(getWorkspace('nope'), null);
  assert.equal(getWorkspace(''), null);
});

test('workspaceForDomain: mapped, unmapped and unknown domains', () => {
  assert.equal(workspaceForDomain('ai-ml').id, 'ml');
  assert.equal(workspaceForDomain('web-app-dev').id, 'sde');
  assert.equal(workspaceForDomain('cybersecurity'), null);
  assert.equal(workspaceForDomain('nope'), null);
  assert.equal(workspaceForDomain(undefined), null);
});

test('projectsForWorkspace / countsByWorkspace use only real projects', () => {
  const projects = [
    { id: 'a', domainId: 'ai-ml' }, { id: 'b', domainId: 'ai-ml' },
    { id: 'c', domainId: 'web-app-dev' }, { id: 'd', domainId: 'cybersecurity' }, { id: 'e', domainId: 'zzz' }
  ];
  assert.deepEqual(projectsForWorkspace(projects, 'ml').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(projectsForWorkspace(projects, 'qa'), []);
  const counts = countsByWorkspace(projects);
  assert.equal(counts.ml, 2);
  assert.equal(counts.sde, 1);
  assert.equal(counts.qa, 0);
  assert.equal(Object.keys(counts).length, WORKSPACES.length);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-registry.test.cjs`
Expected: FAIL with `ENOENT` (registry.ts does not exist).

- [ ] **Step 3: Write `workspaces/types.ts`**

```ts
import type { DomainId } from '@shared/domain';
import type { Hue, NexusIconName } from '../iconNames';

export const WORKSPACE_IDS = ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops'] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

/** Hotspot centre on the launcher stage, as a percentage of its width/height. */
export interface IslandPoint { x: number; y: number }

export interface WorkspaceConfig {
  id: WorkspaceId;
  label: string;          // short, shown on hotspots: 'SDE'
  name: string;           // long: 'Software Engineering'
  tagline: string;        // 'Code · APIs · Build'
  description: string;    // one sentence for tooltips and the workspace page
  icon: NexusIconName;
  hue: Hue;
  /** Analysed project domains that belong to this workspace (may be empty). */
  domainIds: DomainId[];
  /** Preset for "New project"; omitted when no domain maps here. */
  defaultDomainId?: DomainId;
  island: IslandPoint;
  order: number;
  /** Modules this workspace will gain; shown as "Planned", never clickable. */
  plannedModules: string[];
}

/** A launcher entry that is NOT a workspace (e.g. Your Projects). */
export interface LauncherShortcut {
  id: 'projects';
  label: string;
  tagline: string;
  icon: NexusIconName;
  island: IslandPoint;
}
```

- [ ] **Step 4: Write `workspaces/registry.ts`**

```ts
import type { DomainId } from '@shared/domain';
import type { LauncherShortcut, WorkspaceConfig } from './types';

export { WORKSPACE_IDS } from './types';
export type { WorkspaceConfig, WorkspaceId, LauncherShortcut, IslandPoint } from './types';

/** Adding a workspace = adding an entry here (and an icon name if new).
 *  Launcher, grid, palette, filters and mapping all read this list. */
const ENTRIES: WorkspaceConfig[] = [
  {
    id: 'sde', label: 'SDE', name: 'Software Engineering', tagline: 'Code · APIs · Build',
    description: 'Write, review and ship code, services and APIs with your agents.',
    icon: 'sde', hue: 'violet',
    domainIds: ['software-engineering', 'web-app-dev', 'mobile-dev', 'game-dev', 'embedded-systems', 'robotics-iot', 'blockchain-web3', 'automation-rpa'],
    defaultDomainId: 'software-engineering', island: { x: 28, y: 22 }, order: 1,
    plannedModules: ['Repositories', 'APIs', 'Builds']
  },
  {
    id: 'ml', label: 'ML', name: 'Machine Learning', tagline: 'Datasets · Models · Deploy',
    description: 'Prepare data, train and evaluate models, and get them ready to serve.',
    icon: 'ml', hue: 'blue', domainIds: ['ai-ml'], defaultDomainId: 'ai-ml',
    island: { x: 52, y: 13 }, order: 2, plannedModules: ['Datasets', 'Experiments', 'Models']
  },
  {
    id: 'dl', label: 'DL', name: 'Deep Learning', tagline: 'Training · Experiments',
    description: 'Run training jobs, compare experiments and manage checkpoints.',
    icon: 'dl', hue: 'orange', domainIds: ['computer-vision'], defaultDomainId: 'computer-vision',
    island: { x: 78, y: 22 }, order: 3, plannedModules: ['Training runs', 'Checkpoints', 'Evaluations']
  },
  {
    id: 'data', label: 'Data Analytics', name: 'Data Analytics', tagline: 'Dashboards · Insights',
    description: 'Query data, build dashboards and turn analysis into reports.',
    icon: 'data', hue: 'teal', domainIds: ['data-analytics', 'data-science', 'gis-geospatial'], defaultDomainId: 'data-analytics',
    island: { x: 82, y: 48 }, order: 4, plannedModules: ['Data sources', 'Queries', 'Dashboards']
  },
  {
    id: 'research', label: 'Research', name: 'Research', tagline: 'Explore · Innovate',
    description: 'Investigate ideas, run studies and write up findings.',
    icon: 'research', hue: 'green', domainIds: ['research-scientific'], defaultDomainId: 'research-scientific',
    island: { x: 22, y: 52 }, order: 5, plannedModules: ['Notes', 'Studies', 'Papers']
  },
  {
    id: 'qa', label: 'QA', name: 'Quality Assurance', tagline: 'Test · Automate',
    description: 'Plan and automate tests, and track quality across projects.',
    icon: 'qa', hue: 'amber', domainIds: [],
    island: { x: 38, y: 80 }, order: 6, plannedModules: ['Test plans', 'Test runs', 'Reports']
  },
  {
    id: 'uiux', label: 'UI / UX', name: 'UI / UX Design', tagline: 'Design · Prototype',
    description: 'Design interfaces, build prototypes and maintain design systems.',
    icon: 'uiux', hue: 'pink', domainIds: [],
    island: { x: 80, y: 74 }, order: 7, plannedModules: ['Designs', 'Prototypes', 'Design systems']
  },
  {
    id: 'devops', label: 'DevOps', name: 'DevOps', tagline: 'Deploy · Monitor',
    description: 'Manage environments, pipelines and the services you run.',
    icon: 'devops', hue: 'slate', domainIds: ['devops-cloud'], defaultDomainId: 'devops-cloud',
    island: { x: 60, y: 84 }, order: 8, plannedModules: ['Environments', 'Pipelines', 'Monitoring']
  }
];

export const WORKSPACES: WorkspaceConfig[] = [...ENTRIES].sort((a, b) => a.order - b.order);

export const LAUNCHER_SHORTCUTS: LauncherShortcut[] = [
  { id: 'projects', label: 'Your Projects', tagline: 'Everything you have open', icon: 'yourProjects', island: { x: 52, y: 52 } }
];

/** Domains deliberately without a workspace in phase A. Their projects show
 *  as "Unassigned" — listed, never hidden. */
export const UNMAPPED_DOMAINS: DomainId[] = ['cybersecurity'];

export function getWorkspace(id: string): WorkspaceConfig | null {
  return WORKSPACES.find((w) => w.id === id) ?? null;
}
```

- [ ] **Step 5: Write `workspaces/mapping.ts`**

```ts
import type { Project } from '@shared/project';
import { WORKSPACES } from './registry';
import type { WorkspaceConfig, WorkspaceId } from './types';

export const UNASSIGNED_LABEL = 'Unassigned';

export function workspaceForDomain(domainId: string | undefined | null): WorkspaceConfig | null {
  if (!domainId) return null;
  return WORKSPACES.find((w) => (w.domainIds as string[]).includes(domainId)) ?? null;
}

export function projectsForWorkspace<P extends Pick<Project, 'domainId'>>(projects: P[], id: WorkspaceId): P[] {
  return projects.filter((p) => workspaceForDomain(p.domainId)?.id === id);
}

export function countsByWorkspace(projects: Pick<Project, 'domainId'>[]): Record<WorkspaceId, number> {
  const counts = Object.fromEntries(WORKSPACES.map((w) => [w.id, 0])) as Record<WorkspaceId, number>;
  for (const p of projects) {
    const w = workspaceForDomain(p.domainId);
    if (w) counts[w.id] += 1;
  }
  return counts;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/nexus-registry.test.cjs`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/nexus/workspaces test/nexus-registry.test.cjs
git commit -m "feat(nexus): registry-driven workspaces and domain mapping"
```

---

### Task 3: Hash routes (pure, tested)

**Files:**
- Create: `src/renderer/src/nexus/router/routes.ts`
- Test: `test/nexus-routes.test.cjs`

**Interfaces:**
- Consumes: `WORKSPACE_IDS`, `WorkspaceId` from `../workspaces/types`
- Produces: `type Route`; `parseHash(hash: string): Route`; `formatRoute(r: Route): string` (returns `'#/...'`); `routeTitle(r: Route): string`; `routesEqual(a: Route, b: Route): boolean`

- [ ] **Step 1: Write the failing test** — `test/nexus-routes.test.cjs`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { parseHash, formatRoute, routeTitle } = loadTs('src/renderer/src/nexus/router/routes.ts');

test('parseHash: every route', () => {
  assert.deepEqual(parseHash(''), { name: 'home' });
  assert.deepEqual(parseHash('#'), { name: 'home' });
  assert.deepEqual(parseHash('#/'), { name: 'home' });
  assert.deepEqual(parseHash('#/workspaces'), { name: 'workspaces' });
  assert.deepEqual(parseHash('#/w/ml'), { name: 'workspace', id: 'ml' });
  assert.deepEqual(parseHash('#/projects'), { name: 'projects' });
  assert.deepEqual(parseHash('#/p/proj-1'), { name: 'project', id: 'proj-1' });
  assert.deepEqual(parseHash('#/artifacts'), { name: 'artifacts' });
  assert.deepEqual(parseHash('#/handoffs'), { name: 'handoffs' });
  assert.deepEqual(parseHash('#/deployments'), { name: 'deployments' });
  assert.deepEqual(parseHash('#/agents'), { name: 'agents' });
});

test('parseHash: tolerant of trailing slashes and missing leading slash', () => {
  assert.deepEqual(parseHash('#/projects/'), { name: 'projects' });
  assert.deepEqual(parseHash('#projects'), { name: 'projects' });
});

test('parseHash: bad input is not-found, never a throw', () => {
  assert.deepEqual(parseHash('#/w/unknown'), { name: 'not-found', path: '/w/unknown' });
  assert.deepEqual(parseHash('#/p/'), { name: 'not-found', path: '/p' });
  assert.deepEqual(parseHash('#/nope/x'), { name: 'not-found', path: '/nope/x' });
  assert.deepEqual(parseHash('#/p/%E0%A4%A'), { name: 'not-found', path: '/p/%E0%A4%A' }); // malformed escape
});

test('ids are URL-decoded and round-trip through formatRoute', () => {
  assert.deepEqual(parseHash('#/p/a%2Fb%20c'), { name: 'project', id: 'a/b c' });
  const routes = [
    { name: 'home' }, { name: 'workspaces' }, { name: 'workspace', id: 'uiux' }, { name: 'projects' },
    { name: 'project', id: 'a/b c' }, { name: 'artifacts' }, { name: 'handoffs' }, { name: 'deployments' }, { name: 'agents' }
  ];
  for (const r of routes) assert.deepEqual(parseHash(formatRoute(r)), r);
  assert.equal(formatRoute({ name: 'home' }), '#/');
});

test('routeTitle gives a human page label', () => {
  assert.equal(routeTitle({ name: 'home' }), 'Home');
  assert.equal(routeTitle({ name: 'workspace', id: 'ml' }), 'ML workspace');
  assert.equal(routeTitle({ name: 'agents' }), 'Agents');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-routes.test.cjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `router/routes.ts`**

```ts
import { WORKSPACE_IDS, type WorkspaceId } from '../workspaces/types';

export type Route =
  | { name: 'home' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: WorkspaceId }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'artifacts' }
  | { name: 'handoffs' }
  | { name: 'deployments' }
  | { name: 'agents' }
  | { name: 'not-found'; path: string };

const SIMPLE = ['workspaces', 'projects', 'artifacts', 'handoffs', 'deployments', 'agents'] as const;

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

export function parseHash(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+$/, '');
  if (path === '') return { name: 'home' };
  const parts = path.slice(1).split('/');
  const notFound: Route = { name: 'not-found', path };
  if (parts.length === 1) {
    const head = parts[0] as (typeof SIMPLE)[number];
    return (SIMPLE as readonly string[]).includes(head) ? ({ name: head } as Route) : notFound;
  }
  if (parts.length === 2) {
    const id = decode(parts[1]);
    if (!id) return notFound;
    if (parts[0] === 'w') return (WORKSPACE_IDS as readonly string[]).includes(id) ? { name: 'workspace', id: id as WorkspaceId } : notFound;
    if (parts[0] === 'p') return { name: 'project', id };
  }
  return notFound;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case 'home': return '#/';
    case 'workspace': return `#/w/${encodeURIComponent(r.id)}`;
    case 'project': return `#/p/${encodeURIComponent(r.id)}`;
    case 'not-found': return `#${r.path}`;
    default: return `#/${r.name}`;
  }
}

const TITLES: Record<string, string> = {
  home: 'Home', workspaces: 'Workspaces', projects: 'Projects', project: 'Project',
  artifacts: 'Artifacts', handoffs: 'Handoffs', deployments: 'Deployments', agents: 'Agents', 'not-found': 'Not found'
};

export function routeTitle(r: Route): string {
  if (r.name === 'workspace') {
    const label: Record<WorkspaceId, string> = { sde: 'SDE', ml: 'ML', dl: 'DL', data: 'Data Analytics', research: 'Research', qa: 'QA', uiux: 'UI / UX', devops: 'DevOps' };
    return `${label[r.id]} workspace`;
  }
  return TITLES[r.name];
}

export function routesEqual(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
```

Note: the `#/p/` test expects `path: '/p'` because the trailing slash is stripped before matching.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/nexus-routes.test.cjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/nexus/router/routes.ts test/nexus-routes.test.cjs
git commit -m "feat(nexus): hash route model with parse/format"
```

---

### Task 4: Data selectors (pure, tested)

**Files:**
- Create: `src/renderer/src/nexus/data/selectors.ts`
- Test: `test/nexus-selectors.test.cjs`

**Interfaces:**
- Consumes: `Project` from `@shared/project`
- Produces:
  - `recentProjects<P extends {updatedAt:number;name:string}>(projects: P[], limit?: number): P[]`
  - `repoHealth(p: unknown): number | null`
  - `relativeTime(ts: number, now: number): string`
  - `type SetupStep = { id: 'workspace'|'project'|'artifact'|'deploy'; label: string; state: 'done'|'todo'|'locked'; hint: string }`
  - `setupSteps(input: { lastWorkspace: string | null; projectCount: number }): SetupStep[]`
  - `setupProgress(steps: SetupStep[]): { done: number; available: number; total: number }`

- [ ] **Step 1: Write the failing test** — `test/nexus-selectors.test.cjs`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { recentProjects, repoHealth, relativeTime, setupSteps, setupProgress } =
  loadTs('src/renderer/src/nexus/data/selectors.ts');

test('recentProjects: newest first, limit 4, stable ties by name, input untouched', () => {
  const input = [
    { name: 'b', updatedAt: 5 }, { name: 'a', updatedAt: 5 }, { name: 'c', updatedAt: 9 },
    { name: 'd', updatedAt: 1 }, { name: 'e', updatedAt: 7 }
  ];
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(recentProjects(input).map((p) => p.name), ['c', 'e', 'a', 'b']);
  assert.deepEqual(input, copy);
  assert.deepEqual(recentProjects([], 4), []);
  assert.deepEqual(recentProjects(input, 2).map((p) => p.name), ['c', 'e']);
});

test('repoHealth: only a real finite 0-100 healthScore renders', () => {
  assert.equal(repoHealth({ health: { healthScore: 75 } }), 75);
  assert.equal(repoHealth({ health: { healthScore: 0 } }), 0);
  assert.equal(repoHealth({ health: { healthScore: 99.6 } }), 100);
  for (const bad of [undefined, null, {}, { health: null }, { health: {} },
    { health: { healthScore: NaN } }, { health: { healthScore: null } }, { health: { healthScore: '80' } },
    { health: { healthScore: -5 } }, { health: { healthScore: 140 } }, { health: { healthScore: Infinity } }]) {
    assert.equal(repoHealth(bad), null, JSON.stringify(bad));
  }
});

test('relativeTime: boundaries', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(relativeTime(now - 3 * 86_400_000, now), '3d ago');
  assert.match(relativeTime(now - 40 * 86_400_000, now), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.equal(relativeTime(NaN, now), '');
  assert.equal(relativeTime(now + 60_000, now), 'just now'); // clock skew
});

test('setupSteps: two real steps, two locked', () => {
  const fresh = setupSteps({ lastWorkspace: null, projectCount: 0 });
  assert.deepEqual(fresh.map((s) => [s.id, s.state]), [['workspace', 'todo'], ['project', 'todo'], ['artifact', 'locked'], ['deploy', 'locked']]);
  const done = setupSteps({ lastWorkspace: 'ml', projectCount: 3 });
  assert.deepEqual(done.map((s) => s.state), ['done', 'done', 'locked', 'locked']);
  assert.deepEqual(setupProgress(done), { done: 2, available: 2, total: 4 });
  assert.deepEqual(setupProgress(fresh), { done: 0, available: 2, total: 4 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-selectors.test.cjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `data/selectors.ts`**

```ts
export function recentProjects<P extends { updatedAt: number; name: string }>(projects: P[], limit = 4): P[] {
  return [...projects]
    .sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The analyzer's real `health.healthScore`, or null when absent or invalid.
 *  Null means "do not render a bar" — never substitute a value. */
export function repoHealth(p: unknown): number | null {
  const v = (p as { health?: { healthScore?: unknown } } | null | undefined)?.health?.healthScore;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v);
}

export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export type SetupStep = {
  id: 'workspace' | 'project' | 'artifact' | 'deploy';
  label: string;
  state: 'done' | 'todo' | 'locked';
  hint: string;
};

export function setupSteps(input: { lastWorkspace: string | null; projectCount: number }): SetupStep[] {
  return [
    { id: 'workspace', label: 'Choose a workspace', state: input.lastWorkspace ? 'done' : 'todo', hint: 'Pick the kind of work you are doing on Home.' },
    { id: 'project', label: 'Create or import a project', state: input.projectCount > 0 ? 'done' : 'todo', hint: 'Point Nexus at a folder you want agents to work in.' },
    { id: 'artifact', label: 'Register an artifact', state: 'locked', hint: 'Available in a later phase.' },
    { id: 'deploy', label: 'Deploy an app', state: 'locked', hint: 'Available in a later phase.' }
  ];
}

export function setupProgress(steps: SetupStep[]) {
  return {
    done: steps.filter((s) => s.state === 'done').length,
    available: steps.filter((s) => s.state !== 'locked').length,
    total: steps.length
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/nexus-selectors.test.cjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/nexus/data/selectors.ts test/nexus-selectors.test.cjs
git commit -m "feat(nexus): real-data selectors (recent, repo health, time, setup steps)"
```

---

### Task 5: Hotspot keyboard navigation (pure, tested)

**Files:**
- Create: `src/renderer/src/nexus/launcher/hotspotNav.ts`
- Test: `test/nexus-hotspot-nav.test.cjs`

**Interfaces:**
- Produces: `type Dir = 'left'|'right'|'up'|'down'`; `nextHotspot(points: {x:number;y:number}[], current: number, dir: Dir): number`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { nextHotspot } = loadTs('src/renderer/src/nexus/launcher/hotspotNav.ts');

// 0 centre, 1 right, 2 far right, 3 up, 4 down-left
const pts = [{ x: 50, y: 50 }, { x: 70, y: 52 }, { x: 90, y: 50 }, { x: 52, y: 20 }, { x: 30, y: 80 }];

test('moves to the nearest point in the pressed direction', () => {
  assert.equal(nextHotspot(pts, 0, 'right'), 1);
  assert.equal(nextHotspot(pts, 1, 'right'), 2);
  assert.equal(nextHotspot(pts, 0, 'up'), 3);
  assert.equal(nextHotspot(pts, 0, 'down'), 4);
  assert.equal(nextHotspot(pts, 0, 'left'), 4);
});

test('stays put when nothing lies that way', () => {
  assert.equal(nextHotspot(pts, 2, 'right'), 2);
  assert.equal(nextHotspot(pts, 3, 'up'), 3);
});

test('handles empty and out-of-range input', () => {
  assert.equal(nextHotspot([], 0, 'right'), -1);
  assert.equal(nextHotspot(pts, 99, 'right'), 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-hotspot-nav.test.cjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `launcher/hotspotNav.ts`**

```ts
export type Dir = 'left' | 'right' | 'up' | 'down';

/** Spatial arrow-key navigation over hotspot centres. Candidates must lie in
 *  the pressed direction; the score favours distance along that axis and
 *  penalises sideways drift, so "right" from the centre picks the card to the
 *  right rather than one far above it. */
export function nextHotspot(points: { x: number; y: number }[], current: number, dir: Dir): number {
  if (points.length === 0) return -1;
  if (current < 0 || current >= points.length) return 0;
  const o = points[current];
  let best = current;
  let bestScore = Infinity;
  points.forEach((p, i) => {
    if (i === current) return;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (primary <= 0) return;
    const score = primary + side * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
```

Check the `left` case from the centre: point 4 has dx -20 (primary 20) and dy 30 (side 30), so its score is 80. No other point lies to the left, so the result is 4.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/nexus-hotspot-nav.test.cjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/nexus/launcher/hotspotNav.ts test/nexus-hotspot-nav.test.cjs
git commit -m "feat(nexus): spatial keyboard navigation for launcher hotspots"
```

---

### Task 6: UI state, preferences, route hook, projects hook

**Files:**
- Create: `src/renderer/src/nexus/state/prefs.ts` (pure, tested)
- Create: `src/renderer/src/nexus/state/uiStore.ts`
- Create: `src/renderer/src/nexus/router/useRoute.ts`
- Create: `src/renderer/src/nexus/data/useProjects.ts`
- Test: `test/nexus-prefs.test.cjs`

**Interfaces:**
- Consumes: `parseHash`, `formatRoute`, `Route` (Task 3); existing `useStore` (`projects`, `setProjects`) from `@/store/store`
- Produces:
  - `readPref(storage: Storage | null, key: string): string | null` and `writePref(storage, key, value: string | null): void`; both never throw
  - `useNexusUi` zustand hook with fields:
    - `assistantOpen: boolean`, `setAssistantOpen(open)`, `toggleAssistant()`
    - `paletteOpen: boolean`, `setPaletteOpen(open)`
    - `railExpanded: boolean`, `setRailExpanded(b)`
    - `lastWorkspace: string | null`, `setLastWorkspace(id)`
    - `setupDismissed: boolean`, `dismissSetup()`
    - `draft: string`, `setDraft(s)`
    - `composerFocusTick: number`, `focusComposer()`
  - `useRoute(): Route` and `navigate(r: Route): void`
  - `useProjectsLoader(): { status: 'loading'|'ready'|'error'; error: string | null; refresh(): Promise<void> }` (projects themselves are read from `useStore(s => s.projects)`)

- [ ] **Step 1: Write the failing test** — `test/nexus-prefs.test.cjs`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readPref, writePref } = loadTs('src/renderer/src/nexus/state/prefs.ts');

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };

test('prefs round-trip with nx. prefix and removal', () => {
  const s = memory();
  writePref(s, 'lastWorkspace', 'ml');
  assert.equal(s.getItem('nx.lastWorkspace'), 'ml');
  assert.equal(readPref(s, 'lastWorkspace'), 'ml');
  writePref(s, 'lastWorkspace', null);
  assert.equal(readPref(s, 'lastWorkspace'), null);
});

test('prefs never throw when storage is unavailable', () => {
  assert.equal(readPref(throwing, 'x'), null);
  assert.doesNotThrow(() => writePref(throwing, 'x', 'y'));
  assert.equal(readPref(null, 'x'), null);
  assert.doesNotThrow(() => writePref(null, 'x', 'y'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-prefs.test.cjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `state/prefs.ts`**

```ts
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'nx.';

export function readPref(storage: KV | null, key: string): string | null {
  try { return storage ? storage.getItem(PREFIX + key) : null; } catch { return null; }
}

export function writePref(storage: KV | null, key: string, value: string | null): void {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(PREFIX + key);
    else storage.setItem(PREFIX + key, value);
  } catch { /* storage unavailable: preference simply isn't remembered */ }
}

export function browserStorage(): KV | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/nexus-prefs.test.cjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `state/uiStore.ts`**

```ts
import { create } from 'zustand';
import { browserStorage, readPref, writePref } from './prefs';

interface NexusUi {
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  toggleAssistant: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  railExpanded: boolean;
  setRailExpanded: (b: boolean) => void;
  lastWorkspace: string | null;
  setLastWorkspace: (id: string) => void;
  setupDismissed: boolean;
  dismissSetup: () => void;
  draft: string;
  setDraft: (s: string) => void;
  composerFocusTick: number;
  focusComposer: () => void;
}

const storage = browserStorage();

export const useNexusUi = create<NexusUi>((set) => ({
  assistantOpen: false,
  setAssistantOpen: (open) => set({ assistantOpen: open }),
  toggleAssistant: () => set((s) => ({ assistantOpen: !s.assistantOpen })),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  railExpanded: false,
  setRailExpanded: (b) => set({ railExpanded: b }),
  lastWorkspace: readPref(storage, 'lastWorkspace'),
  setLastWorkspace: (id) => { writePref(storage, 'lastWorkspace', id); set({ lastWorkspace: id }); },
  setupDismissed: readPref(storage, 'setupDismissed') === '1',
  dismissSetup: () => { writePref(storage, 'setupDismissed', '1'); set({ setupDismissed: true }); },
  draft: '',
  setDraft: (s) => set({ draft: s }),
  composerFocusTick: 0,
  focusComposer: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1, assistantOpen: true }))
}));
```

- [ ] **Step 6: Write `router/useRoute.ts`**

```ts
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
```

`parseHash` returns a new object every render. Callers compare with `routesEqual` and never use the route object identity as an effect dependency. Effects depend on `formatRoute(route)` (a string) instead.

- [ ] **Step 7: Write `data/useProjects.ts`**

```ts
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '@/store/store';

interface LoadState { status: 'loading' | 'ready' | 'error'; error: string | null; set: (p: Partial<LoadState>) => void }
const useLoad = create<LoadState>((set) => ({ status: 'loading', error: null, set: (p) => set(p) }));

let inflight: Promise<void> | null = null;

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    useLoad.getState().set({ status: useStore.getState().projects.length ? 'ready' : 'loading', error: null });
    try {
      const list = await window.cth.projectList();
      useStore.getState().setProjects(Array.isArray(list) ? list : []);
      useLoad.getState().set({ status: 'ready', error: null });
    } catch (e) {
      useLoad.getState().set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Loads the real project list once per mount and exposes status + refresh. */
export function useProjectsLoader() {
  const status = useLoad((s) => s.status);
  const error = useLoad((s) => s.error);
  useEffect(() => { void load(); }, []);
  const refresh = useCallback(() => load(), []);
  return { status, error, refresh };
}
```

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && node --test test/nexus-prefs.test.cjs`
Expected: exit 0, PASS.

```bash
git add src/renderer/src/nexus/state src/renderer/src/nexus/router/useRoute.ts src/renderer/src/nexus/data/useProjects.ts test/nexus-prefs.test.cjs
git commit -m "feat(nexus): ui state, safe prefs, hash route hook, projects loader"
```

---

### Task 7: Shell — TopBar, Sidebar, MobileNav, RouteView, AgentsView; App rewiring

**Files:**
- Create: `src/renderer/src/nexus/shellActions.ts`
- Create: `src/renderer/src/nexus/NexusShell.tsx`
- Create: `src/renderer/src/nexus/chrome/TopBar.tsx`, `chrome/Sidebar.tsx`, `chrome/MobileNav.tsx`, `chrome/navItems.ts`
- Create: `src/renderer/src/nexus/routes/RouteView.tsx`
- Create: `src/renderer/src/nexus/pages/AgentsView.tsx` (JSX moved from `App.tsx`)
- Create: `src/renderer/src/nexus/pages/NotFoundPage.tsx`
- Create: `src/renderer/src/nexus/styles/shell.css`; append `@import './shell.css';` to `styles/index.css`
- Modify: `src/renderer/src/App.tsx` (title bar, `mainView`, `ViewTab`, floor JSX → `<NexusShell actions=…>`; re-add an import modal owned by App)
- Modify: `src/renderer/src/components/SettingsModal.tsx:149` (also clear `nx.` keys on reset)

**Interfaces:**
- Consumes: `useRoute`, `navigate`, `formatRoute`, `routeTitle`, `useNexusUi`, `Icon`, `Button`; the existing `useStore`, `useAppTheme`, `toggleAppTheme`, `UpdateBadge`, and the existing floor components
- Produces:
  - `interface ShellActions { openSettings(section?: SettingsSection): void; openNewProject(domainId?: DomainId): void; openImport(): void; openIde(): void; openProjectManager(): void }`
  - `ShellActionsContext` + `useShellActions()`
  - `<NexusShell config={HarnessConfig} actions={ShellActions} />`
  - `<RouteView config />`
  - `<AgentsView config />`
  - `NAV_MAIN`, `NAV_RESOURCES`: `NavItem[]` where `NavItem = { id: string; label: string; icon: NexusIconName; route?: Route; action?: keyof ShellActions; planned?: boolean }`

Placeholder pages are stubbed in this task as `PlannedStub`, and replaced in Tasks 8–10.

- [ ] **Step 1: Write `shellActions.ts`**

```ts
import { createContext, useContext } from 'react';
import type { DomainId } from '@shared/domain';
import type { Section as SettingsSection } from '@/components/SettingsModal';

export interface ShellActions {
  openSettings: (section?: SettingsSection) => void;
  openNewProject: (domainId?: DomainId) => void;
  openImport: () => void;
  openIde: () => void;
  openProjectManager: () => void;
}

export const ShellActionsContext = createContext<ShellActions | null>(null);

export function useShellActions(): ShellActions {
  const a = useContext(ShellActionsContext);
  if (!a) throw new Error('useShellActions outside NexusShell');
  return a;
}
```

- [ ] **Step 2: Write `chrome/navItems.ts`**

```ts
import type { NexusIconName } from '../iconNames';
import type { Route } from '../router/routes';
import type { ShellActions } from '../shellActions';

export interface NavItem {
  id: string;
  label: string;
  icon: NexusIconName;
  route?: Route;
  action?: keyof ShellActions;
  planned?: boolean;
}

export const NAV_MAIN: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', route: { name: 'home' } },
  { id: 'workspaces', label: 'Workspaces', icon: 'workspaces', route: { name: 'workspaces' } },
  { id: 'projects', label: 'Projects', icon: 'projects', route: { name: 'projects' } },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifacts', route: { name: 'artifacts' }, planned: true },
  { id: 'handoffs', label: 'Handoffs', icon: 'handoffs', route: { name: 'handoffs' }, planned: true },
  { id: 'deployments', label: 'Deployments', icon: 'deployments', route: { name: 'deployments' }, planned: true }
];

export const NAV_RESOURCES: NavItem[] = [
  { id: 'files', label: 'Files', icon: 'files', action: 'openIde' },
  { id: 'agents', label: 'Agents', icon: 'agents', route: { name: 'agents' } },
  { id: 'integrations', label: 'Integrations', icon: 'integrations', action: 'openSettings' },
  { id: 'settings', label: 'Settings', icon: 'settings', action: 'openSettings' }
];

/** Which nav item a route highlights (workspace → Workspaces, project → Projects). */
export function activeNavId(r: Route): string | null {
  switch (r.name) {
    case 'workspace': return 'workspaces';
    case 'project': return 'projects';
    case 'not-found': return null;
    default: return r.name;
  }
}
```

`Integrations` calls `openSettings('Connections')`. The Sidebar special-cases `id === 'integrations'` (Step 4).

- [ ] **Step 3: Write `chrome/TopBar.tsx`**

```tsx
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { UpdateBadge } from '@/components/UpdateBadge';
import { Icon } from '../icons';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function TopBar() {
  const theme = useAppTheme();
  const setPaletteOpen = useNexusUi((s) => s.setPaletteOpen);
  const toggleAssistant = useNexusUi((s) => s.toggleAssistant);
  const actions = useShellActions();
  return (
    <header className={`nx-topbar cth-titlebar-drag${IS_MAC ? ' nx-topbar--mac' : ''}`}>
      <a className="nx-brand cth-titlebar-nodrag nx-focusable" href="#/" aria-label="Nexus home">
        <span className="nx-brand__mark" aria-hidden="true" />
        <span className="nx-brand__name">Nexus</span>
        <span className="nx-brand__beta">Beta</span>
      </a>
      <button type="button" className="nx-search cth-titlebar-nodrag nx-focusable" onClick={() => setPaletteOpen(true)} aria-label="Search projects, workspaces and pages">
        <Icon name="search" size={16} />
        <span className="nx-search__text">Search projects, workspaces, pages…</span>
        <kbd className="nx-search__kbd">{IS_MAC ? '⌘ K' : 'Ctrl K'}</kbd>
      </button>
      <div className="nx-topbar__right cth-titlebar-nodrag">
        <span className="nx-topbar__version"><UpdateBadge /></span>
        <button type="button" className="nx-iconbtn nx-focusable nx-only-compact" onClick={toggleAssistant} aria-label="Toggle assistant" title="Assistant (Ctrl/⌘ J)">
          <Icon name="assistant" />
        </button>
        <button
          type="button"
          className="nx-iconbtn nx-focusable"
          onClick={() => { const next = toggleAppTheme(); void window.cth.updateConfig({ terminalTheme: next }); }}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={() => actions.openSettings()} aria-label="Settings" title="Settings">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
```

The `updateConfig({ terminalTheme })` mirror is preserved from the old title bar.

- [ ] **Step 4: Write `chrome/Sidebar.tsx`**

```tsx
import { Icon } from '../icons';
import { navigate, useRoute } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { NAV_MAIN, NAV_RESOURCES, activeNavId, type NavItem } from './navItems';
import { SetupCard } from './SetupCard';

export function Sidebar() {
  const route = useRoute();
  const active = activeNavId(route);
  const actions = useShellActions();
  const expanded = useNexusUi((s) => s.railExpanded);
  const setExpanded = useNexusUi((s) => s.setRailExpanded);

  const run = (item: NavItem) => {
    if (item.route) { navigate(item.route); return; }
    if (item.id === 'integrations') { actions.openSettings('Connections'); return; }
    if (item.action === 'openSettings') { actions.openSettings(); return; }
    if (item.action) actions[item.action]();
  };

  const renderItem = (item: NavItem) => (
    <li key={item.id}>
      <button
        type="button"
        className={`nx-nav__item nx-focusable${active === item.id ? ' is-active' : ''}`}
        aria-current={active === item.id ? 'page' : undefined}
        onClick={() => run(item)}
        title={item.label}
      >
        <Icon name={item.icon} size={19} />
        <span className="nx-nav__label">{item.label}</span>
        {item.planned && <span className="nx-nav__soon">Soon</span>}
      </button>
    </li>
  );

  return (
    <nav
      className={`nx-sidebar${expanded ? ' is-expanded' : ''}`}
      aria-label="Main"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setExpanded(false); }}
    >
      <ul className="nx-nav">{NAV_MAIN.map(renderItem)}</ul>
      <div className="nx-nav__heading">Resources</div>
      <ul className="nx-nav">{NAV_RESOURCES.map(renderItem)}</ul>
      <div className="nx-sidebar__foot"><SetupCard /></div>
    </nav>
  );
}
```

`SetupCard` is created in Task 8. In this task, create a temporary `chrome/SetupCard.tsx` that exports `export function SetupCard() { return null; }`, so this task compiles. Task 8 replaces the body.

- [ ] **Step 5: Write `chrome/MobileNav.tsx`**

```tsx
import { Icon } from '../icons';
import { navigate, useRoute } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { activeNavId } from './navItems';

export function MobileNav() {
  const route = useRoute();
  const active = activeNavId(route);
  const toggleAssistant = useNexusUi((s) => s.toggleAssistant);
  const assistantOpen = useNexusUi((s) => s.assistantOpen);
  const item = (id: string, label: string, icon: 'home' | 'projects' | 'agents', go: () => void) => (
    <button type="button" className={`nx-bottomnav__item nx-focusable${active === id ? ' is-active' : ''}`} aria-current={active === id ? 'page' : undefined} onClick={go}>
      <Icon name={icon} size={20} /><span>{label}</span>
    </button>
  );
  return (
    <nav className="nx-bottomnav" aria-label="Main">
      {item('home', 'Home', 'home', () => navigate({ name: 'home' }))}
      {item('projects', 'Projects', 'projects', () => navigate({ name: 'projects' }))}
      {item('agents', 'Agents', 'agents', () => navigate({ name: 'agents' }))}
      <button type="button" className={`nx-bottomnav__item nx-focusable${assistantOpen ? ' is-active' : ''}`} onClick={toggleAssistant} aria-expanded={assistantOpen}>
        <Icon name="assistant" size={20} /><span>Assistant</span>
      </button>
    </nav>
  );
}
```

- [ ] **Step 6: Write `pages/AgentsView.tsx`** (moved from `App.tsx`; behaviour unchanged)

Cut the block from `App.tsx` that starts at `<div style={{ flex: 1, minHeight: 0, display: 'flex', padding: 16, gap: 0 }}>` (the non-project branch of the main switch) and ends before `{/* Agent Strip ... */}`. Paste it into this component together with `<AgentStrip config={config} />`, plus a small toolbar above it:

```tsx
import { useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { MichaelBooting } from '@/components/MichaelBooting';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon as PixelIcon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { Icon } from '../icons';

/** The legacy agents floor, hosted unchanged inside the Nexus shell. This is
 *  the one Nexus file allowed to use Pixel* components: it wraps the legacy
 *  view verbatim until the Agents view is redesigned. */
export function AgentsView({ config }: { config: HarnessConfig }) {
  const agent = useStore(selectedAgent);
  const agentCount = useStore((s) => s.agents.length);
  const godStatus = useStore((s) => s.godStatus);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const [vpWidth, setVpWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleFullscreen = () => {
    const s = useStore.getState();
    if (fullscreenAgentId) { s.setFullscreen(null); return; }
    const target = s.agents.find((x) => x.id === s.selectedId && x.ptyId) ?? s.agents.find((x) => x.isGod && x.ptyId) ?? s.agents.find((x) => x.ptyId);
    if (target) s.setFullscreen(target.id);
  };

  return (
    <div className="nx-agents">
      <div className="nx-agents__bar">
        <h1 className="nx-agents__title">Agents</h1>
        <span className="nx-badge nx-badge--neutral">{config.autoMode ? 'Auto mode on' : 'Auto mode off'}</span>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={toggleFullscreen} aria-label="Toggle fullscreen terminal" title="Fullscreen terminal (selected agent)">
          <Icon name="panel" />
        </button>
      </div>
      {/* ── moved verbatim from App.tsx: floor + splitter + detail sidebar ── */}
      {/* (paste the cut block here; it references agent, agentCount, godStatus,
           setAddAgentOpen, sidebarWidth, setSidebarWidth, vpWidth, PixelPanel,
           PixelButton and Icon — rename that file's `Icon` usages to `PixelIcon`) */}
      <AgentStrip config={config} />
    </div>
  );
}
```

The cut block is the exact JSX currently at `App.tsx` lines ~456–561 (the `<div style={{ flex: 1, minHeight: 0, display: 'flex', padding: 16, gap: 0 }}>` element). Paste it **as is**, then replace `<Icon name="plus" />` with `<PixelIcon name="plus" />` inside it. That's the only edit.

- [ ] **Step 7: Write `pages/NotFoundPage.tsx` and a temporary `PlannedStub`**

```tsx
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { navigate } from '../router/useRoute';

export function NotFoundPage({ message = "That page doesn't exist." }: { message?: string }) {
  return (
    <div className="nx-page">
      <EmptyState icon="close" title="Not found" body={message}
        actions={<Button variant="primary" onClick={() => navigate({ name: 'home' })}>Go to Home</Button>} />
    </div>
  );
}
```

- [ ] **Step 8: Write `routes/RouteView.tsx`** (final form; imports pages created in later tasks)

In this task, `RouteView` renders `home`, `workspaces`, `workspace`, `projects`, `project`, `artifacts`, `handoffs` and `deployments` as `<NotFoundPage message="Coming in this build." />`, and `agents` as `<AgentsView config={config} />`. Tasks 8–10 swap each line for the real page.

```tsx
import { useEffect, useRef } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useRoute } from '../router/useRoute';
import { formatRoute, routeTitle } from '../router/routes';
import { AgentsView } from '../pages/AgentsView';
import { NotFoundPage } from '../pages/NotFoundPage';

export function RouteView({ config }: { config: HarnessConfig }) {
  const route = useRoute();
  const key = formatRoute(route);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
    mainRef.current?.querySelector<HTMLElement>('h1')?.focus?.();
    document.title = `${routeTitle(route)} · Nexus`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  let page;
  switch (route.name) {
    case 'agents': page = <AgentsView config={config} />; break;
    case 'not-found': page = <NotFoundPage />; break;
    default: page = <NotFoundPage message="Coming in this build." />;
  }
  return <main ref={mainRef} className={`nx-main${route.name === 'agents' ? ' nx-main--flush' : ''}`} id="nx-main">{page}</main>;
}
```

Page `<h1>` elements get `tabIndex={-1}` so focus can land on them.

- [ ] **Step 9: Write `NexusShell.tsx`**

```tsx
import type { HarnessConfig } from '@/store/config';
import { ShellActionsContext, type ShellActions } from './shellActions';
import { TopBar } from './chrome/TopBar';
import { Sidebar } from './chrome/Sidebar';
import { MobileNav } from './chrome/MobileNav';
import { RouteView } from './routes/RouteView';
import { useProjectsLoader } from './data/useProjects';

export function NexusShell({ config, actions }: { config: HarnessConfig; actions: ShellActions }) {
  useProjectsLoader();
  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="nx-shell">
        <a className="nx-skip nx-focusable" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById('nx-main')?.focus(); }}>Skip to content</a>
        <TopBar />
        <Sidebar />
        <RouteView config={config} />
        <aside className="nx-assistant-slot" aria-label="Assistant" />
        <MobileNav />
      </div>
    </ShellActionsContext.Provider>
  );
}
```

`nx-assistant-slot` stays empty until Task 9 mounts the panel.

- [ ] **Step 10: Write `styles/shell.css`**

```css
.nx-shell {
  height: 100vh; display: grid; overflow: hidden;
  grid-template-columns: var(--nx-sidebar-w) minmax(0, 1fr) var(--nx-assistant-w);
  grid-template-rows: var(--nx-topbar-h) minmax(0, 1fr);
  grid-template-areas: 'top top top' 'side main assist';
  background: var(--nx-frame); font-family: var(--nx-font); color: var(--nx-text);
}
.nx-skip { position: absolute; left: -999px; top: 8px; z-index: 500; background: var(--nx-surface); color: var(--nx-text); padding: 8px 12px; border-radius: var(--nx-radius-sm); }
.nx-skip:focus { left: 8px; }

/* Top bar */
.nx-topbar { grid-area: top; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: var(--nx-frame); color: var(--nx-frame-text); border-bottom: 1px solid var(--nx-frame-border); }
.nx-topbar--mac { padding-left: 84px; }
.nx-brand { display: inline-flex; align-items: center; gap: 10px; color: var(--nx-frame-text); text-decoration: none; min-width: 200px; }
.nx-brand__mark { width: 26px; height: 26px; border-radius: 8px; background: var(--nx-gradient); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2); position: relative; }
.nx-brand__mark::after { content: ''; position: absolute; inset: 7px; border-radius: 3px; border: 2px solid rgba(255,255,255,0.9); transform: rotate(45deg); }
.nx-brand__name { font: 800 18px/1 var(--nx-font); letter-spacing: 0.04em; text-transform: uppercase; }
.nx-brand__beta { font: 600 11px/1 var(--nx-font); padding: 4px 8px; border-radius: 999px; background: var(--nx-frame-active); color: var(--nx-frame-muted); }
.nx-search { flex: 1; max-width: 560px; margin: 0 auto; height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 12px; border-radius: 10px; border: 1px solid var(--nx-frame-border); background: var(--nx-frame-raised); color: var(--nx-frame-muted); cursor: text; font: 400 14px/1 var(--nx-font); }
.nx-search:hover { border-color: var(--nx-frame-faint); }
.nx-search__text { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-search__kbd { font: 600 11px/1 var(--nx-font); padding: 4px 6px; border-radius: 6px; background: var(--nx-frame-active); color: var(--nx-frame-muted); }
.nx-topbar__right { display: flex; align-items: center; gap: 6px; }
.nx-topbar__version { display: inline-flex; color: var(--nx-frame-muted); }
.nx-iconbtn { width: 36px; height: 36px; display: inline-grid; place-items: center; border-radius: 10px; border: 0; background: transparent; color: inherit; cursor: pointer; }
.nx-topbar .nx-iconbtn { color: var(--nx-frame-muted); }
.nx-topbar .nx-iconbtn:hover { background: var(--nx-frame-hover); color: var(--nx-frame-text); }
.nx-main .nx-iconbtn { color: var(--nx-text-2); }
.nx-main .nx-iconbtn:hover { background: var(--nx-surface-hover); }
.nx-only-compact { display: none; }

/* Sidebar */
.nx-sidebar { grid-area: side; display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; background: var(--nx-frame); color: var(--nx-frame-text); overflow-y: auto; }
.nx-nav { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nx-nav__item { width: 100%; display: flex; align-items: center; gap: 12px; height: 42px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--nx-frame-muted); font: 500 15px/1 var(--nx-font); cursor: pointer; text-align: left; position: relative; }
.nx-nav__item:hover { background: var(--nx-frame-hover); color: var(--nx-frame-text); }
.nx-nav__item.is-active { background: var(--nx-frame-active); color: var(--nx-frame-text); }
.nx-nav__item.is-active::before { content: ''; position: absolute; left: -10px; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--nx-gradient); }
.nx-nav__label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-nav__soon { font: 600 10px/1 var(--nx-font); padding: 3px 6px; border-radius: 999px; background: var(--nx-frame-raised); color: var(--nx-frame-faint); }
.nx-nav__heading { margin: 16px 12px 6px; font: 600 11px/1 var(--nx-font); letter-spacing: 0.08em; text-transform: uppercase; color: var(--nx-frame-faint); }
.nx-sidebar__foot { margin-top: auto; padding-top: 12px; }

/* Main */
.nx-main { grid-area: main; min-width: 0; min-height: 0; overflow-y: auto; background: var(--nx-canvas); border-top-left-radius: var(--nx-radius-lg); outline: none; }
.nx-main--flush { overflow: hidden; display: flex; }
.nx-page { padding: 28px 32px 48px; display: grid; gap: 24px; align-content: start; max-width: 1280px; }
.nx-page h1 { outline: none; }

/* Assistant column */
.nx-assistant-slot { grid-area: assist; min-height: 0; background: var(--nx-canvas); border-left: 1px solid var(--nx-border); }

/* Agents (legacy floor host) */
.nx-agents { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.nx-agents__bar { display: flex; align-items: center; gap: 12px; padding: 12px 16px 0; }
.nx-agents__title { margin: 0; font: 700 18px/1.2 var(--nx-font); color: var(--nx-text); }
.nx-agents__bar .nx-iconbtn { margin-left: auto; }

/* Bottom nav (mobile only) */
.nx-bottomnav { display: none; }

/* ── < 1280: icon rail + assistant sheet ── */
@media (max-width: 1279px) {
  .nx-shell { grid-template-columns: var(--nx-rail-w) minmax(0, 1fr); grid-template-areas: 'top top' 'side main'; }
  .nx-assistant-slot { display: none; }
  .nx-only-compact { display: inline-grid; }
  .nx-sidebar { position: relative; z-index: 20; width: var(--nx-rail-w); padding: 12px 8px; transition: width var(--nx-base) var(--nx-ease); }
  .nx-sidebar .nx-nav__label, .nx-sidebar .nx-nav__soon, .nx-sidebar .nx-nav__heading, .nx-sidebar .nx-sidebar__foot { display: none; }
  .nx-sidebar.is-expanded { width: var(--nx-sidebar-w); box-shadow: var(--nx-shadow-pop); }
  .nx-sidebar.is-expanded .nx-nav__label, .nx-sidebar.is-expanded .nx-nav__soon, .nx-sidebar.is-expanded .nx-nav__heading, .nx-sidebar.is-expanded .nx-sidebar__foot { display: revert; }
  .nx-nav__item { justify-content: center; padding: 0; }
  .nx-sidebar.is-expanded .nx-nav__item { justify-content: flex-start; padding: 0 12px; }
  .nx-brand { min-width: 0; }
}

/* ── < 640: bottom nav, no sidebar ── */
@media (max-width: 639px) {
  .nx-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: var(--nx-topbar-h) minmax(0, 1fr) calc(var(--nx-bottomnav-h) + env(safe-area-inset-bottom)); grid-template-areas: 'top' 'main' 'bottom'; }
  .nx-sidebar { display: none; }
  .nx-main { border-radius: 0; }
  .nx-search { flex: 0 0 auto; width: 40px; padding: 0; justify-content: center; margin: 0 0 0 auto; }
  .nx-search__text, .nx-search__kbd, .nx-brand__beta, .nx-topbar__version { display: none; }
  .nx-page { padding: 20px 16px 32px; }
  .nx-bottomnav { grid-area: bottom; display: grid; grid-template-columns: repeat(4, 1fr); background: var(--nx-frame); border-top: 1px solid var(--nx-frame-border); padding-bottom: env(safe-area-inset-bottom); }
  .nx-bottomnav__item { display: grid; place-items: center; gap: 2px; min-height: 56px; border: 0; background: transparent; color: var(--nx-frame-muted); font: 500 11px/1 var(--nx-font); cursor: pointer; }
  .nx-bottomnav__item.is-active { color: var(--nx-frame-text); }
}

@media (prefers-reduced-motion: reduce) {
  .nx-sidebar { transition: none; }
}
```

- [ ] **Step 11: Rewire `App.tsx`**

1. Remove imports that are no longer used: `UpdateBadge`, `useAppTheme`, `toggleAppTheme`, `PixelPanel`, `PixelButton`, `Icon`, `SidebarSplitter`, `OfficeFloor`, `MemoryPanel`, `AgentDetailPanel`, `AgentStrip`, `MichaelBooting`, `ProjectCommandCenter`, `getDomainDefinition`, `brandLogo`, `selectedAgent`. Run `npm run typecheck` after the edit; it flags any that are still in use.
2. Remove the `mainView` state, the `vpWidth` state and its effect (they move to AgentsView), the whole `{/* Title bar */}` element, the main `{mainView === 'project' ... }` switch, `<AgentStrip>`, `ViewTab` and the title-bar glyph components (`Glyph`, `ExpandGlyph`, `CollapseGlyph`, `GearGlyph`). AgentsView uses lucide icons now.
3. Add state: `const [importOpen, setImportOpen] = useState(false); const [newProjectDomain, setNewProjectDomain] = useState<DomainId | undefined>();`, plus imports for `ProjectImportModal`, `type DomainId`, `NexusShell`, `navigate`, `type ShellActions`.
4. Build the actions (inside `App`, before the returns):

```tsx
const shellActions: ShellActions = useMemo(() => ({
  openSettings: (section) => { setSettingsSection(section); setSettingsOpen(true); },
  openNewProject: (domainId) => { setNewProjectDomain(domainId); setNewProjectWizardOpen(true); },
  openImport: () => setImportOpen(true),
  openIde: () => {
    const s = useStore.getState();
    const target = s.agents.find((a) => a.id === s.selectedId) ?? s.agents.find((a) => a.isGod) ?? null;
    s.setIdeOpen(true, target?.id ?? null);
  },
  openProjectManager: () => setProjectDashboardOpen(true)
}), []);
```

5. Replace the returned tree with:

```tsx
return (
  <>
    <CompletionToast />
    <UpdateToast />
    <NexusShell config={config} actions={shellActions} />
    {newProjectWizardOpen && (
      <NewProjectWizardModal
        isOpen={newProjectWizardOpen}
        initialDomainId={newProjectDomain}
        onClose={() => setNewProjectWizardOpen(false)}
        onProjectCreated={(p) => {
          setActiveProject(p);
          void window.cth.projectList().then((l) => setProjects(l ?? []));
          navigate({ name: 'project', id: p.id });
        }}
      />
    )}
    <ProjectImportModal
      isOpen={importOpen}
      onClose={() => setImportOpen(false)}
      onImportSuccess={async () => {
        const [list, act] = await Promise.all([window.cth.projectList(), window.cth.projectGetActive()]);
        setProjects(list ?? []);
        if (act) { setActiveProject(act); navigate({ name: 'project', id: act.id }); }
      }}
    />
    {/* everything below is unchanged from the previous return */}
    {addAgentOpen && (<AddAgentModal onClose={() => setAddAgentOpen(false)} config={config} onConfigChange={setConfig} />)}
    {settingsOpen && (<SettingsModal config={config} initialSection={settingsSection} onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }} />)}
    {quitWarn && (/* unchanged QuitWarningModal block */ null)}
    {fullscreenAgentId && <FullscreenTerminal config={config} />}
    {fullscreenFilePath && <FullscreenFileEditor />}
    {ideOpen && <IdePanel />}
    <TaskDetailOverlay />
    <ProjectDashboardModal
      isOpen={projectDashboardOpen}
      onClose={() => setProjectDashboardOpen(false)}
      onNewProject={() => { setProjectDashboardOpen(false); setNewProjectWizardOpen(true); }}
      onOpenProject={() => {
        setProjectDashboardOpen(false);
        const p = useStore.getState().activeProject;
        if (p) navigate({ name: 'project', id: p.id });
      }}
    />
  </>
);
```

Keep the existing `QuitWarningModal` JSX exactly as it is now, in place of the `/* unchanged */` placeholder shown above. Also keep the `!config` and gate returns as they are, but change the `!config` placeholder background from `var(--cth-cream-100)` to `var(--nx-frame)`.

- [ ] **Step 12: Reset clears `nx.` keys too**

In `src/renderer/src/components/SettingsModal.tsx`, change the line `if (k && k.startsWith('cth.')) keys.push(k);` to:
```ts
      if (k && (k.startsWith('cth.') || k.startsWith('nx.'))) keys.push(k);
```

- [ ] **Step 13: Verify and commit**

Run: `npm run typecheck && npm run test:focused`
Expected: typecheck exit 0; focused tests show only the 11 baseline failures.

```bash
git add src/renderer/src/nexus src/renderer/src/App.tsx src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(nexus): shell (top bar, sidebar, mobile nav, routing); agents floor hosted as a route"
```

---

### Task 8: Pages — Projects, Project, Workspaces, Workspace, Planned; Setup card

**Files:**
- Create: `src/renderer/src/nexus/pages/ProjectsPage.tsx`, `pages/ProjectPage.tsx`, `pages/WorkspacesPage.tsx`, `pages/WorkspacePage.tsx`, `pages/PlannedPage.tsx`, `pages/plannedContent.ts`
- Create: `src/renderer/src/nexus/components/ProjectRow.tsx`, `components/RepoHealthBar.tsx`, `components/LoadStates.tsx`
- Replace: `src/renderer/src/nexus/chrome/SetupCard.tsx`
- Create: `src/renderer/src/nexus/styles/pages.css`; append the import to `styles/index.css`
- Modify: `src/renderer/src/nexus/routes/RouteView.tsx` (wire the pages)

**Interfaces:**
- Consumes: Task 2 mapping and registry, Task 4 selectors, Task 6 hooks, Task 7 `useShellActions`, primitives; the existing `ProjectCommandCenter` (`project`, `onBackToHome`, `onRefreshProject`)
- Produces:
  - `<RepoHealthBar project />`: renders null when `repoHealth(project)` is null
  - `<ProjectRow project onOpen />`
  - `<ProjectsLoadState status error onRetry>` (skeleton, error and retry)
  - `PLANNED: Record<'artifacts'|'handoffs'|'deployments', PlannedContent>`

- [ ] **Step 1: `components/RepoHealthBar.tsx`**

```tsx
import { repoHealth } from '../data/selectors';

const TIP = 'Heuristic from the project analyzer: tests, docs, entry points and git status.';

export function RepoHealthBar({ project }: { project: unknown }) {
  const v = repoHealth(project);
  if (v === null) return null;
  return (
    <div className="nx-health" title={TIP}>
      <span className="nx-health__label">Repo health <strong>{v}</strong></span>
      <span className="nx-health__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={`Repo health ${v} of 100`}>
        <span className="nx-health__fill" style={{ width: `${v}%` }} />
      </span>
    </div>
  );
}
```

- [ ] **Step 2: `components/LoadStates.tsx`**

```tsx
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

export function RowsSkeleton({ count = 4 }: { count?: number }) {
  return <div className="nx-rows" aria-busy="true" aria-label="Loading projects">{Array.from({ length: count }, (_, i) => <Skeleton key={i} className="nx-skel-row" />)}</div>;
}

export function LoadError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <EmptyState icon="refresh" title="Couldn't load projects" body={error ?? 'The project list could not be read.'} actions={<Button variant="primary" icon="refresh" onClick={onRetry}>Retry</Button>} />;
}
```

- [ ] **Step 3: `components/ProjectRow.tsx`**

```tsx
import type { Project } from '@shared/project';
import { IconTile } from '../ui/IconTile';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { relativeTime } from '../data/selectors';
import { RepoHealthBar } from './RepoHealthBar';

export function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const ws = workspaceForDomain(project.domainId);
  return (
    <button type="button" className="nx-row nx-focusable" onClick={onOpen}>
      <IconTile icon={ws?.icon ?? 'projects'} hue={ws?.hue ?? 'slate'} size="sm" />
      <span className="nx-row__main">
        <span className="nx-row__title">{project.name}</span>
        <span className="nx-row__meta">{ws ? ws.label : UNASSIGNED_LABEL} · {project.domainId} · <span className="nx-mono">{project.rootPath}</span></span>
      </span>
      <span className="nx-row__side">
        <span className="nx-row__time">Updated {relativeTime(project.updatedAt, Date.now())}</span>
        <RepoHealthBar project={project} />
      </span>
    </button>
  );
}
```

- [ ] **Step 4: `pages/ProjectsPage.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { WORKSPACES } from '../workspaces/registry';
import { workspaceForDomain } from '../workspaces/mapping';
import { recentProjects } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProjectRow } from '../components/ProjectRow';
import { LoadError, RowsSkeleton } from '../components/LoadStates';

export function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const [q, setQ] = useState('');
  const [ws, setWs] = useState<string>('all');
  const shown = useMemo(() => recentProjects(projects, projects.length).filter((p) => {
    const w = workspaceForDomain(p.domainId)?.id ?? 'unassigned';
    if (ws !== 'all' && w !== ws) return false;
    const needle = q.trim().toLowerCase();
    return !needle || p.name.toLowerCase().includes(needle) || p.rootPath.toLowerCase().includes(needle);
  }), [projects, q, ws]);

  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <h1 tabIndex={-1}>Projects</h1>
        <div className="nx-pagehead__actions">
          <Button icon="import" onClick={actions.openImport}>Import</Button>
          <Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button>
        </div>
      </header>
      {projects.length > 0 && (
        <div className="nx-toolbar">
          <input className="nx-input nx-focusable" type="search" placeholder="Filter by name or folder" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter projects" />
          <select className="nx-input nx-focusable" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
            <option value="all">All workspaces</option>
            {WORKSPACES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            <option value="unassigned">Unassigned</option>
          </select>
          <Button variant="ghost" onClick={actions.openProjectManager}>Manage projects</Button>
        </div>
      )}
      {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
        : status === 'loading' && projects.length === 0 ? <RowsSkeleton />
        : projects.length === 0 ? (
          <EmptyState icon="projects" title="No projects yet" body="Create a project or import a folder you already work in. Agents use it as their working directory."
            actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button><Button icon="import" onClick={actions.openImport}>Import</Button></>} />
        ) : shown.length === 0 ? (
          <p className="nx-muted" role="status">No projects match these filters.</p>
        ) : (
          <div className="nx-rows">{shown.map((p) => <ProjectRow key={p.id} project={p} onOpen={() => navigate({ name: 'project', id: p.id })} />)}</div>
        )}
    </div>
  );
}
```

- [ ] **Step 5: `pages/ProjectPage.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { ProjectCommandCenter } from '@/project/ProjectCommandCenter';
import { navigate } from '../router/useRoute';
import { useProjectsLoader } from '../data/useProjects';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

export function ProjectPage({ id }: { id: string }) {
  const { status } = useProjectsLoader();
  const known = useStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const active = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!known || active?.id === id) return;
    let alive = true;
    setErr(null);
    window.cth.projectSetActive(id)
      .then((p) => { if (alive) { if (p) setActiveProject(p); else setErr('The project could not be opened.'); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, known, active?.id, setActiveProject, attempt]);

  if (!known && status !== 'loading') {
    return <div className="nx-page"><EmptyState icon="projects" title="That project isn't in your list" body="It may have been removed. Open Projects to pick another."
      actions={<Button variant="primary" onClick={() => navigate({ name: 'projects' })}>Back to Projects</Button>} /></div>;
  }
  if (err) {
    return <div className="nx-page"><EmptyState icon="refresh" title="Couldn't open the project" body={err} actions={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} /></div>;
  }
  if (!active || active.id !== id) {
    return <div className="nx-page"><p className="nx-muted" role="status">Opening {known?.name ?? 'project'}…</p></div>;
  }
  return (
    <div className="nx-legacy-host">
      <ProjectCommandCenter
        project={active}
        onBackToHome={() => window.history.back()}
        onRefreshProject={async () => { const r = await window.cth.projectRefresh(active.id); if (r) setActiveProject(r); }}
      />
    </div>
  );
}
```

- [ ] **Step 6: `pages/WorkspacesPage.tsx` and `pages/WorkspacePage.tsx`**

```tsx
// WorkspacesPage.tsx
import { useStore } from '@/store/store';
import { WORKSPACES } from '../workspaces/registry';
import { countsByWorkspace } from '../workspaces/mapping';
import { IconTile } from '../ui/IconTile';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';

export function WorkspacesPage() {
  const projects = useStore((s) => s.projects);
  const counts = countsByWorkspace(projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  return (
    <div className="nx-page">
      <header className="nx-pagehead"><h1 tabIndex={-1}>Workspaces</h1></header>
      <p className="nx-lead">Each workspace groups projects by the kind of work. Projects join a workspace by the domain the analyzer detects.</p>
      <div className="nx-grid">
        {WORKSPACES.map((w) => (
          <button key={w.id} type="button" className="nx-card nx-card--link nx-focusable" onClick={() => { setLast(w.id); navigate({ name: 'workspace', id: w.id }); }}>
            <IconTile icon={w.icon} hue={w.hue} size="lg" />
            <span className="nx-card__title">{w.name}</span>
            <span className="nx-card__body">{w.description}</span>
            <span className="nx-card__meta">
              {counts[w.id] > 0 ? `${counts[w.id]} project${counts[w.id] === 1 ? '' : 's'}` : 'No projects yet'}
              {w.domainIds.length > 0 && <> · <span className="nx-mono">{w.domainIds.join(', ')}</span></>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

```tsx
// WorkspacePage.tsx
import { useStore } from '@/store/store';
import type { WorkspaceId } from '../workspaces/types';
import { getWorkspace } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import { recentProjects } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { IconTile } from '../ui/IconTile';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ProjectRow } from '../components/ProjectRow';
import { LoadError, RowsSkeleton } from '../components/LoadStates';

export function WorkspacePage({ id }: { id: WorkspaceId }) {
  const ws = getWorkspace(id)!; // route parsing guarantees a known id
  const projects = useStore((s) => s.projects);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const mine = recentProjects(projectsForWorkspace(projects, id), Infinity);
  const unmappable = ws.domainIds.length === 0;
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <IconTile icon={ws.icon} hue={ws.hue} size="lg" />
        <div className="nx-pagehead__text">
          <h1 tabIndex={-1}>{ws.name}</h1>
          <p className="nx-lead">{ws.description}</p>
        </div>
        <div className="nx-pagehead__actions">
          <Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button>
        </div>
      </header>
      <section aria-labelledby="ws-projects">
        <h2 id="ws-projects" className="nx-h2">Projects in {ws.label}</h2>
        {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
          : status === 'loading' && projects.length === 0 ? <RowsSkeleton count={3} />
          : mine.length > 0 ? <div className="nx-rows">{mine.map((p) => <ProjectRow key={p.id} project={p} onOpen={() => navigate({ name: 'project', id: p.id })} />)}</div>
          : unmappable ? (
            <EmptyState icon={ws.icon} title={`No ${ws.label} projects yet`}
              body={<>Projects are grouped by the domain the analyzer detects, and none map to {ws.label} today. {ws.label} work will arrive through handoffs in a later phase.</>}
              actions={<Button onClick={() => navigate({ name: 'projects' })}>See all projects</Button>} />
          ) : (
            <EmptyState icon={ws.icon} title={`No ${ws.label} projects yet`} body="Create one here, or import a folder; it joins this workspace when its domain matches."
              actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button><Button icon="import" onClick={actions.openImport}>Import</Button></>} />
          )}
      </section>
      <section aria-labelledby="ws-planned">
        <h2 id="ws-planned" className="nx-h2">Coming to this workspace</h2>
        <div className="nx-chips">{ws.plannedModules.map((m) => <span key={m} className="nx-chip">{m} <Badge tone="planned">Planned</Badge></span>)}</div>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: `pages/plannedContent.ts` and `pages/PlannedPage.tsx`**

```ts
// plannedContent.ts
import type { NexusIconName } from '../iconNames';
export interface PlannedContent { title: string; icon: NexusIconName; what: string; fits: string; today: string; todayAction: 'files' | 'projects' | 'assistant' | 'agents' }
export const PLANNED: Record<'artifacts' | 'handoffs' | 'deployments', PlannedContent> = {
  artifacts: {
    title: 'Artifacts', icon: 'artifacts',
    what: 'Datasets, models, APIs, dashboards and designs as versioned objects, each tied to real files in a project, with history of what it was made from and where it is used.',
    fits: 'Artifacts are what a workspace produces and what other workspaces build on.',
    today: "Your agents' outputs are files in your projects. Open Files or a project to work with them.", todayAction: 'files'
  },
  handoffs: {
    title: 'Handoffs', icon: 'handoffs',
    what: 'Send an artifact version from one workspace to another with a request — for example a model from ML to SDE to wrap in an API — then track it to delivery.',
    fits: 'Handoffs connect workspaces so work flows from data to model to app to deployment.',
    today: 'Ask your lead agent to coordinate work between agents.', todayAction: 'assistant'
  },
  deployments: {
    title: 'Deployments', icon: 'deployments',
    what: 'Build, run and publish what you made, with environments, logs, URLs and rollback.',
    fits: 'Deployment is the last step of the loop: work, artifact, handoff, app, deploy.',
    today: 'Your agents can run build and test commands inside a project.', todayAction: 'agents'
  }
};
```

```tsx
// PlannedPage.tsx
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { PLANNED } from './plannedContent';

export function PlannedPage({ which }: { which: keyof typeof PLANNED }) {
  const c = PLANNED[which];
  const actions = useShellActions();
  const focusComposer = useNexusUi((s) => s.focusComposer);
  const go = { files: actions.openIde, projects: () => navigate({ name: 'projects' }), assistant: focusComposer, agents: () => navigate({ name: 'agents' }) }[c.todayAction];
  const label = { files: 'Open Files', projects: 'Open Projects', assistant: 'Ask the lead agent', agents: 'Open Agents' }[c.todayAction];
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <span className="nx-empty__icon"><Icon name={c.icon} size={22} /></span>
        <h1 tabIndex={-1}>{c.title}</h1>
        <Badge tone="planned">Planned · not available yet</Badge>
      </header>
      <section className="nx-planned">
        <div><h2 className="nx-h3">What this will do</h2><p>{c.what}</p></div>
        <div><h2 className="nx-h3">How it fits</h2><p>{c.fits}</p></div>
        <div><h2 className="nx-h3">What you can do today</h2><p>{c.today}</p><Button variant="primary" onClick={go}>{label}</Button></div>
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Replace `chrome/SetupCard.tsx`**

```tsx
import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { setupProgress, setupSteps } from '../data/selectors';

export function SetupCard() {
  const projectCount = useStore((s) => s.projects.length);
  const lastWorkspace = useNexusUi((s) => s.lastWorkspace);
  const dismissed = useNexusUi((s) => s.setupDismissed);
  const dismiss = useNexusUi((s) => s.dismissSetup);
  const actions = useShellActions();
  const steps = setupSteps({ lastWorkspace, projectCount });
  const p = setupProgress(steps);
  if (dismissed) return null;
  if (p.done === p.available) {
    return (
      <div className="nx-setup nx-setup--done">
        <span>Setup complete for now · {p.total - p.available} steps arrive later</span>
        <button type="button" className="nx-linkbtn nx-focusable" onClick={dismiss}>Hide</button>
      </div>
    );
  }
  const act = { workspace: () => navigate({ name: 'home' }), project: () => actions.openNewProject() } as const;
  return (
    <section className="nx-setup" aria-labelledby="nx-setup-title">
      <header className="nx-setup__head"><h2 id="nx-setup-title">Get set up</h2><span>{p.done} of {p.available}</span></header>
      <ol className="nx-setup__list">
        {steps.map((s) => (
          <li key={s.id} className={`nx-setup__step is-${s.state}`} title={s.hint}>
            <Icon name={s.state === 'done' ? 'check' : s.state === 'locked' ? 'lock' : 'circle'} size={15} />
            {s.state === 'todo' && (s.id === 'workspace' || s.id === 'project')
              ? <button type="button" className="nx-linkbtn nx-focusable" onClick={act[s.id]}>{s.label}</button>
              : <span>{s.label}</span>}
            {s.state === 'locked' && <span className="nx-sr-only">— available in a later phase</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 9: `styles/pages.css`**

```css
.nx-pagehead { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.nx-pagehead h1 { margin: 0; font: 750 26px/1.2 var(--nx-font); letter-spacing: -0.02em; color: var(--nx-text); }
.nx-pagehead__text { display: grid; gap: 4px; flex: 1; min-width: 220px; }
.nx-pagehead__actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.nx-lead { margin: 0; color: var(--nx-text-muted); font: 400 15px/1.5 var(--nx-font); max-width: 70ch; }
.nx-muted { color: var(--nx-text-muted); font: 400 14px/1.5 var(--nx-font); margin: 0; }
.nx-h2 { margin: 0 0 12px; font: 650 16px/1.3 var(--nx-font); color: var(--nx-text); }
.nx-h3 { margin: 0 0 6px; font: 650 14px/1.3 var(--nx-font); color: var(--nx-text); }
.nx-mono { font-family: var(--nx-font-mono); font-size: 12px; }

.nx-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.nx-input { height: 36px; padding: 0 12px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-sm); background: var(--nx-surface); color: var(--nx-text); font: 400 14px/1 var(--nx-font); min-width: 0; }
.nx-toolbar .nx-input[type='search'] { flex: 1 1 240px; }

.nx-rows { display: grid; gap: 8px; }
.nx-skel-row { height: 64px; }
.nx-row { width: 100%; display: flex; align-items: center; gap: 14px; padding: 12px 14px; text-align: left; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-md); background: var(--nx-surface); color: var(--nx-text); cursor: pointer; transition: border-color var(--nx-fast) var(--nx-ease), background var(--nx-fast) var(--nx-ease); }
.nx-row:hover { border-color: var(--nx-border-strong); background: var(--nx-surface-2); }
.nx-row__main { flex: 1; min-width: 0; display: grid; gap: 4px; }
.nx-row__title { font: 600 15px/1.3 var(--nx-font); }
.nx-row__meta { font: 400 13px/1.4 var(--nx-font); color: var(--nx-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-row__side { display: grid; justify-items: end; gap: 6px; flex-shrink: 0; }
.nx-row__time { font: 400 12px/1 var(--nx-font); color: var(--nx-text-muted); }

.nx-health { display: grid; gap: 4px; min-width: 120px; }
.nx-health__label { font: 400 12px/1 var(--nx-font); color: var(--nx-text-muted); }
.nx-health__label strong { color: var(--nx-text-2); font-weight: 600; }
.nx-health__track { display: block; height: 4px; border-radius: 4px; background: var(--nx-surface-hover); overflow: hidden; }
.nx-health__fill { display: block; height: 100%; background: var(--nx-gradient); }

.nx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.nx-card { display: grid; gap: 8px; justify-items: start; text-align: left; padding: 18px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-lg); background: var(--nx-surface); color: var(--nx-text); box-shadow: var(--nx-shadow-card); }
.nx-card--link { cursor: pointer; transition: transform var(--nx-fast) var(--nx-ease), border-color var(--nx-fast) var(--nx-ease); }
.nx-card--link:hover { transform: translateY(-2px); border-color: var(--nx-border-strong); }
.nx-card__title { font: 650 16px/1.3 var(--nx-font); }
.nx-card__body { font: 400 14px/1.5 var(--nx-font); color: var(--nx-text-2); }
.nx-card__meta { font: 400 12px/1.4 var(--nx-font); color: var(--nx-text-muted); }

.nx-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.nx-chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; border: 1px solid var(--nx-border); border-radius: 999px; background: var(--nx-surface); color: var(--nx-text-2); font: 500 13px/1 var(--nx-font); }

.nx-planned { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.nx-planned > div { padding: 18px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-lg); background: var(--nx-surface); display: grid; gap: 8px; align-content: start; color: var(--nx-text-2); font: 400 14px/1.55 var(--nx-font); }
.nx-planned p { margin: 0; }

.nx-linkbtn { border: 0; background: none; padding: 0; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; text-align: left; }

/* Setup card lives on the navy sidebar */
.nx-setup { border: 1px solid var(--nx-frame-border); border-radius: var(--nx-radius-md); background: var(--nx-frame-raised); padding: 12px; color: var(--nx-frame-text); }
.nx-setup__head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.nx-setup__head h2 { margin: 0; font: 650 13px/1 var(--nx-font); }
.nx-setup__head span { font: 500 12px/1 var(--nx-font); color: var(--nx-frame-muted); }
.nx-setup__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.nx-setup__step { display: flex; align-items: center; gap: 8px; font: 400 13px/1.3 var(--nx-font); color: var(--nx-frame-text); }
.nx-setup__step.is-done { color: var(--nx-frame-muted); }
.nx-setup__step.is-done svg { color: #4ADE80; }
.nx-setup__step.is-locked { color: var(--nx-frame-faint); }
.nx-setup--done { display: flex; justify-content: space-between; gap: 8px; font: 400 12px/1.4 var(--nx-font); color: var(--nx-frame-muted); padding: 8px 4px; }

/* Hosts for legacy screens (unchanged inside) */
.nx-legacy-host { min-height: 100%; display: flex; flex-direction: column; }

@media (max-width: 639px) {
  .nx-row { flex-wrap: wrap; }
  .nx-row__side { justify-items: start; width: 100%; padding-left: 42px; }
}
@media (prefers-reduced-motion: reduce) {
  .nx-card--link, .nx-row { transition: none; }
  .nx-card--link:hover { transform: none; }
}
```

- [ ] **Step 10: Wire the routes**

In `RouteView.tsx`, import the pages and replace the `default:` branch with:
```tsx
    case 'workspaces': page = <WorkspacesPage />; break;
    case 'workspace': page = <WorkspacePage id={route.id} />; break;
    case 'projects': page = <ProjectsPage />; break;
    case 'project': page = <ProjectPage id={route.id} />; break;
    case 'artifacts': page = <PlannedPage which="artifacts" />; break;
    case 'handoffs': page = <PlannedPage which="handoffs" />; break;
    case 'deployments': page = <PlannedPage which="deployments" />; break;
    case 'home': page = <NotFoundPage message="Coming in this build." />; break;
```
Also add `nx-main--flush` for `route.name === 'project'` (the command center manages its own scrolling).

- [ ] **Step 11: Verify and commit**

Run: `npm run typecheck && npm run test:focused`
Expected: exit 0, and only the 11 baseline failures.

```bash
git add src/renderer/src/nexus
git commit -m "feat(nexus): workspace, project and planned pages; guided setup card"
```

---

### Task 9: Assistant — port, lead-agent implementation, panel

**Files:**
- Create: `src/renderer/src/nexus/assistant/port.ts` (pure types + `resolveAssistantStatus`)
- Create: `src/renderer/src/nexus/assistant/context.ts` (pure)
- Create: `src/renderer/src/nexus/assistant/prompts.ts` (pure data)
- Create: `src/renderer/src/nexus/assistant/leadAgentPort.ts`
- Create: `src/renderer/src/nexus/assistant/useAssistant.ts`
- Create: `src/renderer/src/nexus/assistant/AssistantPanel.tsx`
- Create: `src/renderer/src/nexus/styles/assistant.css`; append the import
- Modify: `src/renderer/src/nexus/NexusShell.tsx` (mount the panel in the slot and in the sheet)
- Test: `test/nexus-assistant.test.cjs`

**Interfaces:**
- Consumes: `useStore` (`agents`, `godStatus`, `enqueueMessage`, `select`), `window.cth.controlSnapshot`, `navigate`, `useRoute`, `routeTitle`, `getWorkspace`, `workspaceForDomain`, `useNexusUi`, `useShellActions`
- Produces:
  - `AssistantStatus`, `AssistantTarget`, `SendResult`, `AssistantPort`
  - `resolveAssistantStatus(input: { god: { id: string; name: string } | null; godStatus: string; deliveryPaused: boolean }): AssistantStatus`
  - `buildContextHeader(c: { workspace?: string | null; project?: { name: string; rootPath: string } | null; page?: string | null }): string | null`
  - `QUICK_ACTIONS`, `SUGGESTIONS`
  - `useAssistant(): AssistantPort` (the only place a port is chosen)

- [ ] **Step 1: Write the failing test** — `test/nexus-assistant.test.cjs`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { resolveAssistantStatus } = loadTs('src/renderer/src/nexus/assistant/port.ts');
const { buildContextHeader } = loadTs('src/renderer/src/nexus/assistant/context.ts');
const { QUICK_ACTIONS, SUGGESTIONS } = loadTs('src/renderer/src/nexus/assistant/prompts.ts');
const { NEXUS_ICON_NAMES } = loadTs('src/renderer/src/nexus/iconNames.ts');

test('status: no lead agent → unavailable (never targets a missing id)', () => {
  const s = resolveAssistantStatus({ god: null, godStatus: 'ready', deliveryPaused: false });
  assert.equal(s.state, 'unavailable');
  assert.ok(s.reason.length > 0);
});

test('status: booting with an agent → starting, carries the target so sends can queue', () => {
  const s = resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'booting', deliveryPaused: false });
  assert.deepEqual(s, { state: 'starting', target: { id: 'g', name: 'Lead', kind: 'lead-agent' } });
});

test('status: ready reflects delivery pause', () => {
  const s = resolveAssistantStatus({ god: { id: 'g', name: 'Lead' }, godStatus: 'ready', deliveryPaused: true });
  assert.deepEqual(s, { state: 'ready', target: { id: 'g', name: 'Lead', kind: 'lead-agent' }, deliveryPaused: true });
});

test('context header contains only provided facts', () => {
  assert.equal(buildContextHeader({}), null);
  assert.equal(buildContextHeader({ page: 'Home' }), null);
  assert.equal(buildContextHeader({ workspace: 'ML', page: 'Home' }), '[Nexus context — workspace: ML · page: Home]');
  assert.equal(
    buildContextHeader({ workspace: 'ML', project: { name: 'fraud', rootPath: 'C:\\repos\\fraud' }, page: 'Project' }),
    '[Nexus context — workspace: ML · project: fraud (C:\\repos\\fraud) · page: Project]'
  );
  assert.equal(buildContextHeader({ project: { name: 'x', rootPath: '/x' } }), '[Nexus context — project: x (/x)]');
});

test('quick actions: real ones act, unbuilt ones are disabled; all icons exist', () => {
  const byId = Object.fromEntries(QUICK_ACTIONS.map((a) => [a.id, a]));
  assert.equal(byId['new-project'].kind, 'new-project');
  assert.equal(byId['analyze-dataset'].kind, 'prefill');
  assert.equal(byId['model-to-app'].kind, 'disabled');
  assert.equal(byId['deploy'].kind, 'disabled');
  for (const a of QUICK_ACTIONS) assert.ok(NEXUS_ICON_NAMES.includes(a.icon), a.id);
  for (const s of SUGGESTIONS) { assert.ok(s.prompt.trim().length > 10, s.id); assert.ok(NEXUS_ICON_NAMES.includes(s.icon), s.id); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-assistant.test.cjs`
Expected: FAIL (modules missing).

- [ ] **Step 3: `assistant/port.ts`**

```ts
export interface AssistantTarget { id: string; name: string; kind: 'lead-agent' | (string & {}) }
export type AssistantStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'starting'; target: AssistantTarget }
  | { state: 'ready'; target: AssistantTarget; deliveryPaused: boolean };
export type SendResult = { ok: true; target: AssistantTarget } | { ok: false; error: string };

/** What the assistant UI needs from whatever answers it. Phase A: the lead
 *  agent. A future provider (e.g. Hermes) implements this same interface and
 *  is selected in useAssistant() — the panel does not change. */
export interface AssistantPort {
  status: AssistantStatus;
  send(input: { text: string; contextHeader: string | null }): SendResult;
  openConversation(): void;
  /** Human-readable note on where replies appear. */
  replyHint: string;
}

export function resolveAssistantStatus(input: { god: { id: string; name: string } | null; godStatus: string; deliveryPaused: boolean }): AssistantStatus {
  if (!input.god) return { state: 'unavailable', reason: 'No lead agent is running.' };
  const target: AssistantTarget = { id: input.god.id, name: input.god.name, kind: 'lead-agent' };
  if (input.godStatus === 'booting') return { state: 'starting', target };
  return { state: 'ready', target, deliveryPaused: input.deliveryPaused };
}
```

- [ ] **Step 4: `assistant/context.ts`**

```ts
export function buildContextHeader(c: { workspace?: string | null; project?: { name: string; rootPath: string } | null; page?: string | null }): string | null {
  if (!c.workspace && !c.project) return null;
  const parts: string[] = [];
  if (c.workspace) parts.push(`workspace: ${c.workspace}`);
  if (c.project) parts.push(`project: ${c.project.name} (${c.project.rootPath})`);
  if (c.page) parts.push(`page: ${c.page}`);
  return `[Nexus context — ${parts.join(' · ')}]`;
}
```

- [ ] **Step 5: `assistant/prompts.ts`**

```ts
import type { Hue, NexusIconName } from '../iconNames';

export interface QuickAction {
  id: 'new-project' | 'analyze-dataset' | 'model-to-app' | 'deploy';
  title: string; description: string; icon: NexusIconName; hue: Hue;
  kind: 'new-project' | 'prefill' | 'disabled';
  prefill?: string;
  unavailableReason?: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'new-project', title: 'Create a new project', description: 'Set up a folder your agents work in', icon: 'sde', hue: 'violet', kind: 'new-project' },
  { id: 'analyze-dataset', title: 'Analyze a dataset', description: 'Ask the lead agent to explore your data', icon: 'dataset', hue: 'green', kind: 'prefill',
    prefill: 'Analyze the dataset at <path in this project>: summarize its columns, data quality issues and the most interesting patterns, and save the notebook or script you use.' },
  { id: 'model-to-app', title: 'Turn a model into a web app', description: 'Generate API + UI + deploy', icon: 'appBox', hue: 'orange', kind: 'disabled',
    unavailableReason: 'Not available yet — arrives with artifacts and the Turn into App flow.' },
  { id: 'deploy', title: 'Deploy an application', description: 'Build, test and publish', icon: 'rocket', hue: 'blue', kind: 'disabled',
    unavailableReason: 'Not available yet — no deployment target is connected.' }
];

export interface Suggestion { id: string; label: string; icon: NexusIconName; prompt: string }

export const SUGGESTIONS: Suggestion[] = [
  { id: 'train', label: 'Train a model on the latest dataset', icon: 'ml', prompt: 'Train a model on the latest dataset in this project, report the evaluation metrics, and save the training script and model file.' },
  { id: 'api', label: "Create an API for this project's model", icon: 'sde', prompt: "Create an HTTP API endpoint that loads this project's model and returns predictions. Include a sample request and a test." },
  { id: 'landing', label: 'Design a landing page', icon: 'uiux', prompt: 'Design and build a simple landing page for this project. Keep it in a separate folder and explain how to run it.' },
  { id: 'tests', label: 'Run the tests and fix failures', icon: 'qa', prompt: "Run this project's test suite, fix any failures you find, and summarize what you changed." },
  { id: 'readme', label: 'Write or update the README', icon: 'research', prompt: 'Read this project and write or update its README: what it does, how to set it up, how to run and test it.' },
  { id: 'review', label: 'Review recent changes', icon: 'sde', prompt: 'Review the most recent changes in this repository and list concrete bugs or risks, most severe first.' }
];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/nexus-assistant.test.cjs`
Expected: PASS (5 tests).

- [ ] **Step 7: `assistant/leadAgentPort.ts`**

```ts
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { navigate } from '../router/useRoute';
import { resolveAssistantStatus, type AssistantPort } from './port';

/** Mirrors MessageQueueComposer's useDeliveryPaused: poll the control snapshot. */
function useDeliveryPaused(agentId: string | null): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!agentId) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId]);
  return paused;
}

export function useLeadAgentPort(): AssistantPort {
  const god = useStore((s) => s.agents.find((a) => a.isGod) ?? null);
  const godStatus = useStore((s) => s.godStatus);
  const paused = useDeliveryPaused(god?.id ?? null);
  const status = resolveAssistantStatus({ god: god ? { id: god.id, name: god.name } : null, godStatus, deliveryPaused: paused });
  return {
    status,
    replyHint: 'Replies appear in the lead agent\u2019s terminal in Agents.',
    send: ({ text, contextHeader }) => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'Type a message first.' };
      if (status.state === 'unavailable') return { ok: false, error: status.reason };
      const instruction = contextHeader ? `${contextHeader}\n${trimmed}` : trimmed;
      useStore.getState().enqueueMessage(status.target.id, trimmed, { instruction });
      return { ok: true, target: status.target };
    },
    openConversation: () => {
      if (god) useStore.getState().select(god.id);
      navigate({ name: 'agents' });
    }
  };
}
```

- [ ] **Step 8: `assistant/useAssistant.ts`**

```ts
import type { AssistantPort } from './port';
import { useLeadAgentPort } from './leadAgentPort';

/** The ONLY place that decides which assistant backend the UI talks to. */
export function useAssistant(): AssistantPort {
  return useLeadAgentPort();
}
```

- [ ] **Step 9: `assistant/AssistantPanel.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { IconTile } from '../ui/IconTile';
import { Badge } from '../ui/Badge';
import { useRoute } from '../router/useRoute';
import { routeTitle } from '../router/routes';
import { getWorkspace } from '../workspaces/registry';
import { workspaceForDomain } from '../workspaces/mapping';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { buildContextHeader } from './context';
import { QUICK_ACTIONS, SUGGESTIONS } from './prompts';
import { useAssistant } from './useAssistant';

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function AssistantPanel({ headingId }: { headingId: string }) {
  const port = useAssistant();
  const route = useRoute();
  const actions = useShellActions();
  const draft = useNexusUi((s) => s.draft);
  const setDraft = useNexusUi((s) => s.setDraft);
  const focusTick = useNexusUi((s) => s.composerFocusTick);
  const activeProject = useStore((s) => s.activeProject);
  const projects = useStore((s) => s.projects);
  const [showAll, setShowAll] = useState(false);
  const [useWs, setUseWs] = useState(true);
  const [useProject, setUseProject] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (focusTick > 0) ta.current?.focus(); }, [focusTick]);

  // Real context only: the workspace/project the user is looking at.
  const ctx = useMemo(() => {
    let project: { name: string; rootPath: string; domainId: string } | null = null;
    if (route.name === 'project') {
      const p = projects.find((x) => x.id === route.id);
      if (p) project = p;
    } else if (activeProject && route.name === 'agents') project = activeProject;
    const ws = route.name === 'workspace' ? getWorkspace(route.id) : project ? workspaceForDomain(project.domainId) : null;
    return { ws, project };
  }, [route, projects, activeProject]);

  const header = buildContextHeader({
    workspace: useWs ? ctx.ws?.label ?? null : null,
    project: useProject && ctx.project ? { name: ctx.project.name, rootPath: ctx.project.rootPath } : null,
    page: routeTitle(route)
  });

  const s = port.status;
  const send = () => {
    const res = port.send({ text: draft, contextHeader: header });
    if (!res.ok) { setNotice({ tone: 'error', text: res.error }); return; }
    setDraft('');
    const tail = s.state === 'starting' ? 'delivered once it has started'
      : s.state === 'ready' && s.deliveryPaused ? 'delivery is paused — release it in Agents'
      : 'delivered when the agent is ready';
    setNotice({ tone: 'ok', text: `Queued for ${res.target.name} · ${tail}` });
  };

  const suggestions = showAll ? SUGGESTIONS : SUGGESTIONS.slice(0, 4);

  return (
    <div className="nx-assist">
      <header className="nx-assist__head">
        <span className="nx-assist__logo" aria-hidden="true"><Icon name="sparkles" size={18} /></span>
        <h2 id={headingId} className="nx-assist__title">Assistant</h2>
        <span className={`nx-dot nx-dot--${s.state}`} aria-hidden="true" />
        <span className="nx-assist__target">{s.state === 'unavailable' ? 'Offline' : `Lead agent · ${s.target.name}`}</span>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={port.openConversation} title="Open conversation in Agents" aria-label="Open conversation in Agents">
          <Icon name="agents" size={17} />
        </button>
      </header>

      <div className="nx-assist__scroll">
        <p className="nx-assist__hello"><strong>{greeting()}!</strong><br />Ask your lead agent to plan, build or fix something.</p>

        <ul className="nx-qa" aria-label="Quick actions">
          {QUICK_ACTIONS.map((a) => {
            const disabled = a.kind === 'disabled';
            const run = () => {
              if (a.kind === 'new-project') actions.openNewProject(ctx.ws?.defaultDomainId);
              else if (a.kind === 'prefill' && a.prefill) { setDraft(a.prefill); ta.current?.focus(); }
            };
            return (
              <li key={a.id}>
                <button type="button" className="nx-qa__item nx-focusable" onClick={run} disabled={disabled} aria-disabled={disabled} title={a.unavailableReason}>
                  <IconTile icon={a.icon} hue={a.hue} size="md" />
                  <span className="nx-qa__text"><span className="nx-qa__title">{a.title}</span><span className="nx-qa__desc">{a.description}</span></span>
                  {disabled && <Badge tone="planned">Not available yet</Badge>}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="nx-sugg__head">
          <h3>Suggested for you</h3>
          <button type="button" className="nx-linkbtn nx-focusable" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : 'View all'}</button>
        </div>
        <ul className="nx-sugg">
          {suggestions.map((sg) => (
            <li key={sg.id}>
              <button type="button" className="nx-sugg__item nx-focusable" onClick={() => { setDraft(sg.prompt); ta.current?.focus(); }}>
                <Icon name={sg.icon} size={17} /><span>{sg.label}</span><Icon name="chevronRight" size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <form className="nx-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {s.state === 'unavailable' ? (
          <div className="nx-composer__blocked" role="status">
            {s.reason} <button type="button" className="nx-linkbtn nx-focusable" onClick={port.openConversation}>Open Agents</button>
          </div>
        ) : s.state === 'starting' ? (
          <div className="nx-composer__info" role="status">The lead agent is starting. Messages you send now are queued and delivered once it's ready.</div>
        ) : null}
        {(ctx.ws || ctx.project) && (
          <div className="nx-ctxchips" aria-label="Context sent with your message">
            {ctx.ws && <button type="button" className={`nx-ctxchip nx-focusable${useWs ? '' : ' is-off'}`} aria-pressed={useWs} onClick={() => setUseWs((v) => !v)}>{ctx.ws.label}{useWs && <Icon name="close" size={12} />}</button>}
            {ctx.project && <button type="button" className={`nx-ctxchip nx-focusable${useProject ? '' : ' is-off'}`} aria-pressed={useProject} onClick={() => setUseProject((v) => !v)}>{ctx.project.name}{useProject && <Icon name="close" size={12} />}</button>}
          </div>
        )}
        <label className="nx-sr-only" htmlFor="nx-composer-input">Message the lead agent</label>
        <textarea
          id="nx-composer-input" ref={ta} className="nx-composer__input nx-focusable" rows={3}
          placeholder="Ask your lead agent…" value={draft} disabled={s.state === 'unavailable'}
          onChange={(e) => { setDraft(e.target.value); setNotice(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        <div className="nx-composer__row">
          <span className="nx-composer__hint">{port.replyHint}</span>
          <button type="submit" className="nx-send nx-focusable" disabled={s.state === 'unavailable' || !draft.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
        </div>
        {notice && <p className={`nx-composer__notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text} {notice.tone === 'ok' && <button type="button" className="nx-linkbtn nx-focusable" onClick={port.openConversation}>Open conversation</button>}</p>}
      </form>
    </div>
  );
}
```

- [ ] **Step 10: Mount the panel in `NexusShell.tsx`**

Replace `<aside className="nx-assistant-slot" aria-label="Assistant" />` with:
```tsx
        <aside className="nx-assistant-slot" aria-labelledby="nx-assist-col"><AssistantPanel headingId="nx-assist-col" /></aside>
        <CompactAssistant />
```
Then add, in the same file:
```tsx
import { useEffect, useState } from 'react';
import { Sheet } from './ui/Sheet';
import { AssistantPanel } from './assistant/AssistantPanel';
import { useNexusUi } from './state/uiStore';

function useIsCompact(): boolean {
  const q = '(max-width: 1279px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

function CompactAssistant() {
  const compact = useIsCompact();
  const open = useNexusUi((s) => s.assistantOpen);
  const setOpen = useNexusUi((s) => s.setAssistantOpen);
  if (!compact) return null;
  const bottom = window.matchMedia('(max-width: 639px)').matches;
  return <Sheet open={open} onClose={() => setOpen(false)} side={bottom ? 'bottom' : 'right'} labelledBy="nx-assist-sheet"><AssistantPanel headingId="nx-assist-sheet" /></Sheet>;
}
```
`.nx-assistant-slot` is `display: none` below 1280 (Task 7 CSS), so only one panel is visible at a time.

- [ ] **Step 11: `styles/assistant.css`**

```css
.nx-assist { height: 100%; display: flex; flex-direction: column; background: var(--nx-surface); color: var(--nx-text); }
.nx-assistant-slot .nx-assist { border-top-right-radius: var(--nx-radius-lg); }
.nx-assist__head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 10px 16px; border-bottom: 1px solid var(--nx-border); }
.nx-assist__logo { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--nx-gradient); color: #fff; }
.nx-assist__title { margin: 0; font: 650 15px/1 var(--nx-font); }
.nx-assist__target { flex: 1; min-width: 0; font: 400 12px/1.2 var(--nx-font); color: var(--nx-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.nx-dot--ready { background: var(--nx-success); }
.nx-dot--starting { background: var(--nx-hue-amber); }
.nx-dot--unavailable { background: var(--nx-border-strong); }
.nx-assist__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: grid; gap: 16px; align-content: start; }
.nx-assist__hello { margin: 0; font: 400 15px/1.5 var(--nx-font); color: var(--nx-text-2); }
.nx-assist__hello strong { display: inline-block; font: 750 22px/1.3 var(--nx-font); letter-spacing: -0.01em; color: var(--nx-text); margin-bottom: 2px; }

.nx-qa { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.nx-qa__item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-md); background: var(--nx-surface); color: var(--nx-text); text-align: left; cursor: pointer; transition: border-color var(--nx-fast) var(--nx-ease), background var(--nx-fast) var(--nx-ease); }
.nx-qa__item:hover:not(:disabled) { border-color: var(--nx-border-strong); background: var(--nx-surface-2); }
.nx-qa__item:disabled { cursor: not-allowed; }
.nx-qa__item:disabled .nx-tile { filter: grayscale(0.6); opacity: 0.7; }
.nx-qa__text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.nx-qa__title { font: 600 14px/1.3 var(--nx-font); }
.nx-qa__desc { font: 400 12px/1.35 var(--nx-font); color: var(--nx-text-muted); }

.nx-sugg__head { display: flex; justify-content: space-between; align-items: baseline; }
.nx-sugg__head h3 { margin: 0; font: 650 14px/1 var(--nx-font); }
.nx-sugg__head .nx-linkbtn { color: var(--nx-accent); text-decoration: none; font: 500 13px/1 var(--nx-font); }
.nx-sugg { list-style: none; margin: 0; padding: 0; display: grid; }
.nx-sugg__item { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 4px; border: 0; border-bottom: 1px solid var(--nx-border); background: none; color: var(--nx-text-2); font: 400 14px/1.3 var(--nx-font); text-align: left; cursor: pointer; }
.nx-sugg__item span { flex: 1; }
.nx-sugg__item:hover { color: var(--nx-text); }

.nx-composer { border-top: 1px solid var(--nx-border); padding: 12px 16px 16px; display: grid; gap: 8px; }
.nx-composer__blocked, .nx-composer__info { font: 400 13px/1.45 var(--nx-font); color: var(--nx-text-2); background: var(--nx-surface-2); border-radius: var(--nx-radius-sm); padding: 8px 10px; }
.nx-ctxchips { display: flex; gap: 6px; flex-wrap: wrap; }
.nx-ctxchip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--nx-border); background: var(--nx-hue-blue-soft); color: var(--nx-text-2); font: 500 12px/1 var(--nx-font); cursor: pointer; }
.nx-ctxchip.is-off { background: transparent; color: var(--nx-text-muted); text-decoration: line-through; }
.nx-composer__input { width: 100%; resize: vertical; min-height: 72px; max-height: 240px; padding: 10px 12px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-md); background: var(--nx-surface-2); color: var(--nx-text); font: 400 14px/1.5 var(--nx-font); }
.nx-composer__row { display: flex; align-items: center; gap: 8px; }
.nx-composer__hint { flex: 1; font: 400 12px/1.35 var(--nx-font); color: var(--nx-text-muted); }
.nx-send { width: 44px; height: 44px; display: inline-grid; place-items: center; border: 0; border-radius: 12px; background: var(--nx-accent); color: var(--nx-accent-text); cursor: pointer; }
.nx-send:disabled { opacity: 0.45; cursor: not-allowed; }
.nx-composer__notice { margin: 0; font: 400 12px/1.4 var(--nx-font); }
.nx-composer__notice.is-ok { color: var(--nx-success); }
.nx-composer__notice.is-error { color: var(--nx-danger); }
```

- [ ] **Step 12: Verify and commit**

Run: `npm run typecheck && node --test test/nexus-assistant.test.cjs && npm run test:focused`
Expected: exit 0; assistant tests PASS; focused shows only the 11 baseline failures.

```bash
git add src/renderer/src/nexus test/nexus-assistant.test.cjs
git commit -m "feat(nexus): assistant panel on a provider-agnostic port, wired to the real lead agent queue"
```

---

### Task 10: Launcher — Home, island stage, hotspots, recent projects

**Files:**
- Create: `src/renderer/src/nexus/launcher/HomePage.tsx`
- Create: `src/renderer/src/nexus/launcher/IslandStage.tsx`
- Create: `src/renderer/src/nexus/launcher/WorkspaceHotspot.tsx`
- Create: `src/renderer/src/nexus/launcher/RecentProjects.tsx`
- Create: `src/renderer/src/nexus/launcher/islandArt.ts`
- Create: `src/renderer/src/nexus/assets/README.md` (states the expected art file and its constraints)
- Create: `src/renderer/src/nexus/styles/launcher.css`; append the import
- Modify: `src/renderer/src/nexus/routes/RouteView.tsx` (`home` → `<HomePage />`)

**Interfaces:**
- Consumes: `WORKSPACES`, `LAUNCHER_SHORTCUTS`, `countsByWorkspace`, `workspaceForDomain`, `recentProjects`, `relativeTime`, `nextHotspot`, `useNexusUi.setLastWorkspace`, `navigate`, `RepoHealthBar`, `useShellActions`, `useProjectsLoader`
- Produces: `ISLAND_ART_URL: string | null`; `<HomePage />`

- [ ] **Step 1: `launcher/islandArt.ts`**

```ts
/** Optional launcher art. Drop `launcher-islands.webp` (or .png/.jpg) into
 *  nexus/assets/ and it is picked up at build time; absent → null and the CSS
 *  placeholder renders. No import of a missing file can break the build. */
const found = import.meta.glob('../assets/launcher-islands.{webp,png,jpg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const ISLAND_ART_URL: string | null = Object.values(found)[0] ?? null;
```

- [ ] **Step 2: `launcher/WorkspaceHotspot.tsx`**

```tsx
import { forwardRef } from 'react';
import { IconTile } from '../ui/IconTile';
import { Icon, type NexusIconName } from '../icons';
import type { Hue } from '../iconNames';

export interface HotspotModel { key: string; label: string; tagline: string; description: string; icon: NexusIconName; hue: Hue | 'accent'; x: number; y: number; count: number | null; onOpen: () => void }

export const WorkspaceHotspot = forwardRef<HTMLButtonElement, { model: HotspotModel; index: number; focusIndex: number; mode: 'stage' | 'grid'; onFocusIndex: (i: number) => void; onKeyDown: (e: React.KeyboardEvent) => void }>(
  function WorkspaceHotspot({ model, index, focusIndex, mode, onFocusIndex, onKeyDown }, ref) {
    const style = mode === 'stage' ? { left: `${model.x}%`, top: `${model.y}%`, animationDelay: `${(index % 5) * -1.2}s` } : undefined;
    return (
      <div className={`nx-hs-wrap nx-hs-wrap--${mode}`} style={style} data-hue={model.hue}>
        {mode === 'stage' && <span className="nx-hs-island" aria-hidden="true" />}
        <button
          ref={ref}
          type="button"
          className="nx-hs"
          tabIndex={mode === 'stage' ? (index === focusIndex ? 0 : -1) : 0}
          onFocus={() => onFocusIndex(index)}
          onKeyDown={onKeyDown}
          onClick={model.onOpen}
          aria-describedby={`nx-hs-desc-${model.key}`}
        >
          {model.hue === 'accent' ? <span className="nx-tile nx-tile--md nx-tile--accent"><Icon name={model.icon} size={18} /></span> : <IconTile icon={model.icon} hue={model.hue} size="md" />}
          <span className="nx-hs__text">
            <span className="nx-hs__label">{model.label}<Icon name="chevronRight" size={14} /></span>
            {model.tagline && <span className="nx-hs__tag">{model.tagline}</span>}
          </span>
          {model.count !== null && model.count > 0 && <span className="nx-hs__count">{model.count}</span>}
        </button>
        <span id={`nx-hs-desc-${model.key}`} className="nx-hs__tip" role="tooltip">
          {model.description}{model.count ? ` · ${model.count} project${model.count === 1 ? '' : 's'}` : ''}
        </span>
      </div>
    );
  }
);
```

- [ ] **Step 3: `launcher/IslandStage.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { WORKSPACES, LAUNCHER_SHORTCUTS } from '../workspaces/registry';
import { countsByWorkspace } from '../workspaces/mapping';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { nextHotspot, type Dir } from './hotspotNav';
import { ISLAND_ART_URL } from './islandArt';
import { WorkspaceHotspot, type HotspotModel } from './WorkspaceHotspot';

const KEY_DIR: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function useGridMode(): boolean {
  const q = '(max-width: 899px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

export function IslandStage() {
  const projects = useStore((s) => s.projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const grid = useGridMode();
  const [artLoaded, setArtLoaded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const models: HotspotModel[] = useMemo(() => {
    const counts = countsByWorkspace(projects);
    const ws = WORKSPACES.map((w) => ({
      key: w.id, label: w.label, tagline: w.tagline, description: w.description, icon: w.icon, hue: w.hue,
      x: w.island.x, y: w.island.y, count: counts[w.id],
      onOpen: () => { setLast(w.id); navigate({ name: 'workspace', id: w.id }); }
    }));
    const shortcuts = LAUNCHER_SHORTCUTS.map((s) => ({
      key: s.id, label: s.label, tagline: '', description: 'All your projects, across every workspace.', icon: s.icon, hue: 'accent' as const,
      x: s.island.x, y: s.island.y, count: projects.length || null, onOpen: () => navigate({ name: 'projects' })
    }));
    return [...ws, ...shortcuts];
  }, [projects, setLast]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (grid) return;
    let next = -1;
    if (KEY_DIR[e.key]) next = nextHotspot(models, focusIndex, KEY_DIR[e.key]);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = models.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  return (
    <section className={`nx-stage${grid ? ' nx-stage--grid' : ''}`} aria-label="Workspaces">
      {!grid && (
        <div className="nx-stage__art" aria-hidden="true">
          <div className="nx-stage__sky"><span className="nx-cloud nx-cloud--a" /><span className="nx-cloud nx-cloud--b" /><span className="nx-cloud nx-cloud--c" /></div>
          {ISLAND_ART_URL && !artFailed && (
            <img className={`nx-stage__img${artLoaded ? ' is-loaded' : ''}`} src={ISLAND_ART_URL} alt="" onLoad={() => setArtLoaded(true)} onError={() => setArtFailed(true)} />
          )}
        </div>
      )}
      <div className={grid ? 'nx-stage__grid' : 'nx-stage__layer'} role={grid ? undefined : 'group'} aria-roledescription={grid ? undefined : 'launcher map'}>
        {models.map((m, i) => (
          <WorkspaceHotspot key={m.key} ref={(el) => { refs.current[i] = el; }} model={m} index={i} focusIndex={focusIndex} mode={grid ? 'grid' : 'stage'} onFocusIndex={setFocusIndex} onKeyDown={onKeyDown} />
        ))}
      </div>
      {!grid && <p className="nx-sr-only">Use arrow keys to move between workspaces and Enter to open one.</p>}
    </section>
  );
}
```

`models` satisfies `{x,y}[]` for `nextHotspot` because `HotspotModel` has `x` and `y`.

- [ ] **Step 4: `launcher/RecentProjects.tsx`**

```tsx
import { useState } from 'react';
import { useStore } from '@/store/store';
import { recentProjects, relativeTime } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { IconTile } from '../ui/IconTile';
import { Icon } from '../icons';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { RepoHealthBar } from '../components/RepoHealthBar';
import { LoadError } from '../components/LoadStates';

export function RecentProjects() {
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const [menu, setMenu] = useState<string | null>(null);
  const recent = recentProjects(projects, 4);
  const now = Date.now();

  return (
    <section className="nx-recent" aria-labelledby="nx-recent-h">
      <div className="nx-recent__head">
        <h2 id="nx-recent-h" className="nx-h2">Recent projects</h2>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={() => navigate({ name: 'projects' })} aria-label="All projects"><Icon name="chevronRight" /></button>
      </div>
      {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
        : status === 'loading' && projects.length === 0 ? <div className="nx-recent__row">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="nx-skel-card" />)}</div>
        : recent.length === 0 ? (
          <EmptyState icon="projects" title="No projects yet" body="Create a project or import a folder to start working with your agents."
            actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button><Button icon="import" onClick={actions.openImport}>Import</Button></>} />
        ) : (
          <ul className="nx-recent__row">
            {recent.map((p) => {
              const ws = workspaceForDomain(p.domainId);
              return (
                <li key={p.id} className="nx-pcard">
                  <button type="button" className="nx-pcard__open nx-focusable" onClick={() => navigate({ name: 'project', id: p.id })}>
                    <IconTile icon={ws?.icon ?? 'projects'} hue={ws?.hue ?? 'slate'} size="md" />
                    <span className="nx-pcard__text">
                      <span className="nx-pcard__name">{p.name}</span>
                      <span className="nx-pcard__ws">{ws ? `${ws.label} workspace` : `${UNASSIGNED_LABEL} workspace`}</span>
                    </span>
                  </button>
                  <RepoHealthBar project={p} />
                  <span className="nx-pcard__time">Updated {relativeTime(p.updatedAt, now)}</span>
                  <div className="nx-pcard__menu">
                    <button type="button" className="nx-iconbtn nx-focusable" aria-haspopup="menu" aria-expanded={menu === p.id} aria-label={`More for ${p.name}`} onClick={() => setMenu(menu === p.id ? null : p.id)}><Icon name="more" size={17} /></button>
                    {menu === p.id && (
                      <div className="nx-menu" role="menu" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(null); }}>
                        <button role="menuitem" type="button" onClick={() => { setMenu(null); navigate({ name: 'project', id: p.id }); }}>Open</button>
                        <button role="menuitem" type="button" onClick={async () => { setMenu(null); const a = await window.cth.projectSetActive(p.id); if (a) setActiveProject(a); navigate({ name: 'agents' }); }}>Open in Agents view</button>
                        <button role="menuitem" type="button" onClick={async () => { setMenu(null); const r = await window.cth.projectRefresh(p.id); if (r) await refresh(); }}>Refresh analysis</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
```

- [ ] **Step 5: `launcher/HomePage.tsx`**

```tsx
import { IslandStage } from './IslandStage';
import { RecentProjects } from './RecentProjects';

export function HomePage() {
  return (
    <div className="nx-home">
      <header className="nx-home__head">
        <h1 tabIndex={-1} className="nx-home__title">What are you <span className="nx-grad">working on?</span></h1>
        <p className="nx-home__sub">Choose a workspace and start building with your agents.</p>
      </header>
      <IslandStage />
      <RecentProjects />
    </div>
  );
}
```

- [ ] **Step 6: `styles/launcher.css`**

```css
.nx-home { position: relative; display: grid; gap: 20px; padding: 28px 32px 32px; min-height: 100%; align-content: start;
  background: linear-gradient(180deg, var(--nx-sky-top) 0%, var(--nx-sky-bottom) 55%, var(--nx-canvas) 100%); }
.nx-home__head { text-align: center; display: grid; gap: 8px; }
.nx-home__title { margin: 0; font: 800 clamp(28px, 3.2vw, 44px)/1.1 var(--nx-font); letter-spacing: -0.03em; color: var(--nx-text); outline: none; }
.nx-grad { background: var(--nx-gradient); -webkit-background-clip: text; background-clip: text; color: transparent; }
.nx-home__sub { margin: 0; font: 400 16px/1.5 var(--nx-font); color: var(--nx-text-2); }

/* Stage */
.nx-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; max-height: 62vh; min-height: 380px; border-radius: var(--nx-radius-lg); overflow: hidden; }
.nx-stage__art, .nx-stage__layer { position: absolute; inset: 0; }
.nx-stage__sky { position: absolute; inset: 0; background: radial-gradient(120% 80% at 50% 110%, rgba(255,255,255,0.65) 0%, transparent 60%), linear-gradient(180deg, var(--nx-sky-top), var(--nx-sky-bottom)); }
.nx-stage__img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 400ms var(--nx-ease); image-rendering: auto; }
.nx-stage__img.is-loaded { opacity: 1; }
.nx-cloud { position: absolute; border-radius: 999px; background: rgba(255,255,255,0.7); filter: blur(6px); animation: nx-drift 60s linear infinite; }
.nx-cloud--a { width: 220px; height: 54px; top: 14%; left: -10%; }
.nx-cloud--b { width: 300px; height: 70px; top: 58%; left: -20%; animation-duration: 80s; animation-delay: -30s; opacity: 0.8; }
.nx-cloud--c { width: 180px; height: 44px; top: 34%; left: -15%; animation-duration: 70s; animation-delay: -50s; opacity: 0.6; }
@keyframes nx-drift { from { transform: translateX(0); } to { transform: translateX(130vw); } }

/* Hotspots (stage mode) */
.nx-hs-wrap { position: absolute; transform: translate(-50%, -50%); }
.nx-hs-wrap--stage { animation: nx-float 6s ease-in-out infinite; }
@keyframes nx-float { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }
.nx-hs-island { position: absolute; left: 50%; top: 100%; width: 150px; height: 36px; transform: translate(-50%, -30%); border-radius: 50%;
  background: radial-gradient(closest-side, rgba(255,255,255,0.75), rgba(255,255,255,0)); opacity: 0.8; transition: opacity var(--nx-base) var(--nx-ease), transform var(--nx-base) var(--nx-ease); pointer-events: none; }
.nx-stage:has(.nx-stage__img.is-loaded) .nx-hs-island { display: none; }
.nx-hs { position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 8px; min-width: 168px; min-height: 52px; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
  background: var(--nx-hotspot-bg); color: var(--nx-hotspot-text); cursor: pointer; text-align: left; box-shadow: 0 8px 24px rgba(11,17,32,0.28);
  transition: transform var(--nx-base) var(--nx-ease), box-shadow var(--nx-base) var(--nx-ease), border-color var(--nx-base) var(--nx-ease); }
.nx-hs__text { display: grid; gap: 3px; flex: 1; min-width: 0; }
.nx-hs__label { display: inline-flex; align-items: center; gap: 4px; font: 700 16px/1 var(--nx-font); }
.nx-hs__tag { font: 400 12px/1.2 var(--nx-font); color: var(--nx-hotspot-muted); white-space: nowrap; }
.nx-hs__count { font: 600 11px/1 var(--nx-font); padding: 4px 7px; border-radius: 999px; background: rgba(255,255,255,0.14); color: var(--nx-hotspot-text); }
.nx-tile--accent { background: var(--nx-gradient); color: #fff; }
.nx-hs-wrap:hover .nx-hs, .nx-hs:focus-visible { transform: translateY(-4px); border-color: var(--hs-ring); box-shadow: 0 0 0 3px var(--hs-ring-soft), 0 14px 32px rgba(11,17,32,0.34); outline: none; }
.nx-hs:active { transform: translateY(-2px) scale(0.98); }
.nx-hs-wrap:hover .nx-hs-island, .nx-hs-wrap:focus-within .nx-hs-island { opacity: 1; transform: translate(-50%, -30%) scale(1.12); }
.nx-hs__tip { position: absolute; left: 50%; top: calc(100% + 10px); transform: translateX(-50%); width: max-content; max-width: 260px; padding: 8px 10px; border-radius: var(--nx-radius-sm);
  background: var(--nx-frame); color: var(--nx-frame-text); font: 400 12px/1.4 var(--nx-font); box-shadow: var(--nx-shadow-pop); opacity: 0; pointer-events: none; transition: opacity var(--nx-fast) var(--nx-ease); z-index: 5; }
.nx-hs-wrap:hover .nx-hs__tip, .nx-hs-wrap:focus-within .nx-hs__tip { opacity: 1; }
.nx-hs-wrap[data-hue='violet'] { --hs-ring: var(--nx-hue-violet); --hs-ring-soft: rgba(124,77,255,0.35); }
.nx-hs-wrap[data-hue='blue']   { --hs-ring: var(--nx-hue-blue);   --hs-ring-soft: rgba(47,107,255,0.35); }
.nx-hs-wrap[data-hue='orange'] { --hs-ring: var(--nx-hue-orange); --hs-ring-soft: rgba(232,98,28,0.35); }
.nx-hs-wrap[data-hue='teal']   { --hs-ring: var(--nx-hue-teal);   --hs-ring-soft: rgba(14,140,154,0.35); }
.nx-hs-wrap[data-hue='green']  { --hs-ring: var(--nx-hue-green);  --hs-ring-soft: rgba(30,138,76,0.35); }
.nx-hs-wrap[data-hue='amber']  { --hs-ring: var(--nx-hue-amber);  --hs-ring-soft: rgba(183,121,11,0.35); }
.nx-hs-wrap[data-hue='pink']   { --hs-ring: var(--nx-hue-pink);   --hs-ring-soft: rgba(194,51,138,0.35); }
.nx-hs-wrap[data-hue='slate']  { --hs-ring: var(--nx-hue-slate);  --hs-ring-soft: rgba(62,90,134,0.35); }
.nx-hs-wrap[data-hue='accent'] { --hs-ring: var(--nx-accent);     --hs-ring-soft: rgba(47,107,255,0.35); }

/* Grid mode (< 900px): same cards, no map */
.nx-stage--grid { aspect-ratio: auto; max-height: none; min-height: 0; overflow: visible; border-radius: 0; }
.nx-stage__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.nx-hs-wrap--grid { position: relative; transform: none; }
.nx-hs-wrap--grid .nx-hs { width: 100%; }
.nx-hs-wrap--grid .nx-hs__tip { display: none; }

/* Recent projects */
.nx-recent__head { display: flex; align-items: center; gap: 4px; }
.nx-recent__head .nx-h2 { margin: 0; font-size: 20px; }
.nx-recent__row { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.nx-skel-card { height: 128px; border-radius: var(--nx-radius-lg); }
.nx-pcard { position: relative; display: grid; gap: 10px; padding: 14px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-lg); background: var(--nx-surface); box-shadow: var(--nx-shadow-card); }
.nx-pcard__open { display: flex; align-items: center; gap: 12px; padding: 0 28px 0 0; border: 0; background: none; color: var(--nx-text); text-align: left; cursor: pointer; border-radius: var(--nx-radius-sm); }
.nx-pcard__text { display: grid; gap: 3px; min-width: 0; }
.nx-pcard__name { font: 650 15px/1.25 var(--nx-font); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-pcard__ws { font: 400 13px/1.2 var(--nx-font); color: var(--nx-text-muted); }
.nx-pcard__time { font: 400 12px/1 var(--nx-font); color: var(--nx-text-muted); }
.nx-pcard__menu { position: absolute; top: 8px; right: 6px; }
.nx-menu { position: absolute; right: 0; top: 38px; z-index: 30; min-width: 190px; display: grid; padding: 6px; border: 1px solid var(--nx-border); border-radius: var(--nx-radius-md); background: var(--nx-surface); box-shadow: var(--nx-shadow-pop); }
.nx-menu button { text-align: left; padding: 9px 10px; border: 0; border-radius: 6px; background: none; color: var(--nx-text); font: 400 14px/1.2 var(--nx-font); cursor: pointer; }
.nx-menu button:hover, .nx-menu button:focus-visible { background: var(--nx-surface-hover); outline: none; }

@media (max-width: 1279px) { .nx-recent__row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 899px) { .nx-home { padding: 20px 20px 28px; } }
@media (max-width: 639px) { .nx-recent__row { grid-template-columns: minmax(0, 1fr); } .nx-home { padding: 16px; } }

@media (prefers-reduced-motion: reduce) {
  .nx-hs-wrap--stage, .nx-cloud { animation: none; }
  .nx-hs, .nx-hs-island, .nx-stage__img { transition: none; }
  .nx-hs-wrap:hover .nx-hs, .nx-hs:focus-visible, .nx-hs:active { transform: none; }
}
```

- [ ] **Step 7: `assets/README.md`**

```markdown
# Nexus launcher art (optional)

Place `launcher-islands.webp` (or `.png`/`.jpg`) here to replace the CSS sky placeholder on Home.

- About 2400×1350 (16:9). It is shown with `object-fit: cover`.
- **No labels, cards, text or UI in the image.** The workspace cards are live HTML laid over it.
- Hotspot positions live in `nexus/workspaces/registry.ts` (`island: {x, y}` in %). Retune them to the art.
- Keep it under ~800 KB (webp).
```

- [ ] **Step 8: Wire Home and the "Need help?" card**

In `RouteView.tsx`, set `case 'home': page = <HomePage />; break;` and remove the temporary NotFound branch. Make `.nx-main` render Home without the page padding (HomePage has its own).

In `Sidebar.tsx`, below `<SetupCard />` inside `.nx-sidebar__foot`, add:
```tsx
<button type="button" className="nx-help nx-focusable" onClick={focusComposer}>
  <Icon name="help" size={18} />
  <span><strong>Need help?</strong><br />Ask your lead agent</span>
</button>
```
with `const focusComposer = useNexusUi((s) => s.focusComposer);`, and CSS in `shell.css`:
```css
.nx-help { margin-top: 10px; width: 100%; display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--nx-frame-border); border-radius: var(--nx-radius-md); background: transparent; color: var(--nx-frame-muted); text-align: left; font: 400 12px/1.35 var(--nx-font); cursor: pointer; }
.nx-help strong { color: var(--nx-frame-text); font-weight: 600; font-size: 13px; }
.nx-help:hover { background: var(--nx-frame-hover); }
```

- [ ] **Step 9: Verify and commit**

Run: `npm run typecheck && npm run test:focused`
Expected: exit 0; only the 11 baseline failures.

```bash
git add src/renderer/src/nexus
git commit -m "feat(nexus): island launcher with interactive workspace hotspots and real recent projects"
```

---

### Task 11: Command palette and keyboard shortcuts

**Files:**
- Create: `src/renderer/src/nexus/chrome/paletteIndex.ts` (pure)
- Create: `src/renderer/src/nexus/chrome/CommandPalette.tsx`
- Create: `src/renderer/src/nexus/chrome/useShortcuts.ts`
- Modify: `src/renderer/src/nexus/NexusShell.tsx` (mount the palette and shortcuts)
- Modify: `src/renderer/src/nexus/styles/shell.css` (palette styles)
- Test: `test/nexus-palette.test.cjs`

**Interfaces:**
- Consumes: registry, routes, `Project`
- Produces:
  - `type PaletteEntry = { id: string; group: 'Pages'|'Workspaces'|'Projects'|'Actions'; label: string; hint?: string; route?: Route; action?: 'newProject'|'openIde'|'openSettings' }`
  - `buildPaletteIndex(projects): PaletteEntry[]`
  - `searchPalette(entries, q: string): PaletteEntry[]` (case-insensitive substring over label and hint; empty query returns Pages + Workspaces + up to 5 Projects, in that order)

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { buildPaletteIndex, searchPalette } = loadTs('src/renderer/src/nexus/chrome/paletteIndex.ts');

const projects = [{ id: 'p1', name: 'Fraud Detector', rootPath: '/r/fraud', domainId: 'ai-ml', updatedAt: 2 }, { id: 'p2', name: 'Web Shop', rootPath: '/r/shop', domainId: 'web-app-dev', updatedAt: 1 }];

test('index has pages, workspaces, real projects and actions', () => {
  const idx = buildPaletteIndex(projects);
  assert.ok(idx.some((e) => e.group === 'Pages' && e.label === 'Home'));
  assert.equal(idx.filter((e) => e.group === 'Workspaces').length, 8);
  assert.deepEqual(idx.filter((e) => e.group === 'Projects').map((e) => e.route.id), ['p1', 'p2']);
  assert.ok(idx.some((e) => e.action === 'newProject'));
});

test('search: case-insensitive over label and hint; no match → empty', () => {
  const idx = buildPaletteIndex(projects);
  assert.deepEqual(searchPalette(idx, 'fraud').map((e) => e.id), ['project:p1']);
  assert.ok(searchPalette(idx, 'ML').some((e) => e.id === 'ws:ml'));
  assert.ok(searchPalette(idx, '/r/shop').some((e) => e.id === 'project:p2'));
  assert.deepEqual(searchPalette(idx, 'zzzz'), []);
});

test('empty query shows a bounded default list', () => {
  const idx = buildPaletteIndex(Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, name: `P${i}`, rootPath: '/', domainId: 'ai-ml', updatedAt: i })));
  const res = searchPalette(idx, '  ');
  assert.equal(res.filter((e) => e.group === 'Projects').length, 5);
  assert.equal(res[0].group, 'Pages');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/nexus-palette.test.cjs`
Expected: FAIL (module missing).

- [ ] **Step 3: `chrome/paletteIndex.ts`**

```ts
import type { Route } from '../router/routes';
import { WORKSPACES } from '../workspaces/registry';
import { recentProjects } from '../data/selectors';

export type PaletteEntry = {
  id: string;
  group: 'Pages' | 'Workspaces' | 'Projects' | 'Actions';
  label: string;
  hint?: string;
  route?: Route;
  action?: 'newProject' | 'openIde' | 'openSettings';
};

type P = { id: string; name: string; rootPath: string; domainId: string; updatedAt: number };

const PAGES: PaletteEntry[] = [
  { id: 'page:home', group: 'Pages', label: 'Home', route: { name: 'home' } },
  { id: 'page:workspaces', group: 'Pages', label: 'Workspaces', route: { name: 'workspaces' } },
  { id: 'page:projects', group: 'Pages', label: 'Projects', route: { name: 'projects' } },
  { id: 'page:agents', group: 'Pages', label: 'Agents', hint: 'terminals, floor', route: { name: 'agents' } },
  { id: 'page:artifacts', group: 'Pages', label: 'Artifacts', hint: 'planned', route: { name: 'artifacts' } },
  { id: 'page:handoffs', group: 'Pages', label: 'Handoffs', hint: 'planned', route: { name: 'handoffs' } },
  { id: 'page:deployments', group: 'Pages', label: 'Deployments', hint: 'planned', route: { name: 'deployments' } }
];

const ACTIONS: PaletteEntry[] = [
  { id: 'act:new', group: 'Actions', label: 'New project', action: 'newProject' },
  { id: 'act:ide', group: 'Actions', label: 'Open Files (IDE)', action: 'openIde' },
  { id: 'act:settings', group: 'Actions', label: 'Open Settings', action: 'openSettings' }
];

export function buildPaletteIndex(projects: P[]): PaletteEntry[] {
  const ws: PaletteEntry[] = WORKSPACES.map((w) => ({ id: `ws:${w.id}`, group: 'Workspaces', label: w.name, hint: `${w.label} · ${w.tagline}`, route: { name: 'workspace', id: w.id } }));
  const pr: PaletteEntry[] = recentProjects(projects, projects.length).map((p) => ({ id: `project:${p.id}`, group: 'Projects', label: p.name, hint: p.rootPath, route: { name: 'project', id: p.id } }));
  return [...PAGES, ...ws, ...pr, ...ACTIONS];
}

export function searchPalette(entries: PaletteEntry[], q: string): PaletteEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    const projects = entries.filter((e) => e.group === 'Projects').slice(0, 5);
    return [...entries.filter((e) => e.group === 'Pages' || e.group === 'Workspaces'), ...projects];
  }
  return entries.filter((e) => e.label.toLowerCase().includes(needle) || (e.hint ?? '').toLowerCase().includes(needle));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/nexus-palette.test.cjs`
Expected: PASS (3 tests).

- [ ] **Step 5: `chrome/CommandPalette.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { buildPaletteIndex, searchPalette, type PaletteEntry } from './paletteIndex';

export function CommandPalette() {
  const open = useNexusUi((s) => s.paletteOpen);
  const setOpen = useNexusUi((s) => s.setPaletteOpen);
  const projects = useStore((s) => s.projects);
  const actions = useShellActions();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const index = useMemo(() => buildPaletteIndex(projects), [projects]);
  const results = useMemo(() => searchPalette(index, q), [index, q]);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);
  if (!open) return null;

  const run = (e: PaletteEntry) => {
    setOpen(false);
    if (e.route) navigate(e.route);
    else if (e.action === 'newProject') actions.openNewProject();
    else if (e.action === 'openIde') actions.openIde();
    else if (e.action === 'openSettings') actions.openSettings();
  };

  return (
    <div className="nx-palette-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="nx-palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="nx-palette__input">
          <Icon name="search" size={18} />
          <input
            ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects, workspaces, pages…"
            role="combobox" aria-expanded="true" aria-controls="nx-palette-list" aria-activedescendant={results[sel] ? `nx-pal-${results[sel].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="nx-palette-list" className="nx-palette__list" role="listbox">
          {results.length === 0 && <li className="nx-palette__empty" role="status">Nothing matches '{q.trim()}'</li>}
          {results.map((r, i) => (
            <li key={r.id} id={`nx-pal-${r.id}`} role="option" aria-selected={i === sel}
              className={`nx-palette__item${i === sel ? ' is-sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); run(r); }}>
              <span className="nx-palette__group">{r.group}</span>
              <span className="nx-palette__label">{r.label}</span>
              {r.hint && <span className="nx-palette__hint">{r.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: `chrome/useShortcuts.ts`**

```ts
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
```

- [ ] **Step 7: Mount it and add the palette CSS**

In `NexusShell.tsx`, call `useShortcuts();` and render `<CommandPalette />` inside the provider. Append to `shell.css`:
```css
.nx-palette-layer { position: fixed; inset: 0; z-index: 400; background: rgba(11,17,32,0.5); display: grid; justify-items: center; align-items: start; padding-top: 12vh; }
.nx-palette { width: min(640px, calc(100vw - 32px)); background: var(--nx-surface); color: var(--nx-text); border-radius: var(--nx-radius-lg); box-shadow: var(--nx-shadow-pop); overflow: hidden; }
.nx-palette__input { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--nx-border); color: var(--nx-text-muted); }
.nx-palette__input input { flex: 1; height: 52px; border: 0; background: transparent; color: var(--nx-text); font: 400 16px/1 var(--nx-font); outline: none; }
.nx-palette__input kbd { font: 600 11px/1 var(--nx-font); padding: 4px 6px; border-radius: 6px; background: var(--nx-surface-2); }
.nx-palette__list { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto; }
.nx-palette__item { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 10px; padding: 10px; border-radius: var(--nx-radius-sm); cursor: pointer; }
.nx-palette__item.is-sel { background: var(--nx-surface-hover); }
.nx-palette__group { font: 600 11px/1 var(--nx-font); color: var(--nx-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.nx-palette__label { font: 500 14px/1.3 var(--nx-font); }
.nx-palette__hint { font: 400 12px/1.3 var(--nx-font); color: var(--nx-text-muted); max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-palette__empty { padding: 18px; color: var(--nx-text-muted); font: 400 14px/1.4 var(--nx-font); }
```

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && node --test test/nexus-palette.test.cjs && npm run test:focused`
Expected: exit 0; PASS; only the 11 baseline failures.

```bash
git add src/renderer/src/nexus test/nexus-palette.test.cjs
git commit -m "feat(nexus): command palette (Ctrl/Cmd K) and assistant shortcut (Ctrl/Cmd J)"
```

---

### Task 12: Preview mode, screenshots, responsive/accessibility/de-slop pass

**Files:**
- Modify: `src/renderer/src/browserFallback.ts` (dev only: reach the shell)
- Create (scratchpad, not committed): `<scratchpad>/shoot.cjs`
- Modify: whichever `nexus/styles/*.css` and components the audit flags
- Modify: `package.json` (`test:focused` gains the six `test/nexus-*.test.cjs` files)

- [ ] **Step 1: Let the dev browser preview reach the shell**

In `browserFallback.ts` `getConfig`, add `onboardingComplete: true, autoMode: false, harnessHome: '/sample/home'`. Before installing the proxy, set `try { localStorage.setItem('cth.skipHivePickerOnce', '1'); } catch {}`. Keep the banner. Sample agents stay non-god, so the assistant shows its honest "No lead agent is running" state in the preview.

- [ ] **Step 2: Write the screenshot script** (scratchpad)

```js
// <scratchpad>/shoot.cjs — run: env -u ELECTRON_RUN_AS_NODE npx electron <scratchpad>/shoot.cjs <url> <outdir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const [url, out] = process.argv.slice(-2);
const sizes = [[1440, 900], [1100, 800], [800, 900], [390, 844]];
const routes = ['#/', '#/workspaces', '#/w/ml', '#/w/qa', '#/projects', '#/artifacts', '#/agents'];
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const theme of ['light', 'dark']) for (const [w, h] of sizes) for (const r of routes) {
    const win = new BrowserWindow({ width: w, height: h, show: false, webPreferences: { offscreen: true } });
    await win.loadURL(url + r);
    await win.webContents.executeJavaScript(`try{localStorage.setItem('cth.theme','${theme}');document.documentElement.setAttribute('data-cth-theme','${theme}')}catch(e){}; new Promise(r=>setTimeout(r,1200))`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${theme}-${w}-${r.replace(/[#/]/g, '_') || 'home'}.png`), img.toPNG());
    win.destroy();
  }
  app.quit();
});
```

Run Vite for the renderer only: `npx vite --config <scratch vite config pointing root at src/renderer>`, or start `npm run dev` and read the renderer URL from the log. Then:
`env -u ELECTRON_RUN_AS_NODE npx electron <scratchpad>/shoot.cjs http://localhost:<port>/ <scratchpad>/shots`
Expected: 56 PNGs (2 themes × 4 sizes × 7 routes). Read them back and review.

- [ ] **Step 3: Audit checklist** (fix every "no" in the CSS or component it points to)

1. **Breakpoints:**
   - At 1440: three columns, island stage, 4 recent cards.
   - At 1100: rail, no assistant column, top-bar assistant button visible.
   - At 800: workspace grid instead of the stage.
   - At 390: bottom nav, no sidebar, single column.
   - No horizontal scroll anywhere.
2. **Hotspots:** no label is clipped by the stage edge at 1280 and 1440 (`translate(-50%,-50%)` with x in 10–90 should hold). If any is clipped, nudge its `island` in the registry and keep the registry test green.
3. **Focus:** visible on every interactive element. Tab order: skip link → top bar → sidebar → main → assistant.
4. **Reduced motion:** with `prefers-reduced-motion` emulated (`win.webContents.debugger` → `Emulation.setEmulatedMedia`), nothing floats, drifts or shimmers.
5. **Contrast:** compute WCAG ratios with this one-liner (edit the pairs to match the final token values), each ≥ 4.5 (text) or ≥ 3 (non-text):
   `python -c "L=lambda h:(lambda c:0.2126*c[0]+0.7152*c[1]+0.0722*c[2])([((x/255)/12.92 if x/255<=0.03928 else (((x/255)+0.055)/1.055)**2.4) for x in bytes.fromhex(h)]);R=lambda a,b:round((max(L(a),L(b))+0.05)/(min(L(a),L(b))+0.05),2);print(R('5B6578','FFFFFF'),R('9AA6BD','0B1120'),R('B7C1D6','0B1120'),R('FFFFFF','2457D6'),R('7A859A','FFFFFF'),R('8A5A06','FBEFD3'),R('2457D6','E5EDFF'),R('7D8AA3','0B1120'))"`
   Pairs:
   - `--nx-text-muted`/`--nx-surface`
   - `--nx-frame-muted`/`--nx-frame`
   - `--nx-hotspot-muted`/`--nx-hotspot-bg` (over the lightest sky)
   - `--nx-accent-text`/`--nx-accent`
   - `--nx-border-strong`/`--nx-surface`
   - the badge pairs
6. **Real or absent:** grep `nexus/` for `avatar`, `Math.random`, `faker`, `sample` and hard-coded counts. Expected: none.
7. **No legacy identity in Nexus:**
   - `grep -rn "Pixel\|--cth-" src/renderer/src/nexus` matches only `pages/AgentsView.tsx`, which hosts the legacy floor.
   - `grep -rn "style={{" src/renderer/src/nexus` matches only geometry (hotspot position, bar width).
8. **De-slop:**
   - no gradient on anything except the brand mark, the heading highlight, the assistant logo and the health fill
   - no decorative glow without a state
   - no metric cards
   - card count on Home limited to hotspots + 4 project cards

- [ ] **Step 4: Add the Nexus tests to `test:focused`**

Append `test/nexus-registry.test.cjs test/nexus-routes.test.cjs test/nexus-selectors.test.cjs test/nexus-hotspot-nav.test.cjs test/nexus-prefs.test.cjs test/nexus-assistant.test.cjs test/nexus-palette.test.cjs` to the `test:focused` script in `package.json`.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run test:focused`
Expected: exit 0; only the 11 baseline failures. The Nexus tests (30 in total) are included and pass.

```bash
git add src/renderer/src/browserFallback.ts src/renderer/src/nexus package.json
git commit -m "chore(nexus): responsive and accessibility pass; preview reaches the shell; nexus tests in test:focused"
```

---

### Task 13: Final verification

- [ ] **Step 1: Full suite**

Run: `node --test test/ 2>&1 | tail -8`, then diff the failing names against the baseline list in scratchpad `fb.txt`.
Expected: the same 11 failures, and the pass count up by the number of new Nexus tests.

- [ ] **Step 2: Production build and bundle checks**

Run: `npm run build`
Expected: exit 0.

Then run: `grep -rl "Browser preview: no backend\|Sample project A" out/renderer/`
Expected: no output.

- [ ] **Step 3: Dev run**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`, with the user's other instance closed. Capture the log for 60s.
Expected: no new `uncaughtException` or renderer errors versus the cleanup baseline.

If another instance holds the lock, stop and report that. Do **not** launch a second instance: it archives the first instance's agents (known bug at `src/main/index.ts:4815`).

- [ ] **Step 4: Manual click-through (with the user)**

1. Home → a hotspot → workspace page → a project → Command Center → back.
2. Agents view: floor, sidebar terminal, agent strip, fullscreen toggle.
3. Files opens the IDE.
4. Integrations opens Settings on Connections.
5. Assistant: send "hello" and see it queued on the lead agent's card. Disabled quick actions don't respond.
6. Ctrl/⌘K finds a project.
7. Theme toggle.
8. Resize the window through all four breakpoints.

- [ ] **Step 5: Report**

Summarize what was verified and what wasn't, with the evidence.
