/**
 * Deterministic JSON: object keys sorted at every depth, array order kept.
 * Follows JSON.stringify for everything else (undefined members are dropped,
 * non-finite numbers become null, toJSON is honoured), so the same value
 * always hashes the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === 'function') return sortKeys(withJson.toJSON());
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}
