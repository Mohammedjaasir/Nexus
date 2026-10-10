/**
 * The domain registry's startup check in main (B2a Task 13). Two parts, both pure:
 * - checkRegistry(DOMAINS, B2A_IMPL): the registry's own soundness (src/shared/nexus/registryCheck.ts);
 * - implementationProblems: B2A_IMPL (what the registry says this build implements) against what main actually has
 *   registered: the recipes main can plan (planBuilder's engine branches and argv templates), the validators main can
 *   run (validationService's PURE_VALIDATORS plus the ones dispatched as a child job, a runner re-hash and a deployment
 *   probe) and the ingest rules (ingest.ts INGEST_RULES, with NOT_INGESTED naming each implemented recipe whose outputs
 *   are never ingested and why).
 * The platform runs `registryProblems()` at startup; any problem keeps execution off (`registry_invalid`) and the
 * execution channels answer an availability envelope saying so. Nothing throws.
 */
import { DOMAINS } from '../../shared/nexus/domains/index';
import { B2A_IMPL, checkRegistry, type RegistryImpl } from '../../shared/nexus/registryCheck';
import { RECIPES } from '../../shared/nexus/recipes';
import { plannedRecipeIds } from './exec/planBuilder';
import { INGEST_RECORDED_VALIDATORS, INGEST_RULES, NOT_INGESTED } from './exec/ingest';
import { PURE_VALIDATORS } from './validation/validationService';
import { RUNNER_VALIDATORS } from './validation/checkRunner';
import { DEPLOYMENT_VALIDATORS } from './deployments/deploymentService';

/**
 * The validators main executes outside `runPure`, derived from the dispatch tables themselves (fix round 1: never a
 * hand-kept list): the results an ingest rule records (a child test job's `sde.tests_pass`), the runner's re-hashes
 * (CheckRunner dispatches through RUNNER_VALIDATORS) and a dev deployment's health check (DEPLOYMENT_VALIDATORS).
 */
export const DISPATCHED_VALIDATORS: readonly string[] = Object.freeze([
  ...Object.keys(INGEST_RECORDED_VALIDATORS), ...RUNNER_VALIDATORS, ...DEPLOYMENT_VALIDATORS
]);

/** What main has actually registered, by kind. */
export function mainImplementation(): { recipes: string[]; validators: string[]; ingest: string[]; notIngested: string[] } {
  return {
    recipes: plannedRecipeIds(RECIPES),
    validators: [...Object.keys(PURE_VALIDATORS), ...DISPATCHED_VALIDATORS],
    ingest: Object.keys(INGEST_RULES),
    notIngested: Object.keys(NOT_INGESTED)
  };
}

const diff = (what: string, declared: readonly string[], actual: readonly string[]): string[] => {
  const a = new Set(actual); const d = new Set(declared);
  return [...declared.filter((x) => !a.has(x)).map((x) => `${what}: ${x} is declared implemented but main has none`),
    ...actual.filter((x) => !d.has(x)).map((x) => `${what}: main has ${x} but the registry does not declare it`)];
};

/** B2A_IMPL against main's registered maps; empty when they agree exactly. Never throws. */
export function implementationProblems(impl: RegistryImpl = B2A_IMPL): string[] {
  try {
    const m = mainImplementation();
    const out = [...diff('recipe', impl.recipes, m.recipes), ...diff('validator', impl.validators, m.validators)];
    // Every implemented recipe is either ingested or named as never ingested (with why), never both.
    const both = m.ingest.filter((x) => m.notIngested.includes(x));
    for (const x of both) out.push(`ingest: ${x} is both ingested and listed as never ingested`);
    out.push(...diff('ingest', impl.recipes, [...m.ingest, ...m.notIngested]));
    return out;
  } catch (e) {
    return [`implementation check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`];
  }
}

let cached: string[] | null = null;
/** The startup check: the registry's soundness and its agreement with main. The registry is static, so it runs once. */
export function registryProblems(): string[] {
  if (cached === null) {
    try { cached = [...checkRegistry(DOMAINS, B2A_IMPL), ...implementationProblems()]; } catch (e) {
      cached = [`registry check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`];
    }
  }
  return [...cached];
}
