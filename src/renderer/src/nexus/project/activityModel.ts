// Pure: the project's recent activity (nexus:activity:byProject) as plain
// sentences. Each row becomes who acted ("You", "Nexus", "Nexus, for you"),
// what happened in words, and when. No principal id, no raw details: a sentence
// reads only the allow-listed detail keys below, and only values of the
// expected shape. No React, so tests load it directly.
import type { ActivityView, ArtifactSummaryView, NexusResult } from '@shared/nexus/ipc';
import { errorCopy } from '../data/errorCopy';
import { relativeTime } from '../data/selectors';
import { kindLabel } from './artifactModel';

/** How many rows one read asks for (the channel allows up to 50). */
export const ACTIVITY_PAGE = 20;

/** The only detail keys a sentence ever reads. Everything else in `details` is never looked at. */
export const ACTIVITY_DETAIL_ALLOW: readonly string[] = Object.freeze([
  'versionNo', 'to', 'rollback', 'source', 'reactivated', 'subjects', 'toWorkspaceId', 'withNote', 'kind', 'workspaceId'
]);

/** Every action the platform services write to the activity log. */
export const ACTIVITY_ACTIONS: readonly string[] = Object.freeze([
  'artifact.create', 'artifact.archive',
  'version.register', 'version.update_draft', 'version.finalize', 'version.promote', 'version.discard',
  'lineage.write',
  'participation.attach', 'participation.withdraw',
  'handoff.send', 'handoff.accept', 'handoff.decline', 'handoff.withdraw',
  'job.create', 'job.cancel', 'job.recover', 'job.transition',
  'session.open', 'session.cancel', 'session.recover', 'session.transition',
  'db.migrated', 'workspace.catalog_ensured', 'project_workspace.primary_synced'
]);

/** Plain words for an action a person may be refused (every platform action). */
const ACTION_WORDS: Record<string, string> = {
  'project.read': 'read the project',
  'workspace.read': 'read a workspace',
  'participation.attach': 'add the project to a workspace',
  'participation.withdraw': 'withdraw the project from a workspace',
  'artifact.read': 'read an artifact',
  'artifact.create': 'create an artifact',
  'artifact.archive': 'archive an artifact',
  'version.register': 'save a version',
  'version.update_draft': 'change a draft',
  'version.discard': 'discard a version',
  'version.promote': 'make a version current',
  'version.finalize': 'mark a version ready',
  'lineage.read': 'read links between versions',
  'lineage.write': 'link versions',
  'job.read': 'read a job',
  'job.create': 'start a job',
  'job.cancel': 'stop a job',
  'job.transition': 'move a job on',
  'job.recover': 'recover a job',
  'session.read': 'read an agent session',
  'session.open': 'open an agent session',
  'session.cancel': 'stop an agent session',
  'session.transition': 'move an agent session on',
  'session.recover': 'recover an agent session',
  'activity.read': 'read the activity',
  'system.reconcile': 'reconcile the records',
  'handoff.read': 'read a handoff',
  'handoff.send': 'send a handoff',
  'handoff.respond': 'answer a handoff',
  'handoff.withdraw': 'withdraw a handoff',
  'handoff.accept': 'accept a handoff',
  'handoff.decline': 'decline a handoff',
  'db.migrated': 'upgrade the database',
  'workspace.catalog_ensured': 'update the workspace list',
  'project_workspace.primary_synced': 'set the main workspace'
};

const ACTION_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const WORKSPACE_SHAPE = /^[a-z][a-z0-9-]{1,31}$/;
const KIND_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** An action as it may appear on screen: its own dotted name only, never other text. */
function safeAction(action: unknown): string {
  return typeof action === 'string' && action.length <= 64 && ACTION_SHAPE.test(action) ? action : 'an action';
}

/** Plain words for an action; an unknown one reads as its own dotted name. */
export function actionWords(action: string): string {
  return Object.prototype.hasOwnProperty.call(ACTION_WORDS, action) ? ACTION_WORDS[action] : safeAction(action);
}

