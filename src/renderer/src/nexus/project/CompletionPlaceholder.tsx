import { Fragment } from 'react';
import type { Project } from '@shared/project';
import { workspaceForDomain } from '../workspaces/mapping';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { completionCopy } from './completionModel';

/** The Completion tool before the platform engine exists: a plain planned
 *  state. No checklist, no counts, no actions; nothing here is tracked yet. */
export function CompletionPlaceholder({ project }: { project: Project }) {
  // Same domain source the passport uses.
  const c = completionCopy({ domainLabel: workspaceForDomain(project.domainId)?.label ?? null });
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <header className="nx-surface__head">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>{c.title}</h1>
        <Badge>{c.badge}</Badge>
      </header>
      <EmptyState icon="completion" title="Nothing is tracked yet" body={
        <>
          <p>{c.lead}</p>
          <p>{c.planned}</p>
          <p>{c.detail}</p>
        </>
      } />
      <dl className="nx-completion__facts">
        {c.facts.map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></Fragment>)}
      </dl>
    </section>
  );
}
