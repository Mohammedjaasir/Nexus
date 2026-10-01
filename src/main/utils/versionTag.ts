/**
 * Deterministic Semantic Version Formatting Utility.
 * Added via Phase 7C End-to-End Task Flow.
 */

export function formatVersionTag(
  major: number,
  minor: number,
  patch: number,
  preRelease?: string
): string {
  const base = `v${Math.max(0, major)}.${Math.max(0, minor)}.${Math.max(0, patch)}`;
  return preRelease ? `${base}-${preRelease}` : base;
}

export function parseVersionTag(tag: string): { major: number; minor: number; patch: number; preRelease?: string } | null {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9_.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    preRelease: match[4]
  };
}
