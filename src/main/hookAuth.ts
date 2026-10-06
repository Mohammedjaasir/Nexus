/**
 * Per-agent tokens for the local agent channels (O.9 #13–14; task 13): the hook
 * socket/pipe and the telemetry collector. Issued in main when an agent is
 * provisioned (`HIVE_HOOK_TOKEN` in its env), checked on every message, revoked
 * when its PTY goes away. Tokens live only in main's memory; a main restart kills
 * the PTYs that held the old ones.
 *
 * The named pipe keeps the Windows default DACL (Node cannot set one); the token
 * is the control against other same-user processes.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export class AgentTokens {
  private byAgent = new Map<string, string>();
  private byToken = new Map<string, string>();

  /** 32 random bytes, hex. Re-issuing for the same agent replaces its token. */
  issue(agentId: string): string {
    this.revoke(agentId);
    const token = randomBytes(32).toString('hex');
    this.byAgent.set(agentId, token);
    this.byToken.set(token, agentId);
    return token;
  }

  /** Constant-time check that `token` is the live token of `agentId`. */
  verify(agentId: string | null | undefined, token: unknown): boolean {
    if (typeof agentId !== 'string' || !agentId || typeof token !== 'string' || !token) return false;
    const expected = this.byAgent.get(agentId);
    if (!expected) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** The agent a token belongs to, or null. Checked in constant time against
   *  the stored token once the candidate agent is known. */
  agentFor(token: string): string | null {
    if (typeof token !== 'string' || !token) return null;
    const agentId = this.byToken.get(token);
    if (!agentId) return null;
    return this.verify(agentId, token) ? agentId : null;
  }

  revoke(agentId: string): void {
    const old = this.byAgent.get(agentId);
    if (old) this.byToken.delete(old);
    this.byAgent.delete(agentId);
  }
}

/** True when a hook payload carries the live token of the agent it names. */
export function authorizeHookPayload(
  p: { agent_id?: string | null; hook_token?: unknown },
  tokens: AgentTokens
): boolean {
  if (!p || typeof p !== 'object') return false;
  return tokens.verify(p.agent_id, p.hook_token);
}

/**
 * The token in an `Authorization: Bearer <token>` header, or null. Also accepts
 * `Bearer%20<token>`: OTEL_EXPORTER_OTLP_HEADERS values are percent-encoded, and
 * an exporter that does not decode them sends the encoded form.
 */
export function bearerFrom(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (typeof h !== 'string') return null;
  const m = /^\s*bearer(?:\s+|%20)(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/** Log a refused request at most once a minute per key, so an old shim that
 *  keeps firing cannot flood the log. */
const lastLog = new Map<string, number>();
export function logRefused(channel: string, key: string, detail: string): void {
  const k = `${channel}:${key}`;
  const now = Date.now();
  const prev = lastLog.get(k) ?? 0;
  if (now - prev < 60_000) return;
  lastLog.set(k, now);
  if (lastLog.size > 500) lastLog.clear();
  console.warn(`[${channel}] refused unauthenticated request (${detail})`);
}
