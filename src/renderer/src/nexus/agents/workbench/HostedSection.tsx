import type { ReactNode } from 'react';
import { TriggersTab } from '@/components/triggers/TriggersTab';
import { TriggerHistoryTab } from '@/components/triggers/TriggerHistoryTab';
import { MemorySearchPanel } from '@/components/MemorySearchPanel';
import { MemoryGraphPanel } from '@/components/MemoryGraphPanel';
import { SkillsTab } from '@/components/SkillsTab';
import { WorkersTab } from '@/components/WorkersTab';
import type { Agent } from '@/store/store';
import type { WorkbenchSectionId } from './workbenchModel';

/** The lead agent's hosted sections: existing tools with neutral copy, inside
 *  the workbench (Triggers, History, Memory, Graph, Skills, Workers). */
export function HostedSection({ section, agent, memoryWho, onMemoryWho, onSection }: {
  section: WorkbenchSectionId;
  agent: Agent;
  /** Lifted so the graph can jump to one agent's memory file. */
  memoryWho: string | null;
  onMemoryWho: (id: string) => void;
  onSection: (id: WorkbenchSectionId) => void;
}) {
  let body: ReactNode = null;
  switch (section) {
    case 'triggers': body = <TriggersTab />; break;
    case 'history': body = <TriggerHistoryTab />; break;
    case 'memory': body = <MemorySearchPanel godId={agent.id} who={memoryWho ?? undefined} onWho={onMemoryWho} />; break;
    case 'graph':
      body = <MemoryGraphPanel godId={agent.id} onJumpToMemory={(id) => { onMemoryWho(id); onSection('memory'); }} />;
      break;
    case 'skills': body = <SkillsTab agentCwd={agent.cwd} />; break;
    case 'workers': body = <WorkersTab />; break;
    default: body = null;
  }
  return body ? <div className="nxw__hosted">{body}</div> : null;
}
