// Frozen v10 values: shipped migration data; never edit - later changes go in a new migration.
// Deliberately self-contained, like v7Seed.ts to v9Seed.ts. v10 inserts no rows: these are the values its CHECKs
// carry (test/nexus-db-v10-schema.test.cjs pins V10_DDL to them), named here so the code that writes v10 rows can
// read them. Task 1's shared caps (clampCaps) carry the same D-B4 numbers; the schema keeps its own frozen copy.

/**
 * The D-B4 ceilings on a runtime consent (binding user decision, 2026-10-21). Each one is a CHECK on
 * runtime_consents, so a grant can only lower it. Money is in US cents. The 30-minute wall clock and the
 * 20 child jobs are enforced on the job, not stored on the consent.
 */
export const V10_CONSENT_CEILINGS: Readonly<{
  turnUsdCents: 200; dayUsdCents: 1000; turnsPerHour: 6; concurrentTurns: 1; turnTokens: 400000; toolCalls: 200;
}> = Object.freeze({
  turnUsdCents: 200,
  dayUsdCents: 1000,
  turnsPerHour: 6,
  concurrentTurns: 1,
  turnTokens: 400000,
  toolCalls: 200
} as const);

/** Why a capability token was revoked (capability_tokens.revoke_reason). */
export const V10_REVOKE_REASONS: readonly ['job_ended', 'session_cancelled', 'restart', 'runner_restart', 'budget'] =
  Object.freeze(['job_ended', 'session_cancelled', 'restart', 'runner_restart', 'budget'] as const);

/** A user's decision on a change-set candidate (reviews.decision). */
export const V10_REVIEW_DECISIONS: readonly ['approve', 'request_changes', 'reject'] =
  Object.freeze(['approve', 'request_changes', 'reject'] as const);

/** Upper bounds, in characters, on the v10 text columns that hold claims, hosts and comments. */
export const V10_TEXT_LIMITS: Readonly<{ capsJson: 8192; inputsJson: 8192; toolsJson: 2048; hostsJson: 1024; reviewComment: 4000 }> =
  Object.freeze({ capsJson: 8192, inputsJson: 8192, toolsJson: 2048, hostsJson: 1024, reviewComment: 4000 } as const);
