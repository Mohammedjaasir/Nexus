import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';

export function RowsSkeleton({ count = 4 }: { count?: number }) {
  return <div className="nx-rows" aria-busy="true" aria-label="Loading projects">{Array.from({ length: count }, (_, i) => <Skeleton key={i} className="nx-skel-row" />)}</div>;
}

export function LoadError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <EmptyState icon="refresh" title="Couldn't load projects" body={error ?? 'The project list could not be read.'} actions={<Button variant="primary" icon="refresh" onClick={onRetry}>Retry</Button>} />;
}
