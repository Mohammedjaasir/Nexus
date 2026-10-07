// The nexus:* IPC contract (types only): the result envelope, its error codes, and every
// view and request shape the preload exposes. Nothing here has a runtime value, so the
// preload imports it with `import type` and main and renderer share one definition.
//
// Identity never crosses this boundary from the renderer: no request shape names a
// principal, an actor, a role or a folder. Main resolves the principal on every call.
import type {
  ActivityStatus, ArtifactId, HandoffId, HandoffStatus, LineageRelation, ParticipationId, ParticipationStatus,
  PlatformErrorCode, PrincipalKind, ProjectId, VersionId, VersionStatus, WorkspaceId
} from './platform';

/** Why the whole platform is unavailable (every channel answers platform_unavailable with this reason). */
export type PlatformUnavailableReason = 'held' | 'migration_failed' | 'newer_schema' | 'shape_mismatch' | 'startup_failed' | 'not_open';
/** Why handoffs alone are off while the platform is up (the sub-reason of 'handoffs_unavailable'). */
export type HandoffsUnavailableSubReason = 'held' | 'auto_held' | 'backup_failed' | 'failed' | 'shape';
/**
 * The `reason` of a platform_unavailable answer. 'busy': another writer held the database lock past the busy
 * timeout; nothing was written and the same request may be sent again.
 */
export type UnavailableReason = PlatformUnavailableReason | 'handoffs_unavailable' | 'busy';

export type NexusErrorCode = PlatformErrorCode | 'internal';

/** The keys a failure's `detail` may carry; everything else is dropped in main. */
export type NexusErrorDetailKey = 'currentVersionId' | 'handoffId' | 'versionId' | 'participationId' | 'liveJobs'
  | 'liveSessions' | 'openHandoffs' | 'existingId' | 'limit';

export type NexusOk<T> = { ok: true; data: T; truncated?: boolean };
export type NexusFail = {
  ok: false; code: NexusErrorCode; message: string;
  /** A machine-readable refinement: an unavailable reason, 'bad_request', or a service reason such as 'path_refused'. */
  reason?: string;
  /** With reason 'handoffs_unavailable': why v8 is not in place. */
  subReason?: string;
  /** With reason 'bad_request': the request field that was refused. */
  field?: string;
  detail?: Partial<Record<NexusErrorDetailKey, string | number | null>>;
};
/**
 * Every nexus:* channel answers with this; it never rejects. `truncated` is set on list
 * answers: true when more rows exist than were returned (a service cap or the limit).
 */
export type NexusResult<T> = NexusOk<T> | NexusFail;

// ---------- views (what main sends) ----------

export interface ParticipationView {
  id: ParticipationId; projectId: ProjectId; workspaceId: WorkspaceId; status: ParticipationStatus; isPrimary: boolean;
  objective: string | null; source: 'backfill' | 'legacy_domain' | 'user'; createdAt: number; updatedAt: number;
}
export interface ArtifactView {
  id: ArtifactId; projectId: ProjectId; kind: string; name: string; description: string | null;
  ownerScope: 'participation' | 'project'; ownerParticipationId: ParticipationId | null; ownerWorkspaceId: WorkspaceId | null;
  status: 'active' | 'archived'; currentVersionId: VersionId | null; createdAt: number; updatedAt: number;
}
export interface ArtifactSummaryView {
  artifact: ArtifactView; versionCount: number;
  latest: { id: VersionId; versionNo: number; status: VersionStatus } | null;
  current: { id: VersionId; versionNo: number } | null;
}
/** A version without its content or storage. */
export interface VersionView {
  id: VersionId; artifactId: ArtifactId; versionNo: number; projectId: ProjectId; participationId: ParticipationId | null;
  status: VersionStatus; draftFlag: 'cancelled_partial' | null; storageKind: 'git' | 'blob' | 'tree' | 'external' | 'inline';
  contentHash: string; validationState: 'pending' | 'passed' | 'failed' | 'error';
  /** True when a job or an agent session produced the draft (mark ready is then the engine's, not the user's). */
  producedByEngine: boolean; producedByAction: string | null;
  createdAt: number; statusChangedAt: number; promotedAt: number | null;
}
/** What a version holds: the commit of a git version, the text of a saved text file, a receipt's handoff. */
export type VersionContent =
  | { type: 'git'; commit: string }
  | { type: 'text'; path: string; text: string }
  | { type: 'receipt'; handoffId: HandoffId }
  | { type: 'none' };
