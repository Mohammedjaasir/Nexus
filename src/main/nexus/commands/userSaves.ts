/**
 * User saves: a project commit, or a small text file, saved as an artifact version.
 *
 * Rules only. This module imports no file system, no child process and no Electron:
 * every read goes through injected SourcePorts, which main implements
 * (src/main/nexusIpc/sources.ts) over the STORED project row, acceptFsRoot, realpath
 * confinement and the async git helpers. The renderer only ever names a project, a
 * workspace, a relative path or a commit sha; none of them is trusted here.
 *
 * Order, for both saves:
 * 1. Authorization BEFORE any I/O: projects.require at plain project scope with
 *    'artifact.create' (a new artifact) or 'version.register' (an append). A denied
 *    caller learns nothing about files or commits, and no port is called.
 * 2. The project folder comes only from the projects row, accepted by acceptFsRoot
 *    (the port); refused or missing: 'invalid', reason 'project_folder_unavailable'.
 * 3. The read and its checks (below).
 * 4. The write goes through ArtifactService.saveUserVersion, which authorizes again with
 *    the STORED workspace and re-checks the participation and the artifact inside its
 *    transaction. So a project deleted, or a participation withdrawn, while a port was
 *    awaiting gives a clean error and writes nothing. Activity rows are written there.
 *
 * Text file (conflicts C6 and C7): the generic service does not secret-check inline
 * content (B0b §16.11), so THIS command refuses sensitive file names (and any `.git`
 * segment), private-key material, secret-shaped content and text with control
 * characters. The raw file must be at most TEXT_FILE_MAX_BYTES and the stored record
 * `{ path, text }` must fit INLINE_MAX_BYTES after canonicalJson (escaping adds bytes).
 *
 * Commit (conflict C5): kind 'git_commit', storage { kind: 'git', commit } with the full
 * sha git resolved in the project folder (never the caller's text). A secret-shaped
 * subject is dropped from the metadata, never fatal.
 */
import type { Artifact, ArtifactVersion, Principal, ProjectId, WorkspaceId } from '../../../shared/nexus/platform';
import type { NexusPlatform } from '../platform';
import type { SaveTarget } from '../artifact/artifactService';
import { containsSecret } from '../activity/redact';
import { INLINE_MAX_BYTES } from '../artifact/versionRules';
import { canonicalJson } from '../db/canonical';
import { PlatformError } from '../errors';

/** Raw file bytes; the stored record must also fit INLINE_MAX_BYTES. */
export const TEXT_FILE_MAX_BYTES = 65536;

/**
 * File names a user save refuses outright, matched on the basename (case-insensitive, trailing dots and
 * spaces ignored, as Windows ignores them). Any path with a `.git` segment is refused too (isSensitiveName).
 */
export const SENSITIVE_NAMES: readonly RegExp[] = Object.freeze([
  /^\.env$/i, /^\.env\..*$/i,
  /\.pem$/i, /\.key$/i, /\.(jks|keystore|p12|pfx)$/i, /\.ppk$/i,
  /^id_(ecdsa|dsa|ed25519|rsa)/i,
  /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^\.git-credentials$/i, /^\.htpasswd$/i,
  /^credentials/i,
  /\.kdbx$/i
]);
/** Private-key material by its header (PEM, OpenSSH, PGP "PRIVATE KEY BLOCK") or a PuTTY key file. Local to user saves. */
export const PRIVATE_KEY_CONTENT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|PuTTY-User-Key-File-/;
/** C0 control characters other than tab, line feed, form feed and carriage return, plus DEL. */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0E-\x1F\x7F]/;

export type ReadFileError = 'not_found' | 'path_refused' | 'not_a_file' | 'too_large';
export type ResolveCommitError = 'not_a_repository' | 'not_a_commit';

