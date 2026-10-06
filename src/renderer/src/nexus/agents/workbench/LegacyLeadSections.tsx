// TEMPORARY (removed in task 9): hosts the lead agent's existing section bodies
// inside the workbench until each one is rebuilt as a native section, so every
// commit in between stays usable.
import type { ReactNode } from 'react';
import { FloorTab, MemoryTab, ActivityTab } from '@/components/CommandCenterPanel';
import { TasksKanban } from '@/components/TasksKanban';
import { AskMeTab } from '@/components/AskMeTab';
import { TriggersTab } from '@/components/triggers/TriggersTab';
import { TriggerHistoryTab } from '@/components/triggers/TriggerHistoryTab';
import { MemoryGraphPanel } from '@/components/MemoryGraphPanel';
import { SkillsTab } from '@/components/SkillsTab';
import { WorkersTab } from '@/components/WorkersTab';
import type { Agent } from '@/store/store';
import type { WorkbenchSectionId } from './workbenchModel';

export function LegacyLeadSection({ section, agent, dispatchSeed, memoryWho, onMemoryWho, onSection }: {
  section: WorkbenchSectionId;
  agent: Agent;
  /** Task "assign" / setup prefill for the request box in Team (seq-keyed). */
  dispatchSeed: { text: string; seq: number };
  /** Lifted so the graph can jump to one agent's memory file. */
  memoryWho: string | null;
  onMemoryWho: (id: string) => void;
  onSection: (id: WorkbenchSectionId) => void;
}) {
  let body: ReactNode = null;
  switch (section) {
    case 'team': body = <FloorTab seed={dispatchSeed} />; break;
    case 'tasks': body = <TasksKanban />; break;
    case 'needs-you': body = <AskMeTab />; break;
    case 'activity': body = <ActivityTab />; break;
    case 'triggers': body = <TriggersTab />; break;
    case 'history': body = <TriggerHistoryTab />; break;
    case 'memory': body = <MemoryTab godId={agent.id} who={memoryWho ?? undefined} onWho={onMemoryWho} />; break;
    case 'graph':
      body = <MemoryGraphPanel godId={agent.id} onJumpToMemory={(id) => { onMemoryWho(id); onSection('memory'); }} />;
      break;
    case 'skills': body = <SkillsTab agentCwd={agent.cwd} />; break;
    case 'workers': body = <WorkersTab />; break;
    default: body = null;
  }
  return body ? <div className="nxw__hosted">{body}</div> : null;
}