export interface VersionDetail extends VersionView { content: VersionContent }
export interface ArtifactDetail { artifact: ArtifactView; versions: VersionView[] }
export interface LineageNodeView {
  versionId: VersionId; artifactId: ArtifactId; kind: string; versionNo: number; status: VersionStatus; depth: number; relation: LineageRelation;
}
export interface LineageView { nodes: LineageNodeView[]; truncated: boolean }
export interface EdgeView {
  id: string; fromVersionId: VersionId; toVersionId: VersionId; relation: LineageRelation;
  source: 'job_input' | 'ingest' | 'user_action' | 'handoff_convert'; createdAt: number;
}
export interface HandoffSummaryView {
  id: HandoffId; projectId: ProjectId; fromParticipationId: ParticipationId; fromWorkspaceId: WorkspaceId;
  toParticipationId: ParticipationId; toWorkspaceId: WorkspaceId; title: string; note: string | null; subjectCount: number;
  status: HandoffStatus; respondedAt: number | null; responseNote: string | null; receiptVersionId: VersionId | null;
  createdAt: number; updatedAt: number; statusChangedAt: number;
}
export interface HandoffSubjectView {
  versionId: VersionId; position: number; contentHash: string; artifactId: ArtifactId; artifactName: string; kind: string;
  versionNo: number; status: VersionStatus; newerVersionNo: number | null;
}
export interface HandoffDetailView extends HandoffSummaryView { subjects: HandoffSubjectView[] }
/** Activity details reduced to an allow-list of small scalar values. */
export type ActivityDetailsView = Record<string, string | number | boolean | null>;
export interface ActivityView {
  seq: number; ts: number; action: string; status: ActivityStatus; actorKind: PrincipalKind;
  /** True when the system acted on the user's behalf (for example mark ready). */
  onBehalfOfUser: boolean;
  entityType: string; entityId: string | null; projectId: ProjectId | null; workspaceId: WorkspaceId | null;
  artifactId: ArtifactId | null; versionId: VersionId | null; details: ActivityDetailsView;
}
export interface SaveResultView { artifact: ArtifactView; version: VersionView; created: boolean }
export interface LinkSourcesView { edges: EdgeView[]; created: number }
export interface SendHandoffView { handoff: HandoffDetailView; created: boolean }

// ---------- requests (what the renderer sends: ids and small values only) ----------

export interface ArtifactsListFilter {
  projectId?: ProjectId; workspaceId?: WorkspaceId; kind?: string; status?: 'active' | 'archived'; limit?: number;
}
export interface LineageQuery { direction: 'up' | 'down'; depth?: number }
export interface HandoffsListFilter {
  projectId?: ProjectId; workspaceId?: WorkspaceId; box?: 'inbox' | 'sent' | 'all'; status?: HandoffStatus; limit?: number;
}
export interface ActivityPage { beforeSeq?: number; limit?: number }
export type SaveTargetArg = { artifactId: ArtifactId } | { name: string };
export interface SaveCommitArgs { projectId: ProjectId; workspaceId: WorkspaceId; commit: string; target: SaveTargetArg }
export interface SaveTextFileArgs { projectId: ProjectId; workspaceId: WorkspaceId; relPath: string; target: SaveTargetArg }
export interface SendHandoffArgs {
  projectId: ProjectId; fromParticipationId: ParticipationId; toParticipationId: ParticipationId;
  versionIds: VersionId[]; title: string; note?: string;
}
