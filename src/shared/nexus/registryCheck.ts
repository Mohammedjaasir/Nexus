// Boot checks for the domain registry (§12.9) and its projections. Pure: the
// caller passes the specs and the ids this build implements, and gets back a
// list of problems (empty = sound). Main runs it at startup and refuses to serve
// a registry with problems; the unit test runs it on every change.

import {
  CURRENT_SUB_PHASE, HANDOFF_ACTIONS, STEP_STATUSES, isAtOrBefore, isSubPhase,
  type DomainSpec, type LifecycleStep, type ParamsSchema, type SubPhase
} from './domainSpec';
import { KINDS } from './kinds';
import { CAPABILITY_IDS, SKILLS } from './capabilities';
import { RECIPES } from './recipes';
import { VALIDATORS, blockingValidatorsFor } from './validators';
import { PLATFORM_FLOWS, USER_ACTIONS, type UserActionDef } from './actions';
import { SANDBOX_PROFILE_IDS } from './execution';

/** The ids this build has real implementations for. `e2eTests: null` checks the e2e id format only. */
export interface RegistryImpl {
  recipes: readonly string[];
  validators: readonly string[];
  viewers: readonly string[];
  e2eTests: readonly string[] | null;
}

/** What B2a implements (main's recipe runners, validators and the Folio viewers are pinned to these by later tasks). */
export const B2A_IMPL: RegistryImpl = Object.freeze({
  recipes: Object.freeze(['repo.snapshot', 'sde.deps.node', 'sde.deps.python', 'sde.test.discover', 'sde.test.node', 'sde.test.pytest',
    'sde.build.node', 'sde.build.python', 'sde.app.assemble', 'sde.preview.start', 'sde.diagnose']),
  validators: Object.freeze(['git.head_resolves', 'req.schema', 'problem.schema', 'suite.discovered', 'sde.tests_pass', 'build.exit_zero',
    'build.manifest_present', 'build.output_hashed', 'blob.integrity', 'app.manifest_schema', 'app.preview_health', 'diag.schema']),
  viewers: Object.freeze(['viewer.git_commit', 'viewer.text_file', 'viewer.handoff_receipt', 'viewer.repository', 'viewer.requirement',
    'viewer.problem_statement', 'viewer.test_suite', 'viewer.build', 'viewer.application', 'viewer.diagnostic_report']),
  e2eTests: null
});

/** An end-to-end test id: `e2e.<domain>.<step>`. */
export const E2E_TEST_ID_RE = /^e2e\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
/** A renderer-supplied parameter never names a path, a command, a network, an image or an identity. */
export const BANNED_PARAM_FIELD =
  /path|dir|file|folder|root|command|cmd|argv|exec|script|shell|network|egress|port|host|url|image|principal|user|actor|role|token|secret|env/i;

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** Problems with one action's parameter schema. */
export function checkActionParams(action: Pick<UserActionDef, 'id' | 'params'>): string[] {
  return checkParams(`action ${action.id}`, action.params);
}

function checkParams(where: string, p: ParamsSchema): string[] {
  const out: string[] = [];
  if (!p || p.type !== 'object' || p.additionalProperties !== false) out.push(`${where}: params must be a closed object schema`);
  const props = p?.properties ?? {};
  for (const [field, def] of Object.entries(props)) {
    if (BANNED_PARAM_FIELD.test(field)) out.push(`${where}: params field ${field} names a path, command, network, image or identity`);
    if (def.type === 'string' && !(Number.isInteger(def.maxLength) && def.maxLength > 0))
      out.push(`${where}: params field ${field} needs a maxLength`);
  }
  for (const r of p?.required ?? []) if (!(r in props)) out.push(`${where}: required field ${r} is not declared`);
  return out;
}

