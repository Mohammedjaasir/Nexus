import { useEffect, useState, type ReactNode } from 'react';
import type { Project } from '@shared/project';
import type { GitState, SpineNode } from './spineModel';
import { relativeTime } from '../data/selectors';
import { workspaceForDomain } from '../workspaces/mapping';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';

type Head = Extract<GitState, { status: 'ready' }>['head'];

function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

function Provenance({ node, head, onRetry }: { node: SpineNode; head: Head; onRetry: () => void }) {
  const now = useNow();
  if (node.kind !== 'source') return null;
  if (node.vcs === 'none') return <p className="nx-surface__prov">This folder is not a git repository. Change review needs git.</p>;
  if (node.vcs === 'error') {
    return (
      <div className="nx-surface__prov" role="status">
        <span>Git status is unavailable for this folder.</span>
        <Button variant="quiet" icon="refresh" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (node.vcs === 'unknown') return <p className="nx-surface__prov nx-muted" role="status">Reading git status…</p>;
  const lead = node.branch ? `Repository on branch ${node.branch}.` : 'Repository, not on a branch.';
  const last = head
    ? ` Last commit ${head.shortSha} ${head.subject}${head.time ? `, ${relativeTime(head.time * 1000, now)}` : ''}.`
    : ' No commits yet.';
  return <p className="nx-surface__prov">{lead}{last}</p>;
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return <section className="nx-fact"><h2 className="nx-fact__title">{title}</h2>{children}</section>;
}

/** The bench: what the analyzer and git actually know about the project. */
export function SourceView({ project, node, head, onRetry }: { project: Project; node: SpineNode; head: Head; onRetry: () => void }) {
  const ws = workspaceForDomain(project.domainId);
  const langs = project.detectedLanguages.filter((l) => l.language);
  const entries = project.entryPoints.slice(0, 6);
  const suites = project.testSuites;
  const docs = project.documentationFiles;
  const empty = !langs.length && !project.frameworks.length && !entries.length && !suites.length && !docs.length;
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <header className="nx-surface__head">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>{project.name}</h1>
        {node.kind === 'source' && (node.branch || node.head) && (
          <span className="nx-id nx-surface__ref">{[node.branch, node.head?.shortSha].filter(Boolean).join(' · ')}</span>
        )}
      </header>
      <div className="nx-surface__provline">
        <ProvenanceMark slot={ws ? ws.hueSlot : null} />
        <Provenance node={node} head={head} onRetry={onRetry} />
      </div>
      {empty && <p className="nx-muted">The analyzer found no languages, frameworks, entry points, tests or documentation in this folder.</p>}
      {langs.length > 0 && (
        <Fact title="Languages">
          <ul className="nx-fact__list">{langs.map((l) => <li key={l.language}>{l.language}{l.fileCount > 0 ? <span className="nx-muted"> {l.fileCount} {l.fileCount === 1 ? 'file' : 'files'}</span> : null}</li>)}</ul>
        </Fact>
      )}
      {project.frameworks.length > 0 && (
        <Fact title="Frameworks"><ul className="nx-fact__list">{project.frameworks.map((f) => <li key={f}>{f}</li>)}</ul></Fact>
      )}
      {entries.length > 0 && (
        <Fact title="Entry points"><ul className="nx-fact__list">{entries.map((e) => <li key={e} className="nx-id">{e}</li>)}</ul></Fact>
      )}
      {suites.length > 0 && (
        <Fact title="Tests">
          <ul className="nx-fact__list">
            {suites.map((s, i) => (
              <li key={`${s.framework}-${i}`}>{s.framework}{s.testCommand ? <> <code className="nx-id">{s.testCommand}</code></> : null}</li>
            ))}
          </ul>
        </Fact>
      )}
      {docs.length > 0 && (
        <Fact title="Documentation"><ul className="nx-fact__list">{docs.map((d) => <li key={d} className="nx-id">{d}</li>)}</ul></Fact>
      )}
    </section>
  );
}
