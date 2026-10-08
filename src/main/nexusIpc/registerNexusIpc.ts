/**
 * The nexus:* IPC family: the one place a nexus:* channel is registered. main calls
 * registerNexusIpc once, at module top level, with Electron's IPC registrar; tests pass a fake one.
 *
 * Every channel runs through ONE wrapper, `handler(channel, parse, run)`:
 * 1. Platform check, read at call time (registration happens before whenReady, while
 *    the platform is still null): no platform -> platform_unavailable with the store's
 *    reason; a handoff channel while handoffs are off -> platform_unavailable, reason
 *    'handoffs_unavailable', with the v8 sub-reason.
 * 2. Validation through validate.ts (exact shapes, unknown keys refused).
 * 3. The principal: always the local user, resolved here from the store. Nothing
 *    identity-shaped is read from the arguments.
 * 4. One service call, mapped to a view (dto.ts). Authorization stays in the services;
 *    the write channels call the services (and UserSaves, built once per platform
 *    instance over the main source ports) and decide nothing themselves.
 * 5. Errors through envelope.ts. The wrapper never throws.
 *
 * This module lives outside src/main/nexus on purpose: the platform core never knows
 * about transport (the composition test bans Electron's IPC objects there).
 * B1 Task 6 registered the read channels; Task 7 the write channels (all 21).
 */
import type { Principal } from '../../shared/nexus/platform';
import type {
  HandoffsUnavailableSubReason, NexusOk, NexusResult, PlatformUnavailableReason
} from '../../shared/nexus/ipc';
import type { NexusPlatform } from '../nexus/platform';
import { MAX_LIST_LIMIT } from '../nexus/artifact/artifactService';
import { UserSaves, type SaveResult, type SourcePorts } from '../nexus/commands/userSaves';
import { PlatformError } from '../nexus/errors';
import { HANDOFF_STATUSES, MAX_SUBJECTS } from '../nexus/handoff/handoffRules';
import { MAX_LINK_SOURCES } from '../nexus/lineage/lineageService';
import { fail, ok, unavailable } from './envelope';
import { V } from './validate';
import {
  activityView, artifactView, edgeView, handoffDetailView, handoffSummaryView, lineageNodeView, participationView, summaryView,
  versionDetail, versionView
} from './dto';

/** All 21 nexus:* channels of B1, in the order of the IPC surface table. */
export const NEXUS_CHANNELS: readonly string[] = Object.freeze([
  'nexus:participations:list',
  'nexus:participation:attach',
  'nexus:participation:withdraw',
  'nexus:artifacts:list',
  'nexus:artifacts:byProject',
  'nexus:artifact:get',
  'nexus:version:get',
  'nexus:lineage:get',
  'nexus:artifact:saveCommit',
  'nexus:artifact:saveTextFile',
  'nexus:version:markReady',
  'nexus:version:promote',
  'nexus:version:discard',
  'nexus:version:linkSources',
  'nexus:handoffs:list',
  'nexus:handoff:get',
  'nexus:handoff:send',
  'nexus:handoff:accept',
  'nexus:handoff:decline',
  'nexus:handoff:withdraw',
  'nexus:activity:byProject'
]);

/** Channels 15-20: they also need the handoff service (schema v8). */
const HANDOFF_CHANNELS: ReadonlySet<string> = new Set([
  'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:handoff:send', 'nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw'
]);

/** List limits as the renderer may ask for them; a larger integer is clamped to the channel's maximum. */
export const ARTIFACTS_LIST_MAX = 500;
export const HANDOFFS_LIST_MAX = 500;
export const ACTIVITY_PAGE_MAX = 50;
const DEFAULT_LIST = 200;
/** The widest integer a limit may be before it is refused rather than clamped. */
const LIMIT_CEILING = 100000;

export interface IpcRegistrar { handle(channel: string, fn: (evt: unknown, ...args: unknown[]) => unknown): void }

export interface NexusIpcDeps {
  /** Read at call time: null until the platform started. */
  platform: () => NexusPlatform | null;
  /** Why the platform is unavailable (null once it is up). */
  unavailableReason: () => PlatformUnavailableReason | null;
  /** Why handoffs alone are off while the platform is up; the sub-reason of 'handoffs_unavailable'. */
  handoffsUnavailableReason?: () => HandoffsUnavailableSubReason | string | null;
  /** Main adapters for user saves (project folder, file read, commit resolve); used by the two save channels. */
  sources: SourcePorts;
  log: (line: string) => void;
}

