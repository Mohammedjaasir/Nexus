import { useEffect, useMemo } from 'react';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { MemoryPanel } from '@/components/MemoryPanel';
import { Icon } from '../icons';
import { agentRows } from './agentList';
import { useRegistryIds } from './agentIdentity';
import { leadAgentId } from '@shared/agentDisplay';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { restoreStatusLine, type RestoreStatus } from '@/hooks/restoreTeamPolicy';

/** Agents: a plain list plus the selected agent's real terminal. */
export function AgentsPage({ config }: { config: HarnessConfig }) {
  const agents = useStore((s) => s.agents);
  const queues = useStore((s) => s.messageQueues);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const godStatus = useStore((s) => s.godStatus);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);

  const hint = useRegistryIds();
  const { restoring, autoRestoring, pendingCount, restoreNote } = useRestoreTeam(config);
  const restoreStatus: RestoreStatus = restoring
    ? { kind: 'running', auto: autoRestoring }
    : pendingCount > 0
      ? { kind: 'pending', count: pendingCount }
      : restoreNote
        ? { kind: 'done', note: restoreNote }
        : { kind: 'idle' };
  const restoreLine = restoreStatusLine(restoreStatus);

  const rows = useMemo(() => agentRows(agents, queues as Record<string, unknown[]>, hint), [agents, queues, hint]);
  const current = rows.find((r) => r.id === selectedId);
  const agent = current ? agents.find((a) => a.id === current.id) : undefined;

  // Single source of selection: when nothing valid is selected, pick the lead
  // agent (rows are lead-first), else the first row.
  useEffect(() => {
    if (!current && rows.length > 0) select(rows[0].id);
  }, [current, rows, select]);

  const toggleFullscreen = () => {
    const s = useStore.getState();
    if (fullscreenAgentId) { s.setFullscreen(null); return; }
    const target = s.agents.find((x) => x.id === s.selectedId && x.ptyId) ?? s.agents.find((x) => x.id === leadAgentId(s.agents, hint) && x.ptyId) ?? s.agents.find((x) => x.ptyId);
    if (target) s.setFullscreen(target.id);
  };

  const addButton = (primary: boolean) => (
    <button type="button" className={`nx-btn nx-focusable${primary ? ' nx-btn--primary' : ''}`} onClick={() => setAddAgentOpen(true)}>
      <Icon name="plus" /> Add agent
    </button>
  );

  return (
    <div className="nxa">
      <div className="nxa__bar">
        <h1 className="nxa__title">Agents</h1>
        <span className="nxa__auto">{config.autoMode ? 'Auto mode is on: agents skip their CLI approval prompts' : 'Auto mode is off'}</span>
        <div className="nxa__actions">
          {addButton(false)}
          <button type="button" className="nx-btn nx-btn--quiet nx-focusable" onClick={toggleFullscreen}>
            <Icon name="panel" /> {fullscreenAgentId ? 'Exit fullscreen' : 'Fullscreen terminal'}
          </button>
        </div>
      </div>

      {restoreLine ? <p className="nxa__restore" role="status">{restoreLine}</p> : null}

      {rows.length === 0 ? (
        godStatus === 'booting' ? (
          <div className="nxa__empty" role="status">
            <p className="nxa__note">The lead agent is starting. Its terminal appears here when it is ready.</p>
          </div>
        ) : (
          <div className="nxa__empty">
            <div className="nx-empty">
              <h2 className="nx-empty__title">No agents yet</h2>
              <p className="nx-empty__body">No agents are running. Add one to see its terminal here.</p>
              <div className="nx-empty__actions">{addButton(true)}</div>
            </div>
          </div>
        )
      ) : (
        <div className="nxa__body">
          <div className="nxa__side">
          <ul className="nxa__list" aria-label="Agents">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="nxa__row nx-focusable"
                  aria-current={r.id === current?.id ? 'true' : undefined}
                  onClick={() => select(r.id)}
                >
                  <span className="nxa__row-title">{r.title}</span>
                  <span className="nxa__row-role">{r.role}</span>
                  <span className="nxa__row-meta">
                    <span>{r.provider}</span>
                    <span>Status: {r.status}</span>
                    {r.queued > 0 && <span>{r.queued} queued</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <details className="nxa__mem">
            <summary className="nxa__mem-sum nx-focusable">Semantic memory</summary>
            <div className="nxa__mem-body"><MemoryPanel defaultOpen /></div>
          </details>
          </div>
          <section className="nxa__term" role="region" aria-label={`${current?.title ?? 'Agent'} panel`}>
            {agent ? <AgentDetailPanel agent={agent} /> : null}
          </section>
        </div>
      )}
    </div>
  );
}
