// Pure: the copy for the Completion tool. Completion rules arrive in a later
// phase; until then nothing is tracked, so this copy must never claim that work
// is finished, checked or partly done, nor name a phase it will ship in.

export interface CompletionCopy {
  title: string;
  badge: string;
  lead: string;
  planned: string;
  detail: string;
  facts: Array<{ label: string; value: string }>;
}

export function completionCopy(i: { domainLabel?: string | null }): CompletionCopy {
  return {
    title: 'Completion',
    badge: 'Planned',
    lead: 'Completion will list what each domain in this project still needs before its work is accepted.',
    planned: 'Planned for a later phase, with completion rules. When it ships: each participating domain shows its checklist, and every item links to the work and evidence behind it.',
    detail: 'Nexus does not record that yet, so there is nothing to show here. Nothing is shown as finished just because checks ran or files exist.',
    facts: [{ label: 'Domain', value: i.domainLabel || 'Unassigned' }]
  };
}