export function checkRegistry(specs: readonly DomainSpec[], impl: RegistryImpl): string[] {
  const out: string[] = [];
  const kinds = new Map(KINDS.map((k) => [k.id, k]));
  const recipes = new Map(RECIPES.map((r) => [r.id, r]));
  const validators = new Map(VALIDATORS.map((v) => [v.id, v]));
  const actions = new Map(USER_ACTIONS.map((a) => [a.id, a]));
  const capabilities = new Set(CAPABILITY_IDS);
  const skills = new Set(SKILLS.map((s) => s.id));
  const flows = new Set(PLATFORM_FLOWS);
  const domains = new Map<string, DomainSpec>();
  const kind = (where: string, id: string) => { if (!kinds.has(id)) out.push(`${where}: unknown kind ${id}`); };

  // ----- the tables themselves, and the implementation ids the build claims -----
  for (const r of RECIPES) {
    for (const k of r.produces) kind(`recipe ${r.id}`, k);
    for (const p of r.profiles) if (!SANDBOX_PROFILE_IDS.includes(p)) out.push(`recipe ${r.id}: unknown profile ${p}`);
    if ((r.executor === 'engine') !== (r.network === 'not-applicable')) out.push(`recipe ${r.id}: network does not fit its executor`);
    out.push(...checkParams(`recipe ${r.id}`, r.params));
  }
  for (const v of VALIDATORS) {
    for (const k of v.kinds) kind(`validator ${v.id}`, k);
    for (const r of v.recipes ?? []) if (!recipes.has(r)) out.push(`validator ${v.id}: unknown recipe ${r}`);
  }
  for (const a of USER_ACTIONS) {
    out.push(...checkActionParams(a));
    for (const s of a.inputs) for (const k of s.kinds) kind(`action ${a.id}`, k);
    if ('recipes' in a.run) for (const r of a.run.recipes) if (!recipes.has(r)) out.push(`action ${a.id}: unknown recipe ${r}`);
    if ('inlineKind' in a.run) {
      kind(`action ${a.id}`, a.run.inlineKind);
      if (!kinds.get(a.run.inlineKind)?.userAuthorable) out.push(`action ${a.id}: ${a.run.inlineKind} is not user-authorable`);
    }
  }
  for (const r of impl.recipes) if (!recipes.has(r)) out.push(`implementation: unknown recipe ${r}`);
  for (const v of impl.validators) if (!validators.has(v)) out.push(`implementation: unknown validator ${v}`);

  // ----- each spec -----
  const hues = new Map<number, string>();
  const orders = new Map<number, string>();
  const legacy = new Map<string, string>();
  for (const d of specs) {
    const w = d?.id ?? '?';
    if (d.specVersion !== 3) out.push(`${w}: specVersion must be 3`);
    if (!ID_RE.test(d.id ?? '')) out.push(`${w}: bad id`);
    if (domains.has(d.id)) out.push(`${w}: duplicate domain id`);
    domains.set(d.id, d);
    if (!Number.isInteger(d.hueSlot) || d.hueSlot < 0) out.push(`${w}: bad hue slot`);
    else if (hues.has(d.hueSlot)) out.push(`${w}: hue slot ${d.hueSlot} already used by ${hues.get(d.hueSlot)}`);
    else hues.set(d.hueSlot, d.id);
    if (orders.has(d.order)) out.push(`${w}: order ${d.order} already used by ${orders.get(d.order)}`);
    else orders.set(d.order, d.id);
    if (!isSubPhase(d.availableFromSubPhase)) out.push(`${w}: bad availableFromSubPhase`);
    if (!d.label || !d.shortLabel || !d.statusNote) out.push(`${w}: label, shortLabel and statusNote are required`);
    for (const l of d.legacyDomainIds) {
      if (legacy.has(l)) out.push(`${w}: legacy domain ${l} already maps to ${legacy.get(l)}`);
      else legacy.set(l, d.id);
    }
  }

  for (const d of specs) {
    const w = d.id;
    if (d.tier === 'registry-only') {
      const extra = (['lifecycle', 'modules', 'actions', 'recipes', 'skills', 'capabilities', 'kindsProduced', 'kindsAccepted',
        'handoffRoutes', 'completionRules'] as const).filter((f) => d[f].length > 0);
      if (extra.length) out.push(`${w}: a registry-only entry has no ${extra.join(', ')}`);
      continue;
    }
    if (d.tier !== 'first-class') { out.push(`${w}: bad tier`); continue; }

    for (const k of [...d.kindsProduced, ...d.kindsAccepted]) kind(w, k);
    for (const k of Object.keys(d.vocabulary)) kind(`${w} vocabulary`, k);
    for (const k of d.kindsProduced) if (!d.vocabulary[k]) out.push(`${w}: vocabulary does not name produced kind ${k}`);
    for (const c of d.capabilities) {
      if (!capabilities.has(c.id)) out.push(`${w}: unknown capability ${c.id}`);
      for (const r of c.scope?.recipes ?? []) if (!recipes.has(r)) out.push(`${w}: capability ${c.id}: unknown recipe ${r}`);
      for (const k of c.scope?.kinds ?? []) kind(`${w} capability ${c.id}`, k);
    }
    for (const r of d.recipes) if (!recipes.has(r)) out.push(`${w}: unknown recipe ${r}`);
    for (const s of d.skills) if (!skills.has(s)) out.push(`${w}: unknown skill ${s}`);
    for (const id of d.actions) {
      const a = actions.get(id);
      if (!a) { out.push(`${w}: unknown action ${id}`); continue; }
      if (a.domain !== d.id) out.push(`${w}: action ${id} belongs to ${a.domain}`);
      if ('recipes' in a.run) for (const r of a.run.recipes) if (!d.recipes.includes(r)) out.push(`${w}: action ${id} runs ${r}, not in its recipes`);
      if ('inlineKind' in a.run && !d.kindsProduced.includes(a.run.inlineKind)) out.push(`${w}: action ${id} saves a kind it does not produce`);
    }
    for (const a of USER_ACTIONS) if (a.domain === d.id && !d.actions.includes(a.id)) out.push(`${w}: action ${a.id} is not listed`);

    // lifecycle
    const stepIds = new Set<string>();
    const realActions = new Set<string>();
    for (const s of d.lifecycle) {
      const sw = `${w}/${s.id}`;
      if (!ID_RE.test(s.id) || stepIds.has(s.id)) out.push(`${sw}: bad or duplicate step id`);
      stepIds.add(s.id);
      if (!s.label) out.push(`${sw}: label is required`);
      if (!STEP_STATUSES.includes(s.status)) out.push(`${sw}: bad status`);
      if (!isSubPhase(s.subPhase)) { out.push(`${sw}: bad subPhase`); continue; }
      for (const k of [...s.consumes, ...s.produces]) kind(sw, k);
      for (const k of s.produces) if (!d.kindsProduced.includes(k)) out.push(`${sw}: produces ${k}, which is missing from kindsProduced`);
      out.push(...checkVia(sw, s, recipes, actions, skills, flows, d));
      out.push(...checkDoneWhen(sw, s, kinds, validators));
      if (s.status === 'FUTURE') {
        if (isAtOrBefore(s.subPhase)) out.push(`${sw}: FUTURE but names ${s.subPhase}, which this build (${CURRENT_SUB_PHASE}) has reached`);
        if (s.via.some((v) => 'userAction' in v)) out.push(`${sw}: a FUTURE step has no user action`);
        continue;
      }
      // REAL or PARTIAL in this build.
      if (!isAtOrBefore(s.subPhase)) out.push(`${sw}: ${s.status} but its sub-phase ${s.subPhase} is after this build (${CURRENT_SUB_PHASE})`);
      if (s.status === 'PARTIAL' && !s.scopeNote) out.push(`${sw}: PARTIAL needs a scopeNote`);
      if (!s.e2eTestId || !E2E_TEST_ID_RE.test(s.e2eTestId)) out.push(`${sw}: e2eTestId missing or malformed`);
      else if (impl.e2eTests && !impl.e2eTests.includes(s.e2eTestId)) out.push(`${sw}: no end-to-end test titled ${s.e2eTestId}`);
      if (s.via.length === 0) out.push(`${sw}: a ${s.status} step names how it runs`);
      for (const k of s.produces) {
        const def = kinds.get(k);
        if (def && !isAtOrBefore(def.availableFrom)) out.push(`${sw}: produces ${k}, which arrives in ${def.availableFrom}`);
        if (def && !impl.viewers.includes(def.viewer)) out.push(`${sw}: no viewer implementation ${def.viewer} for ${k}`);
      }
      for (const v of s.via) {
        if ('recipe' in v && !impl.recipes.includes(v.recipe)) out.push(`${sw}: recipe ${v.recipe} has no implementation`);
        if ('userAction' in v) {
          realActions.add(v.userAction);
          const a = actions.get(v.userAction);
          if (a && 'recipes' in a.run) for (const r of a.run.recipes)
            if (!impl.recipes.includes(r)) out.push(`${sw}: recipe ${r} has no implementation`);
          if (a && !isAtOrBefore(a.subPhase)) out.push(`${sw}: action ${a.id} arrives in ${a.subPhase}`);
        }
      }
      if ('validators' in s.doneWhen) for (const v of s.doneWhen.validators)
        if (!impl.validators.includes(v)) out.push(`${sw}: validator ${v} has no implementation`);
    }
    for (const id of d.actions) if (!realActions.has(id)) out.push(`${w}: action ${id} is not offered by a REAL or PARTIAL step`);

    // handoff routes
    for (const r of d.handoffRoutes) {
      const rw = `${w} route to ${r.to}`;
      const to = specs.find((x) => x.id === r.to);
      if (!to || to.tier !== 'first-class') { out.push(`${rw}: unknown receiver ${r.to}`); continue; }
      if (!HANDOFF_ACTIONS.includes(r.action)) out.push(`${rw}: bad action ${r.action}`);
      if (!isSubPhase(r.subPhase)) out.push(`${rw}: bad subPhase`);
      for (const k of r.kinds) {
        kind(rw, k);
        if (!d.kindsProduced.includes(k)) out.push(`${rw}: ${w} does not produce ${k}`);
        if (!to.kindsAccepted.includes(k)) out.push(`${rw}: ${r.to} does not accept ${k}`);
      }
    }
    // completion rules: never a claim the build cannot back
    for (const c of d.completionRules) {
      if (!isSubPhase(c.subPhase)) { out.push(`${w} completion ${c.id}: bad subPhase`); continue; }
      for (const id of c.steps) if (!stepIds.has(id)) out.push(`${w} completion ${c.id}: unknown step ${id}`);
      if (isAtOrBefore(c.subPhase)) {
        const open = c.steps.filter((id) => d.lifecycle.find((s) => s.id === id)?.status === 'FUTURE');
        if (open.length) out.push(`${w} completion ${c.id}: names ${c.subPhase} while ${open.join(', ')} are FUTURE`);
      }
    }
    // modules
    const moduleIds = new Set<string>();
    for (const m of d.modules) {
      if (!ID_RE.test(m.id) || moduleIds.has(m.id)) out.push(`${w} module ${m.id}: bad or duplicate id`);
      moduleIds.add(m.id);
      if (!isSubPhase(m.subPhase)) out.push(`${w} module ${m.id}: bad subPhase`);
      for (const k of m.kinds) kind(`${w} module ${m.id}`, k);
    }
  }
  return out;
}

