import { create } from 'zustand';
import { browserStorage, readPref, writePref } from './prefs';
import type { Selection } from '../intent/intentContext';

export type SentRequest = { id: string; agentId: string; queuedMessageId: string; text: string; projectId: string | null; selectionLabel: string | null; sentAt: number };

interface NexusUi {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  railExpanded: boolean;
  setRailExpanded: (b: boolean) => void;
  lastWorkspace: string | null;
  setLastWorkspace: (id: string) => void;
  lastProject: string | null;
  setLastProject: (id: string) => void;
  setupDismissed: boolean;
  dismissSetup: () => void;
  draft: string;
  setDraft: (s: string) => void;
  /** Requests sent from the intent line this session (not persisted). */
  requests: SentRequest[];
  addRequest: (r: SentRequest) => void;
  /** Bumped to ask the intent line to take focus (Ctrl/Cmd+J, "Ask" buttons). */
  intentFocusTick: number;
  focusIntent: () => void;
  /** What the user has selected on the current surface (not persisted). */
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
}

const storage = browserStorage();

export const useNexusUi = create<NexusUi>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  railExpanded: false,
  setRailExpanded: (b) => set({ railExpanded: b }),
  lastWorkspace: readPref(storage, 'lastWorkspace'),
  setLastWorkspace: (id) => { writePref(storage, 'lastWorkspace', id); set({ lastWorkspace: id }); },
  lastProject: readPref(storage, 'lastProject'),
  setLastProject: (id) => { writePref(storage, 'lastProject', id); set({ lastProject: id }); },
  setupDismissed: readPref(storage, 'setupDismissed') === '1',
  dismissSetup: () => { writePref(storage, 'setupDismissed', '1'); set({ setupDismissed: true }); },
  draft: '',
  setDraft: (s) => set({ draft: s }),
  requests: [],
  addRequest: (r) => set((s) => ({ requests: [...s.requests, r] })),
  intentFocusTick: 0,
  focusIntent: () => set((s) => ({ intentFocusTick: s.intentFocusTick + 1 })),
  selection: null,
  setSelection: (s) => set({ selection: s })
}));
