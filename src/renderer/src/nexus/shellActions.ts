import { createContext, useContext } from 'react';
import type { DomainId } from '@shared/domain';
import type { Section as SettingsSection } from '@/components/SettingsModal';

export interface ShellActions {
  openSettings: (section?: SettingsSection) => void;
  openNewProject: (domainId?: DomainId) => void;
  openImport: () => void;
  openIde: (root?: string) => void;
  openProjectManager: () => void;
}

export const ShellActionsContext = createContext<ShellActions | null>(null);

export function useShellActions(): ShellActions {
  const a = useContext(ShellActionsContext);
  if (!a) throw new Error('useShellActions outside NexusShell');
  return a;
}