function checkVia(sw: string, s: LifecycleStep, recipes: Map<string, unknown>, actions: Map<string, UserActionDef>,
  skills: Set<string>, flows: Set<string>, d: DomainSpec): string[] {
  const out: string[] = [];
  for (const v of s.via) {
    if ('userAction' in v) {
      if (!actions.has(v.userAction)) out.push(`${sw}: unknown action ${v.userAction}`);
      else if (!d.actions.includes(v.userAction)) out.push(`${sw}: action ${v.userAction} is not listed by ${d.id}`);
    } else if ('recipe' in v) {
      if (!recipes.has(v.recipe)) out.push(`${sw}: unknown recipe ${v.recipe}`);
      else if (!d.recipes.includes(v.recipe)) out.push(`${sw}: recipe ${v.recipe} is not listed by ${d.id}`);
    } else if ('skill' in v) {
      if (!skills.has(v.skill)) out.push(`${sw}: unknown skill ${v.skill}`);
    } else if ('platform' in v) {
      if (!flows.has(v.platform)) out.push(`${sw}: unknown platform flow ${v.platform}`);
    } else out.push(`${sw}: bad via entry`);
  }
  return out;
}

function checkDoneWhen(sw: string, s: LifecycleStep, kinds: Map<string, unknown>,
  validators: Map<string, { kinds: string[]; blocking: boolean }>): string[] {
  const out: string[] = [];
  const dw = s.doneWhen;
  if ('record' in dw) return out;
  if (!kinds.has(dw.kind)) { out.push(`${sw}: doneWhen names unknown kind ${dw.kind}`); return out; }
  if (!s.produces.includes(dw.kind)) out.push(`${sw}: doneWhen kind ${dw.kind} is not produced by the step`);
  if (dw.statuses.length === 0) out.push(`${sw}: doneWhen needs a status`);
  for (const v of dw.validators) {
    const def = validators.get(v);
    if (!def) out.push(`${sw}: doneWhen names unknown validator ${v}`);
    else if (!def.kinds.includes(dw.kind)) out.push(`${sw}: validator ${v} does not apply to ${dw.kind}`);
  }
  // A step that runs in this build cannot be done while a blocking check of its kind is skipped.
  if (s.status !== 'FUTURE') for (const v of blockingValidatorsFor(dw.kind))
    if (!dw.validators.includes(v.id)) out.push(`${sw}: doneWhen omits the blocking validator ${v.id}`);
  return out;
}

/** The live workspace catalogue: the ids of every domain available in this build, in display order, and the legacy map. */
export function projectWorkspaceCatalog(specs: readonly DomainSpec[], at: SubPhase = CURRENT_SUB_PHASE):
  { ids: string[]; legacyMap: Record<string, string> } {
  const live = specs.filter((d) => isAtOrBefore(d.availableFromSubPhase, at)).slice().sort((a, b) => a.order - b.order);
  const legacyMap: Record<string, string> = {};
  for (const d of live) for (const l of d.legacyDomainIds) legacyMap[l] = d.id;
  return { ids: live.map((d) => d.id), legacyMap };
}
