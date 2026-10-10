// Evidence and validation results (types and constant tables only). A step is
// done only on validated evidence: never on an exit code, a file existing or a
// status a tool printed. Every item names where it came from.

export type ValidatorId = string;
export type ValidatorStage = 'register' | 'candidate' | 'promote';
export const VALIDATOR_STAGES: readonly ValidatorStage[] = ['register', 'candidate', 'promote'];

export type EvidenceType = 'hash' | 'number' | 'exit' | 'junit' | 'schema' | 'file' | 'http' | 'git' | 'user' | 'inspect' | 'log' | 'case';
export const EVIDENCE_TYPES: readonly EvidenceType[] =
  ['hash', 'number', 'exit', 'junit', 'schema', 'file', 'http', 'git', 'user', 'inspect', 'log', 'case'];

export type Evidence =
  | { type: 'hash'; label: string; sha256: string }
  | { type: 'number'; name: string; value: number; bound?: { op: '>=' | '<=' | '==' | '<' | '>'; value: number };
      source: { blobSha256: string; pointer: string } }                 // JSON pointer into a hashed file
  | { type: 'exit'; code: number | null; signal?: string; oomKilled?: boolean }
  | { type: 'junit'; sha256: string; total: number; passed: number; failed: number; errored: number; skipped: number }
  | { type: 'schema'; schemaId: string; errors: { path: string; message: string }[] }
  | { type: 'file'; path: string; sha256: string; bytes: number }
  | { type: 'http'; method: 'GET' | 'POST'; path: string; status: number | null; ms: number | null; bodySha256?: string }
  | { type: 'git'; commit: string; check: 'resolves' | 'ancestor' | 'merge_tree_clean' | 'paths_in_scope'; detail: string }
  | { type: 'user'; principalKind: 'user'; action: string; at: number }
  | { type: 'inspect'; field: string; value: string | number | boolean }  // from docker inspect
  | { type: 'log'; attemptId: string; stream: 'stdout' | 'stderr'; offset: number; length: number; sha256: string }
  // One failed or errored test case of a JUnit report (B2a Task 13 fix round 1): its names redacted and capped at ingest,
  // failures first, bounded; the per-case table the junit_summary preview pages.
  | { type: 'case'; name: string; classname: string; file: string | null; outcome: 'failed' | 'errored' };

/** `error` means the check could not run; it is never a pass. */
export type ValidationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface ValidationResult {
  id: string;
  versionId: string;
  validatorId: ValidatorId;
  validatorVersion: string;
  status: ValidationStatus;
  blocking: boolean;
  advisory: boolean;               // advisory results never gate anything
  summary: string;
  evidence: Evidence[];
  jobId?: string;
  attemptN?: number;
  startedAt: number;
  finishedAt: number;
}
