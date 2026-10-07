// Pure: how artifacts and their versions read on the Spine and in the artifact
// Passport. Labels, the actions the platform would allow on a version, and the
// read-only Passport view built from what the nexus:* read channels returned.
// No React, so tests load it directly. Nothing here invents a row: every value
// comes from an IPC answer or from the project's own git log.
import type { VersionStatus } from '@shared/nexus/platform';
import type {
  ArtifactDetail, ArtifactSummaryView, ArtifactView, LineageNodeView, LineageView, NexusResult, VersionContent, VersionView
} from '@shared/nexus/ipc';
import { errorCopy } from '../data/errorCopy';

const KIND_LABEL: Record<string, string> = { git_commit: 'Commit', text_file: 'Text file', handoff_receipt: 'Received' };

/** "Commit", "Text file", "Received"; any other kind reads as its words ("change_set" → "Change set"). */
export function kindLabel(kind: string): string {
  const known = KIND_LABEL[kind];
  if (known) return known;
  const words = kind.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Artifact';
}

const STATUS_LABEL: Record<VersionStatus, string> = { draft: 'draft', candidate: 'ready', active: 'active', failed: 'failed', deprecated: 'deprecated' };

/** Status is always said in words, never by colour alone. */
export function statusLabel(status: VersionStatus): string {
  return STATUS_LABEL[status] ?? status;
}

/** "derived_from" → "derived from". */
export function relationLabel(relation: string): string {
  return relation.replace(/_/g, ' ');
}

// ---------- version actions (the rules; Task 11 renders them) ----------

export type VersionAction =
  | { kind: 'markReady'; versionId: string }
  | { kind: 'discard'; versionId: string }
  | { kind: 'promote'; versionId: string; expectedCurrentVersionId: string | null }
  | { kind: 'rollback'; versionId: string; expectedCurrentVersionId: string | null }
  | { kind: 'handoff'; versionId: string };

type ActionVersion = Pick<VersionView, 'id' | 'status' | 'producedByEngine' | 'promotedAt'>;
type ActionArtifact = Pick<ArtifactView, 'status' | 'ownerScope' | 'currentVersionId'>;

/**
 * Only the actions the platform would allow on this version. A frozen owner (its
 * participation is not active), an archived artifact or a project-owned one
 * offers no write action. Promote and roll back carry the artifact's current
 * version as the compare-and-set value.
 */
export function actionsFor(version: ActionVersion, artifact: ActionArtifact, ownerActive: boolean): VersionAction[] {
  if (!ownerActive || artifact.status !== 'active' || artifact.ownerScope !== 'participation') return [];
  const id = version.id;
  const expected = artifact.currentVersionId ?? null;
  switch (version.status) {
    case 'draft':
      return version.producedByEngine ? [{ kind: 'discard', versionId: id }] : [{ kind: 'markReady', versionId: id }, { kind: 'discard', versionId: id }];
    case 'candidate':
      return [{ kind: 'promote', versionId: id, expectedCurrentVersionId: expected }, { kind: 'discard', versionId: id }];
    case 'active':
      return [{ kind: 'handoff', versionId: id }];
    case 'deprecated':
      return version.promotedAt !== null ? [{ kind: 'rollback', versionId: id, expectedCurrentVersionId: expected }] : [];
    default:
      return [];
  }
}

// ---------- the project's artifact summaries ----------

export interface ArtifactsState {
  artifacts: ArtifactSummaryView[];
  /** True once an answer arrived (success or not). */
  loaded: boolean;
  /** A passing failure worth a sentence; null on success and while the platform is off (its notice says so). */
  error: string | null;
}

export const NO_ARTIFACTS: ArtifactsState = { artifacts: [], loaded: false, error: null };

/** The next state after a nexus:artifacts:byProject answer. */
export function nextArtifacts(prev: ArtifactsState, r: NexusResult<ArtifactSummaryView[]>): ArtifactsState {
  if (r.ok) return { artifacts: Array.isArray(r.data) ? r.data : [], loaded: true, error: null };
  const copy = errorCopy(r.code, r.reason, r.subReason);
  // The platform is off: there is nothing to show, and the platform notice explains why.
  if (copy.kind === 'unavailable') return { artifacts: [], loaded: true, error: null };
  // The project is gone or unreadable: show nothing rather than stale nodes.
  if (r.code === 'not_found' || r.code === 'denied') return { artifacts: [], loaded: true, error: copy.text };
  // A passing failure: keep what was last read.
  return { artifacts: prev.artifacts, loaded: true, error: copy.text };
}

