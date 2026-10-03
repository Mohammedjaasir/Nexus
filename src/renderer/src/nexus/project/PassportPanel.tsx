import { Fragment, useEffect, useState } from 'react';
import type { Project } from '@shared/project';
import type { SpineNode } from './spineModel';
import { passportFor, type PassportAction } from './passport';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { Button } from '../ui/Button';
import type { NexusIconName } from '../icons';

type Commit = { shortSha: string; subject: string; time: number };

const ACTION_LABEL: Record<PassportAction, string> = { ask: 'Ask an agent', files: 'Open files', terminal: 'Open terminal', refresh: 'Refresh analysis' };
const ACTION_ICON: Record<PassportAction, NexusIconName> = { ask: 'assistant', files: 'files', terminal: 'terminal', refresh: 'refresh' };

/** Recent commits for a git source node; empty for anything else. */
function useCommits(root: string, isGit: boolean, headSha: string | null): Commit[] {
  const [commits, setCommits] = useState<Commit[]>([]);
  useEffect(() => {
    if (!isGit) { setCommits([]); return; }
    let alive = true;
    window.cth.gitLog(root, 8)
      .then((log) => { if (alive) setCommits(Array.isArray(log) ? log.map((c) => ({ shortSha: c.shortSha, subject: c.subject, time: c.time })) : []); })
      .catch(() => { if (alive) setCommits([]); });
    return () => { alive = false; };
  }, [root, isGit, headSha]);
  return commits;
}

/** `notice` carries bench-level errors (opening the terminal from the rail or
 *  from here), shown in the same alert line as the passport's own errors. */
export function Passport({ project, node, headSha, onRefreshProject, onOpenTerminal, notice }: {
  project: Project; node: SpineNode; headSha: string | null; onRefreshProject: () => Promise<void>; onOpenTerminal: () => void; notice: string | null;
}) {
  const actions = useShellActions();
  const focusComposer = useNexusUi((s) => s.focusComposer);
  const isGit = node.kind === 'source' && node.vcs === 'git';
  const commits = useCommits(project.rootPath, isGit, headSha);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const p = passportFor({ project, node, commits });

  const run = (a: PassportAction) => {
    setNote(null);
    if (a === 'ask') focusComposer();
    else if (a === 'files') actions.openIde(project.rootPath);
    else if (a === 'terminal') onOpenTerminal();
    else {
      setBusy(true);
      onRefreshProject()
        .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    }
  };

  return (
    <aside className="nx-passport" aria-labelledby="nx-passport-title">
      <header>
        <p className="nx-passport__kind">{p.kind}</p>
        <h2 id="nx-passport-title" className="nx-passport__title">{p.title}</h2>
      </header>
      {p.sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          <dl>{s.rows.map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}</dl>
        </section>
      ))}
      {p.versions.length > 0 && (
        <section>
          <h2>Versions</h2>
          <ol className="nx-versions">
            {p.versions.map((v) => (
              <li key={v.id} aria-current={v.current ? 'true' : undefined}>
                <span className="nx-id">{v.id}</span><span>{v.label}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="nx-muted">{p.relationshipsNote}</p>
      <div className="nx-passport__actions">
        {p.actions.map((a) => (
          <Button key={a} variant={a === 'ask' ? 'primary' : 'secondary'} icon={ACTION_ICON[a]} disabled={a === 'refresh' && busy} onClick={() => run(a)}>
            {a === 'refresh' && busy ? 'Refreshing…' : ACTION_LABEL[a]}
          </Button>
        ))}
      </div>
      {(note ?? notice) && <p className="nx-passport__note" role="alert">{note ?? notice}</p>}
    </aside>
  );
}
