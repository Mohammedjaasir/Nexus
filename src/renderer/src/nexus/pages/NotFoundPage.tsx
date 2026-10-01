import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { navigate } from '../router/useRoute';

export function NotFoundPage({ message = "That page doesn't exist." }: { message?: string }) {
  return (
    <div className="nx-page">
      <EmptyState icon="close" title="Not found" body={message}
        actions={<Button variant="primary" onClick={() => navigate({ name: 'home' })}>Go to Home</Button>} />
    </div>
  );
}
