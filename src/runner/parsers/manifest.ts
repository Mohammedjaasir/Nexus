/**
 * Manifests (B2a Task 11).
 * - `treeManifest`: a build's `/out/dist` as the canonical per-file list `[{ path, sha256, bytes }]` sorted by path, and
 *   its hash: sha256 of that list's canonical JSON (keys sorted), exactly as main's `manifestSha256`
 *   (src/main/nexus/validation/validators/buildChecks.ts) computes it from the staged outputs.
 * - `parseAppManifest`: the text of `nexus.app.json` (at most 16 KiB) as a plain JSON object, for main's
 *   `acceptManifestReport` and `app.manifest_schema`; anything else is refused here.
 */
import { createHash } from 'node:crypto';
import type { StagedOutput } from '../../shared/nexus/execution';

export const APP_MANIFEST_MAX_BYTES = 16 * 1024;

export interface TreeEntry { path: string; sha256: string; bytes: number }
export interface TreeManifest { files: TreeEntry[]; bytes: number; manifestSha256: string }

/** The tree under `prefix` (default `dist/`) of the staged outputs, canonical and hashed. */
export function treeManifest(outputs: readonly StagedOutput[], prefix = 'dist/'): TreeManifest {
  const files = outputs.filter((o) => o.relPath.startsWith(prefix) && o.relPath.length > prefix.length)
    .map((o) => ({ path: o.relPath.slice(prefix.length), sha256: o.sha256, bytes: o.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Canonical JSON of [{ bytes, path, sha256 }]: keys in sorted order, no spaces (JSON.stringify of sorted-key objects).
  const canonical = JSON.stringify(files.map((f) => ({ bytes: f.bytes, path: f.path, sha256: f.sha256 })));
  return { files, bytes: files.reduce((s, f) => s + f.bytes, 0), manifestSha256: createHash('sha256').update(canonical).digest('hex') };
}

export type AppManifestResult = { ok: true; manifest: Record<string, unknown>; sha256: string } | { ok: false; reason: 'too_large' | 'not_json' | 'not_object' };

/** `nexus.app.json` text → a plain object (never a value main has not re-checked). */
export function parseAppManifest(input: Buffer | string): AppManifestResult {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length > APP_MANIFEST_MAX_BYTES) return { ok: false, reason: 'too_large' };
  let v: unknown;
  try { v = JSON.parse(buf.toString('utf8')); } catch { return { ok: false, reason: 'not_json' }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: 'not_object' };
  return { ok: true, manifest: v as Record<string, unknown>, sha256: createHash('sha256').update(buf).digest('hex') };
}