type Run<A> = (nx: NexusPlatform, me: Principal, a: A) => NexusOk<unknown> | Promise<NexusOk<unknown>>;

/** A limit: undefined -> the default; an integer 1..LIMIT_CEILING -> clamped to `max`; anything else is refused. */
function limitOf(x: unknown, f: string, max: number, dflt: number): number {
  if (x === undefined) return Math.min(dflt, max);
  return Math.min(max, V.int(x, f, 1, LIMIT_CEILING));
}

/** An optional single object argument: undefined is an empty object. */
const optionalObject = <K extends string>(x: unknown, keys: readonly K[]): Record<K, unknown> =>
  V.object(x === undefined ? {} : x, keys, keys);

const saveView = (r: SaveResult) => ({ artifact: artifactView(r.artifact), version: versionView(r.version), created: r.created });

export function registerNexusIpc(registrar: IpcRegistrar, deps: NexusIpcDeps): void {
  // UserSaves is built lazily, once per platform instance (the platform object changes only across a restart).
  const savers = new WeakMap<NexusPlatform, UserSaves>();
  const userSaves = (nx: NexusPlatform): UserSaves => {
    let u = savers.get(nx);
    if (!u) { u = new UserSaves(nx, deps.sources); savers.set(nx, u); }
    return u;
  };
  const handler = <A>(channel: string, parse: (args: unknown[]) => A, run: Run<A>) => {
    const needsHandoffs = HANDOFF_CHANNELS.has(channel);
    return async (_evt: unknown, ...args: unknown[]): Promise<NexusResult<unknown>> => {
      try {
        const nx = deps.platform();
        if (!nx) return unavailable(deps.unavailableReason() ?? 'not_open');
        if (needsHandoffs && !nx.handoffs) return unavailable('handoffs_unavailable', deps.handoffsUnavailableReason?.() ?? null);
        const a = parse(args);
        const me = nx.principals.localUser();
        return await run(nx, me, a);
      } catch (e) {
        return fail(e, channel, deps.log);
      }
    };
  };
  const seen = new Set<string>();
  const reg = <A>(channel: string, parse: (args: unknown[]) => A, run: Run<A>): void => {
    if (!NEXUS_CHANNELS.includes(channel) || seen.has(channel)) throw new Error(`nexus ipc: unexpected channel ${channel}`);
    seen.add(channel);
    registrar.handle(channel, handler(channel, parse, run));
  };

  // #1 every participation of every project the user may read, every status.
  reg('nexus:participations:list', (args) => { V.arity(args, 0); },
    (nx, me) => ok(nx.workspaces.listForReader(me).map(participationView), false));

  // #2 attach the project to another workspace (non-primary; idempotent, a withdrawn row is re-activated).
  reg('nexus:participation:attach', (args) => {
    V.arity(args, 2);
    return { projectId: V.projectId(args[0]), workspaceId: V.workspaceId(args[1]) };
  }, (nx, me, q) => ok(participationView(nx.workspaces.attach(me, q.projectId, q.workspaceId))));

  // #3 withdraw a non-primary participation (refused while it has live work or open handoffs).
  reg('nexus:participation:withdraw', (args) => { V.arity(args, 1); return V.platformId(args[0], 'participationId'); },
    (nx, me, participationId) => ok(participationView(nx.workspaces.withdraw(me, participationId))));

  // #4 artifacts across projects, newest update first.
  reg('nexus:artifacts:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'workspaceId', 'kind', 'status', 'limit'] as const);
    return {
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId),
      workspaceId: o.workspaceId === undefined ? undefined : V.workspaceId(o.workspaceId),
      kind: o.kind === undefined ? undefined : V.artifactKind(o.kind, 'kind'),
      status: o.status === undefined ? undefined : V.enumOf(o.status, 'status', ['active', 'archived'] as const),
      limit: limitOf(o.limit, 'limit', ARTIFACTS_LIST_MAX, DEFAULT_LIST)
    };
  }, (nx, me, f) => {
    const filter: Record<string, unknown> = { limit: f.limit + 1 };
    if (f.projectId !== undefined) filter.projectId = f.projectId;
    if (f.workspaceId !== undefined) filter.workspaceId = f.workspaceId;
    if (f.kind !== undefined) filter.kind = f.kind;
    if (f.status !== undefined) filter.status = f.status;
    const rows = nx.artifacts.listForReader(me, filter);
    return ok(rows.slice(0, f.limit).map(summaryView), rows.length > f.limit);
  });

  // #5 every artifact of a project with its latest and current version, at most MAX_LIST_LIMIT. One more row is
  // asked for, so `truncated` is true only when more rows really exist.
  reg('nexus:artifacts:byProject', (args) => { V.arity(args, 1); return V.projectId(args[0]); }, (nx, me, projectId) => {
    const rows = nx.artifacts.summariesByProject(me, projectId, { limit: MAX_LIST_LIMIT + 1 });
    return ok(rows.slice(0, MAX_LIST_LIMIT).map(summaryView), rows.length > MAX_LIST_LIMIT);
  });

  // #6 one artifact with all its versions (no content).
  reg('nexus:artifact:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'artifactId'); }, (nx, me, artifactId) => {
    const artifact = nx.artifacts.get(me, artifactId);
    const versions = nx.artifacts.listVersions(me, artifact.id);
    return ok({ artifact: artifactView(artifact), versions: versions.map(versionView) });
  });

  // #7 one version with its content: the commit of a git version, the text of a text file.
  reg('nexus:version:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); }, (nx, me, versionId) => {
    const v = nx.artifacts.getVersion(me, versionId);
    const a = nx.artifacts.get(me, v.artifactId);
    return ok(versionDetail(a.kind, v));
  });

  // #8 lineage of a version, one direction, depth 1..6.
  reg('nexus:lineage:get', (args) => {
    V.arity(args, 2);
    const versionId = V.platformId(args[0], 'versionId');
    const o = V.object(args[1], ['direction', 'depth'] as const, ['depth'] as const);
    return {
      versionId,
      direction: V.enumOf(o.direction, 'direction', ['up', 'down'] as const),
      depth: o.depth === undefined ? undefined : V.int(o.depth, 'depth', 1, 6)
    };
  }, (nx, me, q) => {
    const opts = q.depth === undefined ? { depth: 6 } : { depth: q.depth };
    const walk = q.direction === 'up' ? nx.lineage.upstream(me, q.versionId, opts) : nx.lineage.downstream(me, q.versionId, opts);
    return ok({ nodes: walk.nodes.map(lineageNodeView), truncated: walk.truncated }, walk.truncated);
  });

  // #9 save a commit of the project repository as a git_commit version (new artifact or append), one transaction.
  reg('nexus:artifact:saveCommit', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'commit', 'target'] as const);
    return { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), commit: V.commit(o.commit), target: V.saveTarget(o.target) };
  }, async (nx, me, q) => ok(saveView(await userSaves(nx).saveCommit(me, q))));

  // #10 save a small text file of the project folder as a text_file version, one transaction.
  reg('nexus:artifact:saveTextFile', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'relPath', 'target'] as const);
    return { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), relPath: V.relPath(o.relPath), target: V.saveTarget(o.target) };
  }, async (nx, me, q) => ok(saveView(await userSaves(nx).saveTextFile(me, q))));

  // #11 mark a user draft ready (draft -> candidate, finalized by the system on the user's behalf).
  reg('nexus:version:markReady', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); },
    (nx, me, versionId) => ok(versionView(nx.artifacts.markReady(me, versionId))));

  // #12 promote a candidate, or roll back to a version that was active before; compare-and-set on the current pointer.
  reg('nexus:version:promote', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), expected: V.idOrNull(args[1], 'expectedCurrentVersionId') };
  }, (nx, me, q) => {
    const r = nx.artifacts.promote(me, q.versionId, q.expected);
    if (!r.ok) throw new PlatformError('conflict', 'the current version changed; reload and try again', { currentVersionId: r.currentVersionId });
    return ok(versionView(r.version));
  });

  // #13 discard a draft or a candidate.
  reg('nexus:version:discard', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); },
    (nx, me, versionId) => ok(versionView(nx.artifacts.discard(me, versionId))));

  // #14 record the versions a version was derived from (1 to 20, all or nothing).
  reg('nexus:version:linkSources', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), sources: V.idList(args[1], 'sourceVersionIds', MAX_LINK_SOURCES) };
  }, (nx, me, q) => {
    const r = nx.lineage.linkSources(me, q.versionId, q.sources);
    return ok({ edges: r.edges.map(edgeView), created: r.created });
  });

  // #15 handoffs the user may read: inbox, sent or all; open first, then newest.
  reg('nexus:handoffs:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'workspaceId', 'box', 'status', 'limit'] as const);
    return {
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId),
      workspaceId: o.workspaceId === undefined ? undefined : V.workspaceId(o.workspaceId),
      box: o.box === undefined ? undefined : V.enumOf(o.box, 'box', ['inbox', 'sent', 'all'] as const),
      status: o.status === undefined ? undefined : V.enumOf(o.status, 'status', HANDOFF_STATUSES),
      limit: limitOf(o.limit, 'limit', HANDOFFS_LIST_MAX, DEFAULT_LIST)
    };
  }, (nx, me, f) => {
    const filter: Record<string, unknown> = { limit: f.limit + 1 };
    if (f.projectId !== undefined) filter.projectId = f.projectId;
    if (f.workspaceId !== undefined) filter.workspaceId = f.workspaceId;
    if (f.box !== undefined) filter.box = f.box;
    if (f.status !== undefined) filter.status = f.status;
    const rows = nx.handoffs!.list(me, filter);
    return ok(rows.slice(0, f.limit).map(handoffSummaryView), rows.length > f.limit);
  });

  // #16 one handoff with its subjects.
  reg('nexus:handoff:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.get(me, handoffId))));

  // #17 send candidate or active versions from one participation to another of the same project.
  reg('nexus:handoff:send', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'fromParticipationId', 'toParticipationId', 'versionIds', 'title', 'note'] as const, ['note'] as const);
    const q = {
      projectId: V.projectId(o.projectId),
      fromParticipationId: V.platformId(o.fromParticipationId, 'fromParticipationId'),
      toParticipationId: V.platformId(o.toParticipationId, 'toParticipationId'),
      versionIds: V.idList(o.versionIds, 'versionIds', MAX_SUBJECTS),
      title: V.title(o.title, 'title')
    };
    const note = V.note(o.note);
    return note === undefined ? q : { ...q, note };
  }, (nx, me, q) => {
    const r = nx.handoffs!.send(me, q);
    return ok({ handoff: handoffDetailView(r.handoff), created: r.created });
  });

  // #18 accept: a receipt in the receiving participation that depends on each subject; one transaction.
  reg('nexus:handoff:accept', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.accept(me, handoffId))));

  // #19 decline, with an optional note.
  reg('nexus:handoff:decline', (args) => {
    V.arity(args, 2);
    return { handoffId: V.platformId(args[0], 'handoffId'), note: V.note(args[1]) };
  }, (nx, me, q) => ok(handoffDetailView(nx.handoffs!.decline(me, q.handoffId, q.note))));

  // #20 withdraw an unanswered handoff (the sender's side).
  reg('nexus:handoff:withdraw', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.withdraw(me, handoffId))));

  // #21 a project's activity, newest first, details reduced to an allow-list.
  reg('nexus:activity:byProject', (args) => {
    V.arity(args, 2);
    const projectId = V.projectId(args[0]);
    const o = optionalObject(args[1], ['beforeSeq', 'limit'] as const);
    return {
      projectId,
      beforeSeq: o.beforeSeq === undefined ? undefined : V.int(o.beforeSeq, 'beforeSeq', 1, Number.MAX_SAFE_INTEGER),
      limit: limitOf(o.limit, 'limit', ACTIVITY_PAGE_MAX, ACTIVITY_PAGE_MAX)
    };
  }, (nx, me, q) => {
    // The project must exist ('not_found') and be readable ('denied', audited) before its rows are listed.
    nx.projects.require(me, q.projectId, 'activity.read');
    const rows = nx.activity.list(me, { projectId: q.projectId, beforeSeq: q.beforeSeq, limit: q.limit + 1 });
    return ok(rows.slice(0, q.limit).map(activityView), rows.length > q.limit);
  });
}
