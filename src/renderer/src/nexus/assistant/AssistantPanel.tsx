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
