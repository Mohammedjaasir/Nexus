// Frozen v9 seed: shipped migration data; never edit - later changes go in a new migration.
// Deliberately self-contained, like v7Seed.ts and v8Seed.ts: later phases add states and transitions as new rows.

type StateRow = { readonly state: string; readonly terminal: 0 | 1; readonly description: string };
type Move = readonly [string, string];

const row = (state: string, terminal: 0 | 1, description: string): StateRow => Object.freeze({ state, terminal, description });
const move = (from: string, to: string): Move => Object.freeze([from, to] as const);

export const V9_ATTEMPT_STATES: readonly StateRow[] = Object.freeze([
  row('starting', 0, 'Leased; the sandbox is being provisioned or the attempt is waiting for an approval'),
  row('running', 0, 'The sandbox passed preflight and the work is executing'),
  row('succeeded', 1, 'The work exited and its outputs were ingested'),
  row('failed', 1, 'The work or its sandbox failed'),
  row('cancelled', 1, 'Cancelled by the user or with its parent'),
  row('timed_out', 1, 'The wall clock expired'),
  row('abandoned', 1, 'Lost before it could finish (restart, runner refusal or a vanished sandbox)')
]);

export const V9_ATTEMPT_TRANSITIONS: readonly Move[] = Object.freeze([
  move('starting', 'running'),
  move('starting', 'succeeded'),
  move('starting', 'failed'),
  move('starting', 'cancelled'),
  move('starting', 'abandoned'),
  move('running', 'succeeded'),
  move('running', 'failed'),
  move('running', 'cancelled'),
  move('running', 'timed_out'),
  move('running', 'abandoned')
]);

export const V9_APPROVAL_STATES: readonly StateRow[] = Object.freeze([
  row('pending', 0, 'Waiting for a decision'),
  row('approved', 1, 'Approved once; usable by exactly the request it names'),
  row('denied', 1, 'Denied by the user'),
  row('expired', 1, 'Not answered in time; treated as denied'),
  row('withdrawn', 1, 'Withdrawn because its job ended')
]);

export const V9_APPROVAL_TRANSITIONS: readonly Move[] = Object.freeze([
  move('pending', 'approved'),
  move('pending', 'denied'),
  move('pending', 'expired'),
  move('pending', 'withdrawn')
]);

// The plan gives deployment states without description text; each description below
// states only what the state means in the v9 triggers (bind 127.0.0.1, local preview).
export const V9_DEPLOYMENT_STATES: readonly StateRow[] = Object.freeze([
  row('starting', 0, 'The preview is starting and has not passed a health probe yet'),
  row('healthy', 0, 'The preview is running and its health probes pass'),
  row('unhealthy', 0, 'The preview is running but its health probes fail'),
  row('stopped', 1, 'Stopped, with a recorded reason'),
  row('failed', 1, 'Failed to start or failed while running, with a recorded reason')
]);

export const V9_DEPLOYMENT_TRANSITIONS: readonly Move[] = Object.freeze([
  move('starting', 'healthy'),
  move('starting', 'failed'),
  move('starting', 'stopped'),
  move('healthy', 'unhealthy'),
  move('unhealthy', 'healthy'),
  move('healthy', 'stopped'),
  move('unhealthy', 'stopped'),
  move('healthy', 'failed'),
  move('unhealthy', 'failed')
]);

/** Four rows added to the v7 lineage_relations vocabulary (D12, ruling R2). No existing row changes. */
export const V9_LINEAGE_RELATIONS: readonly { readonly relation: string; readonly description: string; readonly plannedPhase: string }[] = Object.freeze([
  Object.freeze({ relation: 'covers', description: 'A test suite or test case that covers a requirement', plannedPhase: 'B2c' }),
  Object.freeze({ relation: 'transformed_by', description: 'A dataset produced by a preprocessing pipeline or a cleaning query', plannedPhase: 'B3' }),
  Object.freeze({ relation: 'configured_by', description: 'A training run configured by an architecture or configuration version', plannedPhase: 'B6' }),
  Object.freeze({ relation: 'monitors', description: 'A monitoring report that monitors an inference service version', plannedPhase: 'B5' })
]);
