/**
 * `app.preview_health` v1 (application, candidate, blocking; the version's dev deployment). Pure over the
 * deployment's observed facts (re-validated): an HTTP 200 on the health path within 60 s of the start, the
 * container still running, and the forwarder bound to 127.0.0.1 only.
 */
import type { Evidence } from '../../../../shared/nexus/evidence';
import { checkHealthFacts, errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'app.preview_health';
export const VERSION = '1';
export const START_WINDOW_MS = 60_000;

export function run(facts: unknown): ValidatorOutcome {
  const c = checkHealthFacts(facts);
  if (!c.ok) return errored('parser_contract', 'Checks could not run: the deployment facts were not usable.');
  const f = c.value;
  const inWindow = f.probes.filter((p) => p.at - f.startedAt <= START_WINDOW_MS);
  const ok = inWindow.find((p) => p.status === 200);
  const last = ok ?? inWindow[inWindow.length - 1] ?? null;
  const ev: Evidence[] = [
    { type: 'http', method: 'GET', path: f.path, status: last ? last.status : null, ms: last ? last.ms : null },
    { type: 'inspect', field: 'container', value: f.container },
    { type: 'inspect', field: 'bindAddress', value: f.bindAddress }
  ];
  if (f.bindAddress !== '127.0.0.1') return failed('bound_elsewhere', 'The dev deployment is bound to an address other than 127.0.0.1.', ev);
  if (f.container !== 'running') return failed('container_exited', 'The app container is not running.', ev);
  if (!ok) return failed('no_health', `No 200 answer on ${f.path} within 60 s.`, ev);
  return passed(`The app answered 200 on ${f.path}.`, ev);
}
