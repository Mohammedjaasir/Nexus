/**
 * The port between the execution core (main) and the runner utilityProcess. Main sends
 * `MainToRunner` messages; everything the runner sends back arrives as `unknown` and is
 * validated by `parseRunnerMessage` and then against main's own state before it touches
 * the database (ExecutionService.onRunnerMessage). The real port (a MessagePort to the
 * runner, supervised) is Task 11; tests use test/helpers/fakeRunner.cjs.
 *
 * Rules for an implementation:
 * - `send` never blocks and never throws for a busy runner; a dead runner may throw, and
 *   main treats that as "not sent" (the attempt's lease then expires; recovery decides).
 * - `onMessage` delivers each message once, in order, and returns an unsubscribe function.
 * - `state()` is a cached value; it never waits on the runner or on Docker.
 */
import type { MainToRunner } from '../../../shared/nexus/runnerProtocol';

export type RunnerPortState = 'starting' | 'ready' | 'unavailable' | 'crashed';

export interface RunnerPort {
  state(): RunnerPortState;
  send(msg: MainToRunner): void;
  onMessage(fn: (raw: unknown) => void): () => void;
}

/**
 * The runner reports a failure of `docker create` for one attempt as a `fault` whose message
 * starts with `attempt <attemptId> create failed: ` followed by Docker's own text. Main reads
 * the attempt id and classifies the text (`classifyCreateFault`); a fault in any other form is
 * logged and counted, never attributed to an attempt.
 */
export const ATTEMPT_FAULT_RE = /^attempt ([0-9A-HJKMNP-TV-Z]{26}) create failed: ([\s\S]*)$/;

export type CreateFaultClass = 'disk_full' | 'docker_resources' | 'docker_error';

/** `disk_full` (no space left), `docker_resources` (memory the daemon cannot give), else `docker_error`. */
export function classifyCreateFault(text: string): CreateFaultClass {
  if (/no space left on device/i.test(text)) return 'disk_full';
  if (/cannot allocate memory|minimum memory limit/i.test(text)) return 'docker_resources';
  return 'docker_error';
}
