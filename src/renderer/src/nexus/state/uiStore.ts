import { create } from 'zustand';
import { browserStorage, readPref, writePref } from './prefs';
import type { Selection } from '../intent/intentContext';

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
  lastProject: string | null;
  setLastProject: (id: string) => void;
  setupDismissed: boolean;
  dismissSetup: () => void;
  draft: string;
  setDraft: (s: string) => void;
  composerFocusTick: number;
  focusComposer: () => void;
  /** What the user has selected on the current surface (not persisted). */
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
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
  lastProject: readPref(storage, 'lastProject'),
  setLastProject: (id) => { writePref(storage, 'lastProject', id); set({ lastProject: id }); },
  setupDismissed: readPref(storage, 'setupDismissed') === '1',
  dismissSetup: () => { writePref(storage, 'setupDismissed', '1'); set({ setupDismissed: true }); },
  draft: '',
  setDraft: (s) => set({ draft: s }),
  composerFocusTick: 0,
  focusComposer: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1, assistantOpen: true })),
  selection: null,
  setSelection: (s) => set({ selection: s })
}));
