export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`nx-skeleton ${className}`} aria-hidden="true" />;
}
