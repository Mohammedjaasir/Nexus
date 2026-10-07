// The one place the renderer calls the nexus:* preload methods. Every call answers
// a NexusResult; a rejected invoke or a malformed answer becomes
// { ok: false, code: 'internal' }, so callers never need a try/catch. No React.
import type {
  ActivityPage, ActivityView, ArtifactDetail, ArtifactSummaryView, ArtifactsListFilter, HandoffDetailView, HandoffSummaryView,
  HandoffsListFilter, LineageQuery, LineageView, LinkSourcesView, NexusFail, NexusResult, ParticipationView, SaveCommitArgs,
  SaveResultView, SaveTextFileArgs, SendHandoffArgs, SendHandoffView, VersionDetail, VersionView
} from '@shared/nexus/ipc';

const INTERNAL: NexusFail = { ok: false, code: 'internal', message: 'The request could not be completed.' };

async function call<T>(run: () => Promise<NexusResult<T>>): Promise<NexusResult<T>> {
  try {
    const r = await run();
    if (r && typeof r === 'object' && (r.ok === true || (r.ok === false && typeof r.code === 'string'))) return r;
    return INTERNAL;
  } catch {
    return INTERNAL;
  }
}

export const nexusClient = {
  participationsList: (): Promise<NexusResult<ParticipationView[]>> => call(() => window.cth.nexusParticipationsList()),
  participationAttach: (projectId: string, workspaceId: string): Promise<NexusResult<ParticipationView>> =>
    call(() => window.cth.nexusParticipationAttach(projectId, workspaceId)),
  participationWithdraw: (participationId: string): Promise<NexusResult<ParticipationView>> =>
    call(() => window.cth.nexusParticipationWithdraw(participationId)),
  artifactsList: (filter?: ArtifactsListFilter): Promise<NexusResult<ArtifactSummaryView[]>> => call(() => window.cth.nexusArtifactsList(filter)),
  artifactsByProject: (projectId: string): Promise<NexusResult<ArtifactSummaryView[]>> => call(() => window.cth.nexusArtifactsByProject(projectId)),
  artifactGet: (artifactId: string): Promise<NexusResult<ArtifactDetail>> => call(() => window.cth.nexusArtifactGet(artifactId)),
  versionGet: (versionId: string): Promise<NexusResult<VersionDetail>> => call(() => window.cth.nexusVersionGet(versionId)),
  lineageGet: (versionId: string, query: LineageQuery): Promise<NexusResult<LineageView>> => call(() => window.cth.nexusLineageGet(versionId, query)),
  artifactSaveCommit: (args: SaveCommitArgs): Promise<NexusResult<SaveResultView>> => call(() => window.cth.nexusArtifactSaveCommit(args)),
  artifactSaveTextFile: (args: SaveTextFileArgs): Promise<NexusResult<SaveResultView>> => call(() => window.cth.nexusArtifactSaveTextFile(args)),
  versionMarkReady: (versionId: string): Promise<NexusResult<VersionView>> => call(() => window.cth.nexusVersionMarkReady(versionId)),
  versionPromote: (versionId: string, expectedCurrentVersionId: string | null): Promise<NexusResult<VersionView>> =>
    call(() => window.cth.nexusVersionPromote(versionId, expectedCurrentVersionId)),
  versionDiscard: (versionId: string): Promise<NexusResult<VersionView>> => call(() => window.cth.nexusVersionDiscard(versionId)),
  versionLinkSources: (versionId: string, sourceVersionIds: string[]): Promise<NexusResult<LinkSourcesView>> =>
    call(() => window.cth.nexusVersionLinkSources(versionId, sourceVersionIds)),
  handoffsList: (filter?: HandoffsListFilter): Promise<NexusResult<HandoffSummaryView[]>> => call(() => window.cth.nexusHandoffsList(filter)),
  handoffGet: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffGet(handoffId)),
  handoffSend: (args: SendHandoffArgs): Promise<NexusResult<SendHandoffView>> => call(() => window.cth.nexusHandoffSend(args)),
  handoffAccept: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffAccept(handoffId)),
  handoffDecline: (handoffId: string, note?: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffDecline(handoffId, note)),
  handoffWithdraw: (handoffId: string): Promise<NexusResult<HandoffDetailView>> => call(() => window.cth.nexusHandoffWithdraw(handoffId)),
  activityByProject: (projectId: string, page?: ActivityPage): Promise<NexusResult<ActivityView[]>> =>
    call(() => window.cth.nexusActivityByProject(projectId, page))
};

export type NexusClient = typeof nexusClient;