// ---------- the artifact Passport (read-only) ----------

export interface PassportVersionRow {
  id: string;
  versionNo: number;
  /** "draft", "ready", "active", ... */
  status: string;
  current: boolean;
  /** The version the Spine node shows. */
  shown: boolean;
  /** What the version holds: "Commit <full sha>", "File <path>", "Received through a handoff"; null while unknown. */
  content: string | null;
  /** A git version's subject, only when the project's own git log knows that commit. */
  subject: string | null;
}

export interface PassportLink { versionId: string; label: string; relation: string; status: string }

export interface ArtifactPassportView {
  title: string;
  kind: string;
  rows: { label: string; value: string }[];
  versions: PassportVersionRow[];
  upstream: PassportLink[] | null;
  downstream: PassportLink[] | null;
  upstreamTruncated: boolean;
  downstreamTruncated: boolean;
}

export interface ArtifactPassportInput {
  detail: ArtifactDetail;
  /** The version the Spine node shows (current, else latest). */
  shownVersionId: string | null;
  /** Owner workspace as shown: its label, and whether the participation is still active. */
  owner: { label: string; active: boolean } | null;
  contents: ReadonlyMap<string, VersionContent>;
  /** sha → subject, from the project's own git log only (the allow-list for commit subjects). */
  subjects: ReadonlyMap<string, string>;
  /** artifactId → name, from the project's artifact summaries. */
  names: ReadonlyMap<string, string>;
  up: LineageView | null;
  down: LineageView | null;
}

function contentText(c: VersionContent | undefined): string | null {
  if (!c) return null;
  if (c.type === 'git') return `Commit ${c.commit}`;
  if (c.type === 'text') return `File ${c.path}`;
  if (c.type === 'receipt') return 'Received through a handoff';
  return null;
}

function linkOf(n: LineageNodeView, names: ReadonlyMap<string, string>): PassportLink {
  const name = names.get(n.artifactId);
  const label = name ? `${kindLabel(n.kind)} ${name}, version ${n.versionNo}` : `${kindLabel(n.kind)}, version ${n.versionNo}`;
  return { versionId: n.versionId, label, relation: relationLabel(n.relation), status: statusLabel(n.status) };
}

/** Which version a Spine node stands for: the current one, else the latest. */
export function shownVersionOf(s: Pick<ArtifactSummaryView, 'current' | 'latest'>): { id: string; versionNo: number; status: VersionStatus; isCurrent: boolean } | null {
  if (s.current) return { id: s.current.id, versionNo: s.current.versionNo, status: 'active', isCurrent: true };
  if (s.latest) return { id: s.latest.id, versionNo: s.latest.versionNo, status: s.latest.status, isCurrent: false };
  return null;
}

/**
 * The read-only Passport for one artifact. Only allow-listed fields are copied:
 * no principal, actor or participation id ever reaches the view.
 */
export function artifactPassportView(i: ArtifactPassportInput): ArtifactPassportView {
  const a = i.detail.artifact;
  const versions = [...i.detail.versions].sort((x, y) => y.versionNo - x.versionNo);
  const current = versions.find((v) => v.id === a.currentVersionId) ?? null;
  const rows: { label: string; value: string }[] = [{ label: 'Kind', value: kindLabel(a.kind) }];
  if (i.owner) rows.push({ label: 'Workspace', value: i.owner.active ? i.owner.label : `${i.owner.label} (withdrawn)` });
  rows.push({ label: 'Current version', value: current ? `Version ${current.versionNo}` : 'None yet' });
  rows.push({ label: 'Versions', value: String(versions.length) });
  if (a.status === 'archived') rows.push({ label: 'Status', value: 'Archived' });
  if (a.description) rows.push({ label: 'Description', value: a.description });
  return {
    title: a.name,
    kind: kindLabel(a.kind),
    rows,
    versions: versions.map((v) => {
      const c = i.contents.get(v.id);
      const subject = c && c.type === 'git' ? i.subjects.get(c.commit) ?? null : null;
      return { id: v.id, versionNo: v.versionNo, status: statusLabel(v.status), current: v.id === a.currentVersionId, shown: v.id === i.shownVersionId, content: contentText(c), subject };
    }),
    upstream: i.up ? i.up.nodes.map((n) => linkOf(n, i.names)) : null,
    downstream: i.down ? i.down.nodes.map((n) => linkOf(n, i.names)) : null,
    upstreamTruncated: !!i.up?.truncated,
    downstreamTruncated: !!i.down?.truncated
  };
}
