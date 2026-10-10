// Pure: a domain's lifecycle as a rail, in the domain's own words, from the
// registry (DomainSpecView, #22; the same registry is bundled with this build) and,
// inside a project, from records only: versions with their check results, live
// jobs and dev deployments. A step state comes from shared/nexus/stepState.ts;
// nothing is ticked by hand, a FUTURE step is never offered, and no domain is
// ever called complete.
import type { DomainSpecView, JobView } from '@shared/nexus/ipc';
import type { DomainSpec, StepStatus, SubPhase } from '@shared/nexus/domainSpec';
import { CURRENT_SUB_PHASE, isAtOrBefore, isExecutableEndToEnd } from '@shared/nexus/domainSpec';
import { DOMAINS, getDomain } from '@shared/nexus/domains';
import { stepStateFrom, type StepState } from '@shared/nexus/stepState';

/** The same projection main sends over #22 (nexusIpc/dto.ts domainView), for when that channel has not answered. */
export function domainViewOf(d: DomainSpec): DomainSpecView {
  const vocabulary: DomainSpecView['vocabulary'] = {};
  for (const [k, v] of Object.entries(d.vocabulary)) if (v) vocabulary[k] = { singular: v.singular, plural: v.plural };
  return {
    id: d.id, label: d.label, shortLabel: d.shortLabel, description: d.description, tier: d.tier, hueSlot: d.hueSlot, icon: d.icon, order: d.order,
    statusNote: d.statusNote, vocabulary,
    lifecycle: d.lifecycle.map((s) => ({
      id: s.id, label: s.label, status: s.status, scopeNote: s.scopeNote ?? null, subPhase: s.subPhase,
      delivered: s.status !== 'FUTURE' && isAtOrBefore(s.subPhase),
      consumes: [...s.consumes], produces: [...s.produces], prerequisites: [...s.prerequisites],
      actions: s.via.flatMap((v) => ('userAction' in v ? [v.userAction] : []))
    })),
    modules: d.modules.map((m) => ({ id: m.id, label: m.label, kinds: [...m.kinds], subPhase: m.subPhase })),
    availableFromSubPhase: d.participationFromSubPhase, currentSubPhase: CURRENT_SUB_PHASE, executableEndToEnd: isExecutableEndToEnd(d)
  };
}

export const bundledDomainViews = (): DomainSpecView[] => DOMAINS.map(domainViewOf);

/** What a later sub-phase brings, in plain words (the FUTURE line: "Not in this release: arrives with ..."). */
export const ARRIVES_WITH: Readonly<Record<SubPhase, string>> = Object.freeze({
  B1: 'the platform', B2a: 'execution', B2b: 'AI-assisted changes', B2c: 'QA workflows (B2c)', B3: 'Data Analyst workflows (B3)',
  B4: 'Data Scientist workflows (B4)', B5: 'ML Engineer workflows (B5)', B6: 'DL Engineer workflows (B6)'
});
export const futureLine = (sub: SubPhase): string => `Not in this release: arrives with ${ARRIVES_WITH[sub] ?? sub}`;
export const NOT_SUPPORTED = 'Not yet a supported workflow';

const STATE_WORD: Record<StepState, string> = {
  unavailable: 'Not in this release', blocked: 'Needs an earlier step', ready: 'Ready to start', in_progress: 'In progress', done: 'Done', failed: 'Needs attention'
};
const STATUS_WORD: Record<StepStatus, string> = { REAL: 'In this release', PARTIAL: 'In this release, with limits', FUTURE: 'Not in this release' };

/** Records of one project in one domain. Versions are the shown versions of the project's artifacts. */
export interface RailRecords {
  versions: { kind: string; status: 'draft' | 'candidate' | 'active' | 'failed' | 'deprecated'; validators: Readonly<Record<string, 'passed' | 'failed' | 'error' | 'skipped'>> }[];
  /** Action ids of this project's live jobs (queued, leased, running, awaiting approval, retry scheduled). */
  liveActions: readonly string[];
  participation: boolean;
  deploymentHealthy: boolean;
}

