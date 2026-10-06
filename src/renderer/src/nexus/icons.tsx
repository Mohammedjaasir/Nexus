import {
  House, LayoutGrid, FolderClosed, Boxes, ArrowLeftRight, Rocket, FileCode2, SquareTerminal,
  Plug, Settings, Search, Sun, Moon, Sparkles, PanelRight, ChevronRight, ChevronLeft, Ellipsis,
  SendHorizontal, Plus, FolderInput, RefreshCw, Lock, Check, Circle, X, CodeXml, Brain, Atom,
  ChartColumn, BookOpen, CircleCheckBig, Palette, Cloud, FolderOpen, Database, Package, LifeBuoy,
  LayoutPanelLeft, FileDiff, ListChecks, Activity, Terminal,
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
  rocket: Rocket, help: LifeBuoy,
  bench: LayoutPanelLeft, changes: FileDiff, completion: ListChecks, runs: Activity, terminal: Terminal
};

export function Icon({ name, size = 18, className }: { name: NexusIconName; size?: number; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={1.75} className={className} aria-hidden="true" focusable="false" />;
}
