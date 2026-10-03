export function recentProjects<P extends { updatedAt: number; name: string }>(projects: P[], limit = 4): P[] {
  return [...projects]
    .sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The analyzer's real `health.healthScore`, or null when absent or invalid.
 *  Null means "do not render a bar" — never substitute a value. */
export function repoHealth(p: unknown): number | null {
  const v = (p as { health?: { healthScore?: unknown } } | null | undefined)?.health?.healthScore;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v);
}

export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