export interface RailStep {
  id: string; label: string; status: StepStatus; subPhase: SubPhase; future: boolean;
  /** Derived from records inside a project; null on a workspace page (no project, so no state). */
  state: StepState | null;
  /** Always a word: the state's, or the step's status in this release. */
  word: string;
  /** For a FUTURE step "Not in this release: arrives with ..."; otherwise the registry's scope note. */
  note: string | null;
}

export interface RailView {
  domainId: string; label: string;
  /** The registry's own sentence on what works in this release. */
  statusNote: string;
  /** Set when a project cannot take part yet (DS before B4), or the domain is registry-only. */
  availability: string | null;
  supported: boolean;
  steps: RailStep[];
  /** The domain's modules in its words: delivered now, or the sub-phase they arrive in. */
  modules: { id: string; label: string; delivered: boolean; note: string | null }[];
}

const LIVE = new Set(['queued', 'leased', 'running', 'awaiting_approval', 'retry_scheduled']);
export const liveActionsOf = (jobs: readonly Pick<JobView, 'state' | 'actionId'>[]): string[] =>
  jobs.filter((j) => LIVE.has(j.state) && j.actionId).map((j) => j.actionId!) ;

/** The rail of one domain; `records` only inside a project (null: no state is claimed). */
export function railFor(view: DomainSpecView, records: RailRecords | null = null): RailView {
  const spec = getDomain(view.id);
  const supported = view.tier === 'first-class' && view.lifecycle.length > 0;
  const availability = !supported ? NOT_SUPPORTED
    : !isAtOrBefore(view.availableFromSubPhase, view.currentSubPhase) ? `Available from ${view.availableFromSubPhase}; it cannot be added to a project yet` : null;
  const steps: RailStep[] = view.lifecycle.map((s) => {
    const future = s.status === 'FUTURE' || !isAtOrBefore(s.subPhase, view.currentSubPhase);
    const full = spec?.lifecycle.find((x) => x.id === s.id) ?? null;
    let state: StepState | null = null;
    if (records && full && availability === null) {
      const done = full.doneWhen;
      state = stepStateFrom(full, {
        versions: 'kind' in done ? records.versions.filter((v) => v.kind === done.kind).map((v) => ({ status: v.status, validators: v.validators })) : [],
        liveJobs: records.liveActions.filter((a) => s.actions.includes(a)).length,
        inputsAvailable: s.consumes.every((k) => records.versions.some((v) => v.kind === k && (v.status === 'candidate' || v.status === 'active'))),
        recordPresent: 'record' in done ? (done.record === 'participation' ? records.participation : done.record === 'deployment_healthy' ? records.deploymentHealthy : false) : undefined
      }, view.currentSubPhase);
    }
    return {
      id: s.id, label: s.label, status: s.status, subPhase: s.subPhase, future, state,
      word: future ? STATUS_WORD.FUTURE : state ? STATE_WORD[state] : STATUS_WORD[s.status],
      note: future ? futureLine(s.subPhase) : s.scopeNote
    };
  });
  const modules = view.modules.map((m) => {
    const delivered = isAtOrBefore(m.subPhase, view.currentSubPhase) && availability === null;
    return { id: m.id, label: m.label, delivered, note: delivered ? null : `arrives in ${m.subPhase}` };
  });
  return { domainId: view.id, label: view.label, statusNote: view.statusNote, availability, supported, steps, modules };
}

/** The compact line under a Spine group: counts of the rail's own steps (no other number). */
export function railSummary(r: RailView): string {
  if (r.availability) return r.availability;
  const inRelease = r.steps.filter((s) => !s.future);
  const done = inRelease.filter((s) => s.state === 'done').length;
  const later = r.steps.length - inRelease.length;
  const parts = [`${done} of ${inRelease.length} steps in this release done`];
  if (later > 0) parts.push(`${later} not in this release`);
  return parts.join('; ');
}
