// Frozen v8 seed: shipped migration data; never edit - later changes go in a new migration.
// Deliberately self-contained, like v7Seed.ts: later phases add states and transitions as new rows.

export const V8_HANDOFF_STATES: readonly { readonly state: string; readonly terminal: 0 | 1; readonly description: string }[] = Object.freeze([
  Object.freeze({ state: 'sent', terminal: 0 as const, description: 'Sent to the receiving workspace; waiting for an answer' }),
  Object.freeze({ state: 'accepted', terminal: 0 as const, description: 'Accepted; a receipt version in the receiving workspace references the subjects' }),
  Object.freeze({ state: 'declined', terminal: 1 as const, description: 'Declined by the receiving workspace' }),
  Object.freeze({ state: 'withdrawn', terminal: 1 as const, description: 'Withdrawn by the sending workspace before an answer' })
]);

export const V8_HANDOFF_TRANSITIONS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(['sent', 'accepted'] as const),
  Object.freeze(['sent', 'declined'] as const),
  Object.freeze(['sent', 'withdrawn'] as const)
]);
