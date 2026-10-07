/**
 * Service results -> the views the renderer receives (src/shared/nexus/ipc.ts).
 *
 * Each view is built field by field from an explicit list, so a column added to a
 * service type never leaks by default. Lists never carry storage or content; only
 * `versionDetail` returns content, and then only the commit of a git version, the
 * path and text of a saved text file, or the handoff a receipt answers. Principal ids
 * (created_by, actor ids, on_behalf_of) are not sent; activity carries the actor kind.
 */
import type {
  ActivityEntry, Artifact, ArtifactEdge, ArtifactSummary, ArtifactVersion, Handoff, HandoffDetail, LineageNode, ProjectWorkspace
} from '../../shared/nexus/platform';
import type {
  ActivityDetailsView, ActivityView, ArtifactSummaryView, ArtifactView, EdgeView, HandoffDetailView, HandoffSummaryView,
  LineageNodeView, ParticipationView, VersionContent, VersionDetail, VersionView
} from '../../shared/nexus/ipc';
import { scrubMessage } from './envelope';

export function participationView(r: ProjectWorkspace): ParticipationView {
  return { id: r.id, projectId: r.projectId, workspaceId: r.workspaceId, status: r.status, isPrimary: r.isPrimary,
    objective: r.objective, source: r.source, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export function artifactView(a: Artifact): ArtifactView {
  return { id: a.id, projectId: a.projectId, kind: a.kind, name: a.name, description: a.description, ownerScope: a.ownerScope,
    ownerParticipationId: a.ownerParticipationId, ownerWorkspaceId: a.ownerWorkspaceId, status: a.status,
    currentVersionId: a.currentVersionId, createdAt: a.createdAt, updatedAt: a.updatedAt };
}

export function summaryView(s: ArtifactSummary): ArtifactSummaryView {
  return { artifact: artifactView(s.artifact), versionCount: s.versionCount,
    latest: s.latest ? { id: s.latest.id, versionNo: s.latest.versionNo, status: s.latest.status } : null,
    current: s.current ? { id: s.current.id, versionNo: s.current.versionNo } : null };
}

export function versionView(v: ArtifactVersion): VersionView {
  return { id: v.id, artifactId: v.artifactId, versionNo: v.versionNo, projectId: v.projectId, participationId: v.participationId,
    status: v.status, draftFlag: v.draftFlag, storageKind: v.storage.kind, contentHash: v.contentHash,
    validationState: v.validationState, producedByEngine: v.producedByJobId !== null || v.producedBySessionId !== null,
    producedByAction: v.producedByAction, createdAt: v.createdAt, statusChangedAt: v.statusChangedAt, promotedAt: v.promotedAt };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The content a version holds, by an exact shape only; anything else is 'none'. */
export function versionContent(kind: string, v: ArtifactVersion): VersionContent {
  const s = v.storage;
  if (s.kind === 'git' && typeof s.commit === 'string') return { type: 'git', commit: s.commit };
  if (s.kind === 'inline' && isObj(s.json)) {
    const j = s.json;
    if (kind === 'text_file' && typeof j.path === 'string' && typeof j.text === 'string') return { type: 'text', path: j.path, text: j.text };
    if (kind === 'handoff_receipt' && typeof j.handoffId === 'string') return { type: 'receipt', handoffId: j.handoffId };
  }
  return { type: 'none' };
}

export function versionDetail(kind: string, v: ArtifactVersion): VersionDetail {
  return { ...versionView(v), content: versionContent(kind, v) };
}

export function lineageNodeView(n: LineageNode): LineageNodeView {
  return { versionId: n.versionId, artifactId: n.artifactId, kind: n.kind, versionNo: n.versionNo, status: n.status, depth: n.depth, relation: n.relation };
}

export function edgeView(e: ArtifactEdge): EdgeView {
  return { id: e.id, fromVersionId: e.fromVersionId, toVersionId: e.toVersionId, relation: e.relation, source: e.source, createdAt: e.createdAt };
}

export function handoffSummaryView(h: Handoff): HandoffSummaryView {
  return { id: h.id, projectId: h.projectId, fromParticipationId: h.fromParticipationId, fromWorkspaceId: h.fromWorkspaceId,
    toParticipationId: h.toParticipationId, toWorkspaceId: h.toWorkspaceId, title: h.title, note: h.note, subjectCount: h.subjectCount,
    status: h.status, respondedAt: h.respondedAt, responseNote: h.responseNote, receiptVersionId: h.receiptVersionId,
    createdAt: h.createdAt, updatedAt: h.updatedAt, statusChangedAt: h.statusChangedAt };
}

export function handoffDetailView(h: HandoffDetail): HandoffDetailView {
  return { ...handoffSummaryView(h), subjects: h.subjects.map((s) => ({ versionId: s.versionId, position: s.position,
    contentHash: s.contentHash, artifactId: s.artifactId, artifactName: s.artifactName, kind: s.kind, versionNo: s.versionNo,
    status: s.status, newerVersionNo: s.newerVersionNo })) };
}

/**
 * The activity detail keys the renderer may see, each a small scalar. Everything else (backup files, filters,
 * error payloads, ungranted inputs, change lists) is dropped.
 */
export const ACTIVITY_DETAIL_KEYS: readonly string[] = Object.freeze([
  'from', 'to', 'kind', 'versionNo', 'storageKind', 'relation', 'source', 'toVersionId', 'subjects', 'toWorkspaceId',
  'receiptVersionId', 'withNote', 'reactivated', 'previous', 'rollback', 'workspaceId', 'result', 'inputs', 'edges'
]);
const MAX_DETAIL_STRING = 64;

export function activityDetails(d: Record<string, unknown>): ActivityDetailsView {
  const out: ActivityDetailsView = {};
  if (!isObj(d)) return out;
  for (const k of ACTIVITY_DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
    const v = d[k];
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = scrubMessage(v).slice(0, MAX_DETAIL_STRING);
  }
  return out;
}

export function activityView(e: ActivityEntry): ActivityView {
  return { seq: e.seq, ts: e.ts, action: e.action, status: e.status, actorKind: e.actorKind,
    onBehalfOfUser: e.onBehalfOf !== null && e.onBehalfOf !== e.actorId, entityType: e.entityType, entityId: e.entityId,
    projectId: e.projectId, workspaceId: e.workspaceId, artifactId: e.artifactId, versionId: e.versionId, details: activityDetails(e.details) };
}
