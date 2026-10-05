import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { DomainId } from '@shared/domain';
import { useStore } from '@/store/store';
import { WORKSPACES, getWorkspace } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import type { WorkspaceId } from '../workspaces/types';
import { recentProjects } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useAssistant } from '../assistant/useAssistant';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { emblemPath } from '../launcher/emblems';
import { detectEnvironment, IDEAS, buildStartRequest, START_STEPS, type StartStepId } from './startModel';
import { StartArt } from './StartArt';

type Folder = { path: string; name: string };

function Steps({ at }: { at: StartStepId }) {
  const i = START_STEPS.findIndex((s) => s.id === at);
  return (
    <div className="nx-start__steps" aria-label={`Step ${i + 1} of ${START_STEPS.length}: ${START_STEPS[i].label}`}>
      <span>Step {i + 1} of {START_STEPS.length}</span>
      <span className="nx-start__bars" aria-hidden="true">{START_STEPS.map((s, k) => <i key={s.id} className={k <= i ? 'is-on' : ''} />)}</span>
    </div>
  );
}

function Emblem({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 100 100" className="nx-start__emblem" aria-hidden="true">
      <path style={{ d: `path("${emblemPath(id)}")` } as CSSProperties} />
    </svg>
  );
}

export function StartPage() {
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const port = useAssistant();

  const [step, setStep] = useState<StartStepId>('describe');
  const [text, setText] = useState('');
  const [envId, setEnvId] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === 'describe') input.current?.focus(); }, [step]);

  const ws = envId ? getWorkspace(envId) : null;
  const ordered = useMemo(() => {
    const here = ws ? recentProjects(projectsForWorkspace(projects, ws.id), projects.length) : [];
    const rest = recentProjects(projects.filter((p) => !here.includes(p)), projects.length);
    return { here, rest };
  }, [projects, ws]);
  const project = projects.find((p) => p.id === projectId) ?? null;

  const describe = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) { input.current?.focus(); return; }
    const d = detectEnvironment(text);
    setDetected(d.id); setEnvId(d.id); setError(null);
    const first = d.id ? recentProjects(projectsForWorkspace(projects, d.id as WorkspaceId), 1)[0] : undefined;
    setProjectId(first?.id ?? null); setFolder(null);
    setStep('confirm');
  };

  const chooseFolder = async () => {
    setError(null);
    try {
      const res = await window.cth.chooseFolder();
      if (res && res.ok && res.path) {
        const name = res.path.split(/[\\/]/).filter(Boolean).pop() ?? 'New project';
        setFolder({ path: res.path, name }); setProjectId(null);
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  /** Step 2 → 3. A new folder becomes a real project here, so step 3
   *  always reviews a project that exists. */
  const confirm = async () => {
    if (!ws) { setError('Choose an environment first.'); return; }
    if (projectId) { setStep('start'); return; }
    if (!folder) { setError('Choose a project, or pick a folder for a new one.'); return; }
    setBusy(true); setError(null);
    try {
      const domainId = (ws.defaultDomainId ?? 'software-engineering') as DomainId;
      const res = await window.cth.projectCreate({ name: folder.name.trim() || 'New project', rootPath: folder.path, domainId, description: text.trim() || undefined });
      if (!res.ok || !res.project) throw new Error(res.error || 'The project could not be created.');
      setProjects(await window.cth.projectList());
      setProjectId(res.project.id); setFolder(null);
      setStep('start');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const request = ws && project ? buildStartRequest({ text, workspaceLabel: ws.label, project: { name: project.name, rootPath: project.rootPath } }) : null;
  const status = port.status;

  const start = async () => {
    if (!ws || !project || !request) return;
    setBusy(true); setError(null);
    const res = port.send({ text: request.text, contextHeader: request.contextHeader });
    if (!res.ok) { setError(res.error); setBusy(false); return; }
    try { const p = await window.cth.projectSetActive(project.id); if (p) setActiveProject(p); } catch { /* opening still works */ }
    setLast(ws.id);
    setBusy(false);
    navigate({ name: 'project', id: project.id, tool: 'bench' });
  };

  return (
    <div className={`nx-start nx-start--${step}`} style={ws ? provenanceStyle(ws.hueSlot) : undefined}>
      <div className="nx-start__bg" aria-hidden="true" />
      <Steps at={step} />

      {step === 'describe' && (
        <section className="nx-start__hero">
          <p className="nx-start__badge"><span aria-hidden="true">✦</span> Let's get started</p>
          <h1 className="nx-start__title" tabIndex={-1}>What are you <em>working on</em> today?</h1>
          <p className="nx-start__sub">Tell us in a few words. Nexus picks the right environment and hands it to your lead agent.</p>
          <form className="nx-ask" onSubmit={describe}>
            <svg className="nx-ask__icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16 L21 21" /></svg>
            <label className="nx-visually-hidden" htmlFor="nx-ask">Describe what you want to build</label>
            <input id="nx-ask" ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. build a web app, analyze data, design a UI…" autoComplete="off" />
            <button type="submit" className="nx-ask__go" aria-label="Continue" disabled={!text.trim()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12 H19 M13 6 L19 12 L13 18" /></svg>
            </button>
          </form>
          <div className="nx-ideas">
            <span>Popular ideas:</span>
            {IDEAS.map((idea) => (
              <button key={idea.label} type="button" className="nx-idea" onClick={() => { setText(idea.prompt); input.current?.focus(); }}>{idea.label}</button>
            ))}
          </div>
          <button type="button" className="nx-start__browse" onClick={() => navigate({ name: 'browse' })}>or browse all environments →</button>
          <StartArt />
        </section>
      )}

      {step === 'confirm' && (
        <section className="nx-start__panel" aria-labelledby="nx-confirm-h">
          <button type="button" className="nx-back" onClick={() => setStep('describe')}>← Edit request</button>
          <p className="nx-start__quote">“{text.trim()}”</p>
          <div className="nx-start__head">
            {ws && <Emblem id={ws.id} />}
            <div>
              <h1 id="nx-confirm-h" className="nx-start__h" tabIndex={-1}>{ws ? <>Sounds like <span>{ws.name}</span></> : 'Which environment fits best?'}</h1>
              <p className="nx-start__note">{ws ? (detected === ws.id ? 'Detected from your words. Change it if that is wrong.' : 'Chosen by you.') : 'Nexus could not tell from the words. Pick one.'}</p>
            </div>
          </div>
          <div className="nx-envs" role="radiogroup" aria-label="Environment">
            {WORKSPACES.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={envId === w.id} className="nx-env nx-prov" style={provenanceStyle(w.hueSlot)}
                onClick={() => { setEnvId(w.id); setProjectId(recentProjects(projectsForWorkspace(projects, w.id), 1)[0]?.id ?? null); setFolder(null); }}>
                <i aria-hidden="true" />{w.label}{detected === w.id && <small>detected</small>}
              </button>
            ))}
          </div>

          <h2 className="nx-start__h2">Where should the work happen?</h2>
          <div className="nx-pick" role="radiogroup" aria-label="Project">
            {[...ordered.here, ...ordered.rest].map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={projectId === p.id} className="nx-pick__row" onClick={() => { setProjectId(p.id); setFolder(null); }}>
                <span className="nx-pick__dot" aria-hidden="true" />
                <span className="nx-pick__name">{p.name}</span>
                <span className="nx-pick__path">{p.rootPath}</span>
                {ordered.here.includes(p) && ws && <span className="nx-pick__tag">{ws.label}</span>}
              </button>
            ))}
            <div className={`nx-pick__row nx-pick__new${folder ? ' is-on' : ''}`} role="radio" aria-checked={!!folder} tabIndex={-1}>
              <span className="nx-pick__dot" aria-hidden="true" />
              {folder ? (
                <>
                  <label className="nx-visually-hidden" htmlFor="nx-new-name">New project name</label>
                  <input id="nx-new-name" className="nx-pick__input" value={folder.name} onChange={(e) => setFolder({ ...folder, name: e.target.value })} />
                  <span className="nx-pick__path">{folder.path}</span>
                  <button type="button" className="nx-link" onClick={chooseFolder}>Change folder</button>
                </>
              ) : (
                <button type="button" className="nx-link nx-pick__choose" onClick={chooseFolder}>+ New project: choose a folder…</button>
              )}
            </div>
          </div>
          {ws && !ws.defaultDomainId && folder && <p className="nx-start__note">New projects are filed by their detected domain; there is no {ws.label} domain yet, so it starts under Software Engineering.</p>}
          {error && <p className="nx-start__err" role="alert">{error}</p>}
          <div className="nx-start__actions">
            <button type="button" className="nx-cta" disabled={busy || !ws || (!projectId && !folder)} onClick={confirm}>{busy ? 'Creating project…' : 'Continue'}</button>
          </div>
        </section>
      )}

      {step === 'start' && ws && project && request && (
        <section className="nx-start__panel" aria-labelledby="nx-start-h">
          <button type="button" className="nx-back" onClick={() => setStep('confirm')}>← Change environment or project</button>
          <div className="nx-start__head">
            <Emblem id={ws.id} />
            <div>
              <h1 id="nx-start-h" className="nx-start__h" tabIndex={-1}>Ready to <span>start</span></h1>
              <p className="nx-start__note">Nothing runs until you press Start building.</p>
            </div>
          </div>
          <dl className="nx-review">
            <div><dt>Environment</dt><dd>{ws.name}</dd></div>
            <div><dt>Project</dt><dd>{project.name} <span className="nx-pick__path">{project.rootPath}</span></dd></div>
            <div><dt>Goes to</dt><dd>{status.state === 'unavailable' ? 'No lead agent is running' : `Lead agent · ${status.target.name}`}{status.state === 'starting' && ' (starting; it is queued until ready)'}{status.state === 'ready' && status.deliveryPaused && ' (delivery is paused; release it in Agents)'}</dd></div>
          </dl>
          <label className="nx-start__h2" htmlFor="nx-req">Request</label>
          <textarea id="nx-req" className="nx-req" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <details className="nx-sent">
            <summary>Exactly what will be sent</summary>
            <pre>{`${request.contextHeader}\n${request.text}`}</pre>
          </details>
          {error && <p className="nx-start__err" role="alert">{error}</p>}
          <div className="nx-start__actions">
            {status.state === 'unavailable'
              ? <button type="button" className="nx-cta" onClick={port.openConversation}>Open Agents to start a lead agent</button>
              : <button type="button" className="nx-cta" disabled={busy || !text.trim()} onClick={start}>{busy ? 'Sending…' : 'Start building →'}</button>}
          </div>
        </section>
      )}
    </div>
  );
}