export interface SourcePorts {
  /** projects.root_path from the DB, accepted by acceptFsRoot (its real path); null when missing or refused. */
  projectRoot(projectId: string): Promise<string | null>;
  /**
   * Reads `rel` inside `root`, confined by realpath, reading at most `maxBytes + 1` bytes.
   * `normalisedRel` is the real file's path relative to the real root, with '/' separators.
   */
  readFile(root: string, rel: string, maxBytes: number): Promise<{ bytes: Buffer; normalisedRel: string } | { error: ReadFileError }>;
  /** Resolves `sha` to a commit of the repository at `root`; `commit` is git's full lowercase sha. */
  resolveCommit(root: string, sha: string): Promise<{ commit: string; subject: string; committedAt: number } | { error: ResolveCommitError }>;
}

export interface SaveResult { artifact: Artifact; version: ArtifactVersion; created: boolean }

const MAX_REL_PATH_CHARS = 1024;
const MAX_SUBJECT_CHARS = 500;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const refused = (reason: string, message: string, extra?: Record<string, unknown>): PlatformError =>
  new PlatformError('invalid', message, { reason, ...extra });

/** A path segment as Windows resolves it: trailing dots and spaces dropped. */
const bare = (seg: string): string => seg.replace(/[. ]+$/, '');

/** True when the basename of `rel` (either separator) is a sensitive file name, or any segment is `.git`. */
export function isSensitiveName(rel: string): boolean {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (segs.some((x) => bare(x).toLowerCase() === '.git')) return true;
  const base = segs.pop() ?? '';
  return SENSITIVE_NAMES.some((re) => re.test(base) || re.test(bare(base)));
}

/**
 * Decodes strict UTF-8 text, or null: invalid UTF-8, a NUL, or another C0 control
 * character (tab, LF, FF and CR excepted) or DEL. A byte-order mark is KEPT
 * (ignoreBOM), so the stored text is the file's bytes exactly.
 */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  return CONTROL_CHARS.test(text) ? null : text;
}

/** The target's shape, checked before anything else so the authorization action is right. */
function targetAction(target: unknown): 'artifact.create' | 'version.register' {
  if (!isPlainObject(target) || Object.keys(target).length !== 1) throw new PlatformError('invalid', 'target names either an artifactId or a name');
  if (Object.prototype.hasOwnProperty.call(target, 'name')) return 'artifact.create';
  if (Object.prototype.hasOwnProperty.call(target, 'artifactId')) return 'version.register';
  throw new PlatformError('invalid', 'target names either an artifactId or a name');
}

export class UserSaves {
  constructor(private readonly nx: NexusPlatform, private readonly ports: SourcePorts) {}

  /** Saves a commit of the project's repository as a 'git_commit' version. */
  async saveCommit(p: Principal, i: { projectId: ProjectId; workspaceId: WorkspaceId; commit: string; target: SaveTarget }): Promise<SaveResult> {
    const root = await this.authorizeAndRoot(p, i);
    if (typeof i.commit !== 'string' || !COMMIT_RE.test(i.commit)) throw refused('not_a_commit', 'commit must be a 40-character lowercase hex sha');
    const r = await this.ports.resolveCommit(root, i.commit);
    if ('error' in r) {
      throw r.error === 'not_a_repository'
        ? refused('not_a_repository', 'the project folder is not a git repository')
        : refused('not_a_commit', 'that commit does not exist in the project repository');
    }
    if (typeof r.commit !== 'string' || !COMMIT_RE.test(r.commit)) throw refused('not_a_commit', 'git did not resolve the commit');
    const metadata: Record<string, unknown> = { source: 'git_commit' };
    const subject = typeof r.subject === 'string' ? r.subject.slice(0, MAX_SUBJECT_CHARS) : '';
    if (subject && !containsSecret(subject)) metadata.subject = subject;   // a secret-shaped subject is dropped, never fatal
    if (Number.isSafeInteger(r.committedAt) && r.committedAt >= 0) metadata.committedAt = r.committedAt;
    return this.nx.artifacts.saveUserVersion(p, {
      projectId: i.projectId, workspaceId: i.workspaceId, kind: 'git_commit', target: i.target,
      storage: { kind: 'git', commit: r.commit }, metadata, action: 'user.save_commit'
    });
  }

