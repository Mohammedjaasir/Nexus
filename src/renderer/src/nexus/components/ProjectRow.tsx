import type { Project } from '@shared/project';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { relativeTime } from '../data/selectors';
import { RepoHealthBar } from './RepoHealthBar';

export function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const ws = workspaceForDomain(project.domainId);
  return (
    <button type="button" className="nx-row nx-focusable" onClick={onOpen}>
      <span className="nx-row__main">
        <span className="nx-row__title">{project.name}</span>
        <span className="nx-row__meta"><ProvenanceMark slot={ws?.hueSlot ?? null} /> {ws ? ws.label : UNASSIGNED_LABEL} · {project.domainId} · <span className="nx-mono">{project.rootPath}</span></span>
      </span>
      <span className="nx-row__side">
        <span className="nx-row__time">Updated {relativeTime(project.updatedAt, Date.now())}</span>
        <RepoHealthBar project={project} />
      </span>
    </button>
  );
}
