export type Selection = { kind: 'workspace' | 'project' | 'source' | 'changes' | 'file' | 'artifact'; label: string };

export function selectionLabel(sel: Selection | null): string | null { return sel ? sel.label : null; }
