// This install's `nexus.home` label, shared by main (planBuilder, restart recovery) and the runner (it labels the
// resources it creates and lists them by it): the first 16 hex characters of the sha256 of the data-home root, after
// normalising the path so one data home always gives one label. On Windows paths are case-insensitive and may carry the
// `\\?\` long-path prefix, so the path is resolved, stripped of that prefix and lowercased there; elsewhere it is
// resolved only. Main sends the value to the runner in `hello` (`home`). Node only (main and the runner).
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** The data-home root as it is hashed: resolved; on win32 also without a `\\?\` (or `\\?\UNC\`) prefix and lowercased. */
export function normalizeHomeRoot(root: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    let p = String(root).replace(/\//g, '\\');
    if (/^\\\\\?\\UNC\\/i.test(p)) p = `\\\\${p.slice(8)}`;
    else if (p.startsWith('\\\\?\\')) p = p.slice(4);
    return path.win32.resolve(p).toLowerCase();
  }
  return path.posix.resolve(String(root));
}

/** This install's `nexus.home`: the first 16 hex characters of the sha256 of the normalised data-home root. */
export function homeLabel(root: string, platform: string = process.platform): string {
  return createHash('sha256').update(normalizeHomeRoot(root, platform)).digest('hex').slice(0, 16);
}