/** One allow-listed detail value. A key outside the allow-list is never read. */
function detail(row: ActivityView, key: string): unknown {
  if (!ACTIVITY_DETAIL_ALLOW.includes(key)) return undefined;
  const d = row.details;
  if (!d || typeof d !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

export interface ActivityContext {
  /** artifactId → name, from the project's artifact summaries. */
  names: ReadonlyMap<string, string>;
  /** versionId → version number, from the summaries and the rows themselves. */
  versionNos: ReadonlyMap<string, number>;
  /** A workspace's label from the renderer registry (falls back to its id). */
  workspaceLabel: (workspaceId: string) => string;
  now: number;
}

export interface ActivityLine {
  key: string;
  /** "You", "Nexus", "Nexus, for you", "An agent". */
  actor: string;
  /** What happened, as a sentence. */
  text: string;
  /** "just now", "5m ago", "Mar 3". */
  when: string;
  /** ISO time for the <time> element. */
  at: string;
}

/** Who acted, in words. The principal id is never shown. */
export function actorText(row: Pick<ActivityView, 'actorKind' | 'onBehalfOfUser'>): string {
  if (row.actorKind === 'user') return 'You';
  if (row.actorKind === 'system') return row.onBehalfOfUser ? 'Nexus, for you' : 'Nexus';
  if (row.actorKind === 'agent') return 'An agent';
  return 'Someone';
}

function artifactName(row: ActivityView, ctx: ActivityContext): string | null {
  return row.artifactId ? ctx.names.get(row.artifactId) ?? null : null;
}

/** "Version 2 of API notes", "A version of API notes", "Version 2", "A version". */
function versionPhrase(row: ActivityView, ctx: ActivityContext): string {
  const name = artifactName(row, ctx);
  const no = posInt(detail(row, 'versionNo')) ?? (row.versionId ? ctx.versionNos.get(row.versionId) ?? null : null);
  if (no !== null) return name ? `Version ${no} of ${name}` : `Version ${no}`;
  return name ? `A version of ${name}` : 'A version';
}

function workspacePhrase(id: unknown, ctx: ActivityContext): string | null {
  return typeof id === 'string' && WORKSPACE_SHAPE.test(id) ? ctx.workspaceLabel(id) : null;
}

/** Job states and agent session statuses, in words. */
const JOB_STATE_WORDS: Record<string, string> = {
  queued: 'queued', leased: 'picked up', running: 'started running', awaiting_approval: 'is waiting for approval',
  retry_scheduled: 'will be tried again', completed: 'completed', partial: 'completed in part', failed: 'failed',
  cancelled: 'was stopped', timed_out: 'timed out', interrupted: 'was interrupted', open: 'opened'
};

function stateMove(subject: string, to: unknown): string {
  const words = typeof to === 'string' && Object.prototype.hasOwnProperty.call(JOB_STATE_WORDS, to) ? JOB_STATE_WORDS[to] : null;
  return words ? `${subject} ${words}` : `${subject} changed status`;
}

/** The sentence for a succeeded (or started) row of a known action; null for an unknown action. */
function sentence(row: ActivityView, ctx: ActivityContext): string | null {
  const name = artifactName(row, ctx);
  switch (row.action) {
    case 'artifact.create': {
      const kind = detail(row, 'kind');
      const label = typeof kind === 'string' && KIND_SHAPE.test(kind) ? kindLabel(kind) : 'Artifact';
      return name ? `${label} ${name} created` : `${label} created`;
    }
    case 'artifact.archive': return name ? `${name} archived` : 'An artifact archived';
    case 'version.register': return `${versionPhrase(row, ctx)} saved`;
    case 'version.update_draft': return `${versionPhrase(row, ctx)} updated as a draft`;
    case 'version.finalize': {
      const to = detail(row, 'to');
      if (to === 'candidate') return `${versionPhrase(row, ctx)} marked ready`;
      if (to === 'failed') return `${versionPhrase(row, ctx)} did not pass its checks`;
      return `${versionPhrase(row, ctx)} finished`;
    }
    case 'version.promote':
      return detail(row, 'rollback') === true ? `${versionPhrase(row, ctx)} made current again (roll back)` : `${versionPhrase(row, ctx)} made current`;
    case 'version.discard': return `${versionPhrase(row, ctx)} discarded`;
    case 'lineage.write':
      return detail(row, 'source') === 'handoff_convert'
        ? `${versionPhrase(row, ctx)} linked to a version it received`
        : `Source linked to ${versionPhrase(row, ctx).replace(/^[VA]/, (c) => c.toLowerCase())}`;
    case 'participation.attach': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      const again = detail(row, 'reactivated') === true ? ' again' : '';
      return ws ? `Project added to ${ws}${again}` : `Project added to a workspace${again}`;
    }
    case 'participation.withdraw': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      return ws ? `Project withdrawn from ${ws}` : 'Project withdrawn from a workspace';
    }
    case 'handoff.send': {
      const ws = workspacePhrase(detail(row, 'toWorkspaceId'), ctx);
      const n = posInt(detail(row, 'subjects'));
      const what = n === null ? 'Handoff' : n === 1 ? 'Handoff of 1 version' : `Handoff of ${n} versions`;
      return ws ? `${what} sent to ${ws}` : `${what} sent`;
    }
    case 'handoff.accept': {
      const ws = workspacePhrase(row.workspaceId, ctx);
      return ws ? `Handoff accepted in ${ws}` : 'Handoff accepted';
    }
    case 'handoff.decline': return detail(row, 'withNote') === true ? 'Handoff declined, with a note' : 'Handoff declined';
    case 'handoff.withdraw': return 'Handoff withdrawn';
    case 'job.create': return 'Job created';
    case 'job.cancel': return 'Job stopped';
    case 'job.recover': return 'Job recovered after a restart';
    case 'job.transition': return stateMove('Job', detail(row, 'to'));
    case 'session.open': return 'Agent session opened';
    case 'session.cancel': return 'Agent session stopped';
    case 'session.recover': return 'Agent session recovered after a restart';
    case 'session.transition': return stateMove('Agent session', detail(row, 'to'));
    case 'db.migrated': return 'Database upgraded';
    case 'workspace.catalog_ensured': return 'Workspace list updated';
    case 'project_workspace.primary_synced': {
      const ws = workspacePhrase(detail(row, 'workspaceId'), ctx);
      return ws ? `Main workspace set to ${ws}, from the project's domain` : "Main workspace set from the project's domain";
    }
    default: return null;
  }
}

