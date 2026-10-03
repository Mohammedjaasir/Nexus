import type { SpineNode } from './spineModel';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { repoHealth } from '../data/selectors';

export type PassportProject = { name: string; rootPath: string; domainId: string; detectedLanguages: { language: string }[]; frameworks: string[]; health: unknown };
export type PassportSection = { title: string; rows: { label: string; value: string }[] };
export type PassportAction = 'ask' | 'files' | 'terminal' | 'refresh';

export const RELATIONSHIPS_NOTE = 'Relationships, usage and handoffs appear here once this project has artifacts.';

export function passportFor(input: { project: PassportProject; node: SpineNode; commits: { shortSha: string; subject: string; time: number }[] }) {
  const { project, node } = input;
  const ws = workspaceForDomain(project.domainId);
  const identity: PassportSection = { title: 'Identity', rows: [
    { label: 'Location', value: project.rootPath },
    { label: 'Workspace', value: ws ? ws.label : UNASSIGNED_LABEL }
  ] };
  const langs = project.detectedLanguages.map((l) => l.language).filter(Boolean);
  if (langs.length) identity.rows.push({ label: 'Languages', value: langs.slice(0, 4).join(', ') });
  if (project.frameworks.length) identity.rows.push({ label: 'Frameworks', value: project.frameworks.slice(0, 4).join(', ') });
  const sections = [identity];
  const h = repoHealth({ health: project.health });
  if (h !== null) sections.push({ title: 'Health', rows: [{ label: 'Repo health', value: `${h} of 100` }] });
  const kind = node.kind === 'changes' ? 'Uncommitted changes' : node.vcs === 'git' ? 'Repository' : 'Folder';
  const versions = node.kind === 'source' && node.vcs === 'git' ? input.commits.map((c, i) => ({ id: c.shortSha, label: c.subject, current: i === 0 })) : [];
  return { title: project.name, kind, sections, versions, relationshipsNote: RELATIONSHIPS_NOTE, actions: ['ask', 'files', 'terminal', 'refresh'] as PassportAction[] };
}
