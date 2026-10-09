/**
 * The port between the execution core (main) and the runner utilityProcess. Main sends
 * `MainToRunner` messages; everything the runner sends back arrives as `unknown` and is
 * validated by `parseRunnerMessage` and then against main's own state before it touches
 * the database (ExecutionService.onRunnerMessage). The real port (a MessagePort to the
 * runner, supervised) is Task 11; tests use test/helpers/fakeRunner.cjs.
 *
 * Rules for an implementation:
 * - `send` never blocks and never throws for a busy runner; a dead runner may throw. Main
 *   treats a failed `attempt.start` as "not sent": the attempt is abandoned and the job waits
 *   again at once. A live attempt whose lease then expires without a heartbeat fails
 *   `runner_lost` in the scheduler's sweep (retryable infrastructure).
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
