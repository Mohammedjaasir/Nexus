import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useStore, triggerHistoryVisible, type Agent, type SidebarTab } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { GitTab } from '@/components/GitTab';
import { ThreadsPanel } from '@/components/ThreadsPanel';
import { ToolWaterfall } from '@/components/ToolWaterfall';
import { displayDescription, leadAgentId } from '@shared/agentDisplay';
import { useAgentDisplay } from '../agentIdentity';
import { WorkbenchHeader } from './WorkbenchHeader';
import { WorkbenchTerminal } from './WorkbenchTerminal';
import { LegacyLeadSection } from './LegacyLeadSections';
import { useDeliveryControl } from './useDeliveryControl';
import { initialSection, sectionForRequest, sectionsFor, type WorkbenchSectionId } from './workbenchModel';

/** One workbench for every agent, docked on the Agents page and in fullscreen.
 *  Every agent gets Terminal (pty + queue + controls); the lead agent also gets
 *  the coordination sections.
 *
 *  @param fullscreen this instance is the fullscreen overlay (see WorkbenchTerminal). */
export function AgentWorkbench({ agent, fullscreen = false }: { agent: Agent; fullscreen?: boolean }) {
  // The ONE stream parser for this agent's terminal in this workbench.
  const onPtyStream = usePtyParser(agent.id);
  // Section state, request handling and the lead's local state are per agent:
  // keyed so switching agents starts clean, as the old panels did.
  return <WorkbenchFrame key={agent.id} agent={agent} fullscreen={fullscreen} onPtyStream={onPtyStream} />;
}

function WorkbenchFrame({ agent, fullscreen, onPtyStream }: {
  agent: Agent;
  fullscreen: boolean;
  onPtyStream: (data: string) => void;
}) {
  const { display, hint } = useAgentDisplay();
  const liveAgents = useStore((s) => s.agents);
  const isLead = leadAgentId(liveAgents, hint) === agent.id;
  const info = display.get(agent.id);
  const label = info?.label ?? 'Agent';
  const role = displayDescription(agent, isLead) || info?.role || '';

  const showHistory = useStore(triggerHistoryVisible);
  const sections = sectionsFor({ isLead, showHistory });

  // Non-lead agents: the section is the persisted store `sidebarTab`
  // (localStorage `cth.sidebarTab`). Lead agent: local state, as before.
  const sidebarTab = useStore((s) => s.sidebarTab);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const [leadSection, setLeadSection] = useState<WorkbenchSectionId>('terminal');
  const section: WorkbenchSectionId = isLead ? leadSection : initialSection({ isLead: false, stored: sidebarTab });
  const setSection = (id: WorkbenchSectionId): void => {
    if (isLead) setLeadSection(id);
    else if (sectionsFor({ isLead: false, showHistory: false }).some((s) => s.id === id)) setSidebarTab(id as SidebarTab);
  };

  // Never leave the lead parked on History once it is hidden.
  useEffect(() => {
    if (!showHistory && leadSection === 'history') setLeadSection('terminal');
  }, [showHistory, leadSection]);

  // External section requests (task detail "assign", setup, Tasks / Triggers
  // shortcuts). seq-keyed so a repeat request re-opens the section.
  const ccTabRequest = useStore((s) => s.ccTabRequest);
  useEffect(() => {
    if (!ccTabRequest) return;
    const id = sectionForRequest(ccTabRequest.tab);
    if (!id) return;
    // Read the gate live rather than depending on it: as a dependency it would
    // re-fire a stale request the moment the section appeared.
    if (id === 'history' && !triggerHistoryVisible(useStore.getState())) return;
    if (!sectionsFor({ isLead, showHistory: true }).some((s) => s.id === id)) return;
    setSection(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccTabRequest]);

  // A task "assign" or setup prefill seeds the request box in Team and opens it.
  // Only a NEW seed opens Team; the one already in the store at mount just seeds
  // the box (TaskDetailOverlay pairs its seed with a 'floor' tab request anyway).
  const [dispatchSeed, setDispatchSeed] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const dispatchSeedRequest = useStore((s) => s.dispatchSeedRequest);
  const seenSeedSeq = useRef(dispatchSeedRequest?.seq ?? 0);
  useEffect(() => {
    if (!dispatchSeedRequest) return;
    setDispatchSeed({ text: dispatchSeedRequest.text, seq: dispatchSeedRequest.seq });
    if (dispatchSeedRequest.seq !== seenSeedSeq.current) {
      seenSeedSeq.current = dispatchSeedRequest.seq;
      if (isLead) setLeadSection('team');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchSeedRequest]);

  // Lifted so the graph section can jump to a specific agent's memory file.
  const [memoryWho, setMemoryWho] = useState<string | null>(null);

  const delivery = useDeliveryControl(isLead ? agent.id : null);

  // Tabs: roving tabindex, arrows / Home / End move and select.
  const uid = useId();
  const tabId = (id: WorkbenchSectionId): string => `${uid}-tab-${id}`;
  const panelId = `${uid}-panel`;
  const titleId = `${uid}-title`;
  const tabRefs = useRef(new Map<WorkbenchSectionId, HTMLButtonElement>());
  const active = sections.some((s) => s.id === section) ? section : 'terminal';
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = sections.findIndex((s) => s.id === active);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % sections.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + sections.length) % sections.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sections.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = sections[next].id;
    setSection(id);
    tabRefs.current.get(id)?.focus();
  };

  let body;
  if (active === 'terminal') {
    body = <WorkbenchTerminal agent={agent} fullscreen={fullscreen} isLead={isLead} onPtyStream={onPtyStream} />;
  } else if (active === 'git') {
    body = <div className="nxw__hosted nxw__hosted--row"><GitTab cwd={agent.cwd} /></div>;
  } else if (active === 'messages') {
    body = <div className="nxw__hosted nxw__hosted--row"><ThreadsPanel agentId={agent.id} /></div>;
  } else if (active === 'traces') {
    body = <div className="nxw__hosted nxw__hosted--row"><ToolWaterfall agentId={agent.id} /></div>;
  } else {
    body = (
      <LegacyLeadSection
        section={active}
        agent={agent}
        dispatchSeed={dispatchSeed}
        memoryWho={memoryWho}
        onMemoryWho={setMemoryWho}
        onSection={setSection}
      />
    );
  }

  return (
    <section className={`nxw${fullscreen ? ' nxw--fullscreen' : ''}`} aria-labelledby={titleId}>
      <WorkbenchHeader
        agent={agent}
        label={label}
        role={role}
        isLead={isLead}
        fullscreen={fullscreen}
        delivery={isLead ? delivery : null}
        titleId={titleId}
      />
      <div className="nxw__tabs" role="tablist" aria-label={`${label} sections`} onKeyDown={onTabKey}>
        {sections.map((s) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              ref={(el) => { if (el) tabRefs.current.set(s.id, el); else tabRefs.current.delete(s.id); }}
              type="button"
              role="tab"
              id={tabId(s.id)}
              className="nxw__tab"
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="nxw__panel" role="tabpanel" id={panelId} aria-labelledby={tabId(active)}>
        {body}
      </div>
    </section>
  );
}
