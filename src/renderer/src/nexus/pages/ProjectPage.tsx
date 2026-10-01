import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { ProjectCommandCenter } from '@/project/ProjectCommandCenter';
import { navigate } from '../router/useRoute';
import { useProjectsLoader } from '../data/useProjects';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

export function ProjectPage({ id }: { id: string }) {
  const { status } = useProjectsLoader();
  const known = useStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const active = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!known || active?.id === id) return;
    let alive = true;
    setErr(null);
    window.cth.projectSetActive(id)
      .then((p) => { if (alive) { if (p) setActiveProject(p); else setErr('The project could not be opened.'); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, known, active?.id, setActiveProject, attempt]);

  if (!known && status !== 'loading') {
    return <div className="nx-page"><EmptyState icon="projects" title="That project isn't in your list" body="It may have been removed. Open Projects to pick another."
      actions={<Button variant="primary" onClick={() => navigate({ name: 'projects' })}>Back to Projects</Button>} /></div>;
  }
  if (err) {
    return <div className="nx-page"><EmptyState icon="refresh" title="Couldn't open the project" body={err} actions={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} /></div>;
  }
  if (!active || active.id !== id) {
    return <div className="nx-page"><p className="nx-muted" role="status">Opening {known?.name ?? 'project'}…</p></div>;
  }
  return (
    <div className="nx-legacy-host">
      <ProjectCommandCenter
        project={active}
        onBackToHome={() => window.history.back()}
        onRefreshProject={async () => { const r = await window.cth.projectRefresh(active.id); if (r) setActiveProject(r); }}
      />
    </div>
  );
}
