export function buildContextHeader(c: { workspace?: string | null; project?: { name: string; rootPath: string } | null; page?: string | null }): string | null {
  if (!c.workspace && !c.project) return null;
  const parts: string[] = [];
  if (c.workspace) parts.push(`workspace: ${c.workspace}`);
  if (c.project) parts.push(`project: ${c.project.name} (${c.project.rootPath})`);
  if (c.page) parts.push(`page: ${c.page}`);
  return `[Nexus context — ${parts.join(' · ')}]`;
}
