import { useMemo, useState } from 'react';
import { WORKSPACES } from '../workspaces/registry';
import type { WorkspaceId } from '../workspaces/types';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { detectEnvironment, IDEAS } from '../start/startModel';
import { SorterStage } from '../hairline/SorterStage';

const STEPS = [
  { title: 'Describe', body: 'Type one sentence on the Start page. Nothing runs until you press Start.' },
  { title: 'Route', body: 'Clue words score each workspace. Four points or more picks it, one to three picks it and asks you to check, zero lets you choose.' },
  { title: 'Agents work', body: 'A lead agent plans in its own terminal and sends helpers messages, delivered locally every 1.5 seconds. Helpers edit files and run tests.' },
  { title: 'Review', body: 'You see a before and after of every changed line, from git, and decide what stays.' }
];

/** Welcome: what Nexus is, shown with the real routing. The request box runs
 *  the Start page's own keyword score; the rack routes the note to the
 *  workspace it picks. Nothing is sent from here: "Continue on Start" carries
 *  the sentence over, and Start is where it runs. */
export function WelcomePage() {
  const [text, setText] = useState('Train a model to classify support emails');
  const setPrefill = useNexusUi((s) => s.setStartPrefill);
  const setLast = useNexusUi((s) => s.setLastWorkspace);

  const detection = useMemo(() => detectEnvironment(text), [text]);
  const index = detection.id ? WORKSPACES.findIndex((w) => w.id === detection.id) : -1;
  const ws = index >= 0 ? WORKSPACES[index] : null;

  const toStart = () => { setPrefill(text.trim()); navigate({ name: 'home' }); };
  const openWorkspace = (id: WorkspaceId) => { setLast(id); navigate({ name: 'workspace', id }); };

  return (
    <div className="nx-page nx-welcome">
      <div className="nx-welcome__hero">
        <div className="nx-welcome__pitch">
          <span className="nx-welcome__eyebrow">Welcome to Nexus</span>
          <h1 tabIndex={-1}>One sentence in.<br />A reviewed diff out.</h1>
          <p className="nx-welcome__lede">
            Nexus reads your request, routes it to the right workspace, and hands it to a team of real coding agents
            running in terminals on this machine. You review every changed line before anything is kept.
          </p>

          <form className="nx-welcome__ask" onSubmit={(e) => { e.preventDefault(); if (text.trim()) toStart(); }}>
            <label htmlFor="nx-welcome-req">What are you working on?</label>
            <input id="nx-welcome-req" type="text" value={text} spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)} />
            <p className="nx-welcome__verdict" aria-live="polite" style={ws ? provenanceStyle(ws.hueSlot) : undefined}>
              {!text.trim() ? 'Describe what you want to work on.'
                : !ws ? 'No clue words yet, so no workspace is picked. On Start you would choose one.'
                : <>
                    <i aria-hidden="true" />
                    <b>{ws.name}</b>
                    <span className={`nx-welcome__conf nx-welcome__conf--${detection.confidence}`}>{detection.confidence === 'strong' ? 'strong match' : 'weak match, check it'}</span>
                    {detection.matched.map((w, i) => <code key={`${w}-${i}`}>{w}</code>)}
                  </>}
            </p>
            <div className="nx-welcome__ideas" aria-label="Examples">
              {IDEAS.map((idea) => (
                <button key={idea.label} type="button" className="nx-wb__idea" onClick={() => setText(idea.prompt)}>{idea.label}</button>
              ))}
            </div>
            <div className="nx-welcome__actions">
              <button type="submit" className="nx-btn nx-btn--primary" disabled={!text.trim()}>Continue on Start</button>
              <button type="button" className="nx-btn" onClick={() => navigate({ name: 'browse' })}>Browse environments</button>
            </div>
          </form>
        </div>

        <figure className="nx-welcome__figure">
          <SorterStage pick={index} />
          <figcaption>Eight cubbies, one per workspace. The one your request routes to takes the note. Point at a cubby to try it by hand.</figcaption>
        </figure>
      </div>

      <section className="nx-welcome__section" aria-labelledby="nx-welcome-how">
        <div className="nx-welcome__head">
          <h2 id="nx-welcome-how">Nexus routes the work. The agents write the code.</h2>
          <p>Nexus never writes code itself, and nothing in the app is simulated. What you review is the real git diff.</p>
        </div>
        <ol className="nx-welcome__steps">
          {STEPS.map((s) => <li key={s.title}><h3>{s.title}</h3><p>{s.body}</p></li>)}
        </ol>
      </section>

      <section className="nx-welcome__section" aria-labelledby="nx-welcome-ws">
        <div className="nx-welcome__head">
          <h2 id="nx-welcome-ws">Eight kinds of work, each with its own place.</h2>
          <p>Projects are filed under the workspace that matches them, and each workspace keeps one colour, so you can tell where something came from.</p>
        </div>
        <ul className="nx-welcome__ws">
          {WORKSPACES.map((w, i) => (
            <li key={w.id} style={provenanceStyle(w.hueSlot)}>
              <button type="button" className={i === index ? 'is-on' : undefined} onClick={() => openWorkspace(w.id)} aria-label={`Open ${w.name}`}>
                <span className="nx-welcome__wslabel"><i aria-hidden="true" />{w.label}</span>
                <b>{w.name}</b>
                <small>{w.tagline}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="nx-welcome__section" aria-labelledby="nx-welcome-status">
        <div className="nx-welcome__head">
          <h2 id="nx-welcome-status">What runs today, and what comes next.</h2>
          <p>Planned features show as labelled placeholders, never as fake output. Where an agent doesn't report a plan or a review, Nexus says "Not reported by this agent".</p>
        </div>
        <div className="nx-welcome__split">
          <div>
            <h3>Today</h3>
            <ul>
              <li>Workspaces and projects, with each local folder analysed and filed</li>
              <li>Claude Code, Codex and other CLI agents in real terminals, coordinated by a lead agent</li>
              <li>Artifacts and handoffs between workspaces</li>
              <li>Files, terminals, git history, skills and MCP servers</li>
            </ul>
          </div>
          <div>
            <h3>Planned</h3>
            <ul>
              <li>Turn into App, builds and deployments</li>
              <li>A sandboxed agent runtime</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