/** What a row says happened. A refusal or failure names the action in words; an unknown action says only its name. */
export function activityText(row: ActivityView, ctx: ActivityContext): string {
  if (row.status === 'denied') return `Refused: ${actionWords(row.action)}`;
  if (row.status === 'failed') return `Failed: ${actionWords(row.action)}`;
  if (row.status === 'cancelled') return `Cancelled: ${actionWords(row.action)}`;
  return sentence(row, ctx) ?? `Recorded ${safeAction(row.action)}`;
}

export function activityLine(row: ActivityView, ctx: ActivityContext): ActivityLine {
  const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : NaN;
  return {
    key: String(row.seq),
    actor: actorText(row),
    text: activityText(row, ctx),
    when: Number.isFinite(ts) ? relativeTime(ts, ctx.now) : '',
    at: Number.isFinite(ts) ? new Date(ts).toISOString() : ''
  };
}

/** versionId → number: from the summaries (latest, current) and from each saved-version row's own number. */
export function versionNumbers(rows: readonly ActivityView[], summaries: readonly ArtifactSummaryView[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of summaries) {
    if (s.latest) out.set(s.latest.id, s.latest.versionNo);
    if (s.current) out.set(s.current.id, s.current.versionNo);
  }
  for (const r of rows) {
    const no = r.action === 'version.register' ? posInt(detail(r, 'versionNo')) : null;
    if (no !== null && r.versionId && !out.has(r.versionId)) out.set(r.versionId, no);
  }
  return out;
}

// ---------- the read state (first page, older pages, failures) ----------

export interface ActivityState {
  rows: ActivityView[];
  /** True once an answer arrived (success or not). */
  loaded: boolean;
  /** True when older rows exist than were read. */
  truncated: boolean;
  /** A passing failure worth a sentence. */
  error: string | null;
  /** True when sending the same read again may help. */
  retry: boolean;
  /** The platform is off: the section shows nothing (the platform notice explains). */
  unavailable: boolean;
  /** An older page is being read. */
  loadingMore: boolean;
}

export const NO_ACTIVITY: ActivityState = { rows: [], loaded: false, truncated: false, error: null, retry: false, unavailable: false, loadingMore: false };

/** The next state after a nexus:activity:byProject answer: 'first' replaces, 'more' appends an older page. */
export function nextActivity(prev: ActivityState, r: NexusResult<ActivityView[]>, page: 'first' | 'more'): ActivityState {
  if (r.ok) {
    const data = Array.isArray(r.data) ? r.data : [];
    const rows = page === 'first' ? data : [...prev.rows, ...data.filter((d) => !prev.rows.some((p) => p.seq === d.seq))];
    return { rows, loaded: true, truncated: r.truncated === true, error: null, retry: false, unavailable: false, loadingMore: false };
  }
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'unavailable') return { ...NO_ACTIVITY, loaded: true, unavailable: true };
  if (r.code === 'not_found' || r.code === 'denied') return { ...NO_ACTIVITY, loaded: true, error: copy.text };
  // A passing failure: keep what was read and offer to try again.
  return { ...prev, loaded: true, error: copy.text, retry: copy.retry, unavailable: false, loadingMore: false };
}

/** The `beforeSeq` of the next older page; null when there is none to ask for. */
export function olderPageCursor(s: ActivityState): number | null {
  if (!s.truncated || s.rows.length === 0) return null;
  const seqs = s.rows.map((r) => r.seq).filter((n) => Number.isInteger(n) && n > 0);
  return seqs.length ? Math.min(...seqs) : null;
}

/** The one line the section shows instead of rows; null when rows are shown. */
export function activityNotice(s: ActivityState): { kind: 'loading' | 'empty' | 'error'; text: string; retry: boolean } | null {
  if (s.error && s.rows.length === 0) return { kind: 'error', text: s.error, retry: s.retry };
  if (!s.loaded) return { kind: 'loading', text: 'Reading activity…', retry: false };
  if (s.rows.length === 0 && !s.error) return { kind: 'empty', text: 'Nothing has been recorded for this project yet.', retry: false };
  return null;
}
