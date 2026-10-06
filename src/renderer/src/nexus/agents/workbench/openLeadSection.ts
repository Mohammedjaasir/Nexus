import { useStore } from '@/store/store';
import { leadAgentId, type DisplayHint } from '@shared/agentDisplay';
import { navigate } from '@/nexus/router/useRoute';
import type { WorkbenchSectionId } from './workbenchModel';

/** Open one of the lead agent's workbench sections from anywhere in the app,
 *  optionally seeding its request box. The lead is selected FIRST: `select`
 *  clears any pending section request, so selecting after it would drop it. */
export function openLeadSection(section: WorkbenchSectionId, seedText?: string, hint?: DisplayHint): void {
  const st = useStore.getState();
  const lead = leadAgentId(st.agents, hint);
  if (lead) st.select(lead);
  if (seedText !== undefined) st.requestDispatchSeed(seedText);
  st.requestCommandCenterTab(section);
  navigate({ name: 'agents' });
}
