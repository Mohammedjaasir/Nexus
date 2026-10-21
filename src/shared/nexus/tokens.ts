// Agent capability tokens (B2b): the claims main records for one agent turn, and
// the shape of the raw token the agent's MCP client presents. The raw token is
// opaque: `<jti>.<mac>`, a 22-character base64url id and a 43-character base64url
// HMAC-SHA256 of that id under a key that lives only in main's memory for one
// boot. The claims are never inside the token; main loads them by `jti` from its
// own table. The token travels to the runner only over the MessagePort, is never
// in argv, a log, the model context, a database row or a view. Pure; no I/O.

import type { DomainSpec } from './domainSpec';

/** The raw token: `<jti 22 b64url>.<mac 43 b64url>`. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** The token id alone (16 random bytes in base64url). */
export const JTI_RE = /^[A-Za-z0-9_-]{22}$/;
/** The most bytes a presented bearer may have before it is even matched against TOKEN_RE. */
export const TOKEN_MAX_BYTES = 128;
/** The principal a token is issued to: `agent:<sessionId>`. */
export const AGENT_SUBJECT_RE = /^agent:[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * One capability a token grants: the domain ceiling's entry (its id and optional scope), intersected with the turn.
 * A token never holds a capability its domain's ceiling does not list.
 */
export type TokenCapability = DomainSpec['capabilities'][number];

export interface CapabilityClaims {
  jti: string;
  sub: `agent:${string}`;
  /** The agent always acts for the local user; it never acts for itself. */
  onBehalfOf: 'user:local';
  projectId: string;
  workspaceId: string;
  participationId: string;
  jobId: string;
  sessionId: string;
  caps: TokenCapability[];
  /** The version ids the turn was given as inputs (it may also read its own outputs). */
  inputs: string[];
  /** The MCP tool names the turn may call (a subset of MCP_TOOLS). */
  mcpTools: string[];
  maxChildJobs: number;
  /** Issued at and expiry, in ms since the epoch. */
  iat: number;
  exp: number;
}

/** True when `raw` has the shape of a token (bounded first, then TOKEN_RE). It says nothing about validity. */
export function isTokenShape(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= TOKEN_MAX_BYTES && TOKEN_RE.test(raw);
}
