import type { Project } from '@shared/project';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { relativeTime } from '../data/selectors';
import { RepoHealthBar } from './RepoHealthBar';

export function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const ws = workspaceForDomain(project.domainId);
  return (
    <button type="button" className="nx-row nx-focusable" onClick={onOpen}>
      <ProvenanceMark slot={ws?.hueSlot ?? null} size={10} />
      <span className="nx-row__main">
        <span className="nx-row__title">{project.name}</span>
        <span className="nx-row__meta">{ws ? ws.label : UNASSIGNED_LABEL} · {project.domainId} · <span className="nx-id">{project.rootPath}</span></span>
      </span>
      <span className="nx-row__side">
        <span className="nx-row__time nx-id">Updated {relativeTime(project.updatedAt, Date.now())}</span>
        <RepoHealthBar project={project} />
      </span>
    </button>
  );
}