  /** Saves a small UTF-8 text file inside the project folder as a 'text_file' version. */
  async saveTextFile(p: Principal, i: { projectId: ProjectId; workspaceId: WorkspaceId; relPath: string; target: SaveTarget }): Promise<SaveResult> {
    const root = await this.authorizeAndRoot(p, i);
    const rel = i.relPath;
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_REL_PATH_CHARS || rel.includes('\0')) {
      throw refused('path_refused', 'the path is not a valid relative path');
    }
    if (isSensitiveName(rel)) throw refused('sensitive_name', 'files of this kind may hold secrets and are not saved');
    const read = await this.ports.readFile(root, rel, TEXT_FILE_MAX_BYTES);
    if ('error' in read) {
      switch (read.error) {
        case 'too_large': throw refused('too_large', `the file is larger than ${TEXT_FILE_MAX_BYTES} bytes`, { limit: TEXT_FILE_MAX_BYTES });
        case 'path_refused': throw refused('path_refused', 'the path leads outside the project folder');
        case 'not_a_file': throw refused('file_not_found', 'the path is not a regular file');
        default: throw refused('file_not_found', 'the file does not exist in the project folder');
      }
    }
    if (read.bytes.byteLength > TEXT_FILE_MAX_BYTES) {
      throw refused('too_large', `the file is larger than ${TEXT_FILE_MAX_BYTES} bytes`, { limit: TEXT_FILE_MAX_BYTES });
    }
    // The real file may be reached through a link inside the project: its own name is checked too.
    const path = read.normalisedRel;
    if (typeof path !== 'string' || path.length === 0) throw refused('path_refused', 'the path is not a valid relative path');
    if (isSensitiveName(path)) throw refused('sensitive_name', 'files of this kind may hold secrets and are not saved');
    const text = decodeText(read.bytes);
    if (text === null) throw refused('not_text', 'the file is not UTF-8 text');
    // The cheap, linear size check runs before the secret scan, so the scan only ever sees a record that fits.
    const json = { path, text };
    if (Buffer.byteLength(canonicalJson(json), 'utf8') > INLINE_MAX_BYTES) {
      throw refused('too_large', `the stored file record would be larger than ${INLINE_MAX_BYTES} bytes`, { limit: TEXT_FILE_MAX_BYTES });
    }
    if (PRIVATE_KEY_CONTENT.test(text) || containsSecret(text)) {
      throw refused('secret_in_content', 'the file holds a secret-shaped value and is not saved');
    }
    return this.nx.artifacts.saveUserVersion(p, {
      projectId: i.projectId, workspaceId: i.workspaceId, kind: 'text_file', target: i.target,
      storage: { kind: 'inline', json }, metadata: { source: 'project_file', path, bytes: read.bytes.byteLength },
      action: 'user.save_file'
    });
  }

  /** Authorization first (no I/O before it), then the project folder from the stored row. */
  private async authorizeAndRoot(p: Principal, i: { projectId: ProjectId; workspaceId: WorkspaceId; target: SaveTarget }): Promise<string> {
    if (!isPlainObject(i)) throw new PlatformError('invalid', 'input must be an object');
    if (typeof i.projectId !== 'string' || i.projectId.length === 0) throw new PlatformError('invalid', 'projectId is required');
    if (typeof i.workspaceId !== 'string' || i.workspaceId.length === 0) throw new PlatformError('invalid', 'workspaceId is required');
    this.nx.projects.require(p, i.projectId, targetAction(i.target));
    const root = await this.ports.projectRoot(i.projectId);
    if (typeof root !== 'string' || root.length === 0) throw refused('project_folder_unavailable', 'the project folder is not available');
    return root;
  }
}
