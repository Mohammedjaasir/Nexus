/**
 * How Nexus's local HTTP servers are exposed (O.9 #11, #12; task 13).
 *
 *  - `listenLoopback` binds 127.0.0.1 (the address `address()` reports) and,
 *    best-effort, ::1 on the same port. tunnelmole forwards to `localhost`, which
 *    on Windows resolves to ::1 first; owning ::1 as well means that hop always
 *    lands on this server, never on another program that bound `::` on the port.
 *    Nothing listens on 0.0.0.0 or on a LAN address.
 *  - `openPublicTunnel` / `closePublicTunnels` wrap tunnelmole, which has no close
 *    handle. Its forwarder reads `options.port` on every request, so closing a
 *    tunnel re-points that options object at a loopback sink that answers 410:
 *    the public URL stops reaching the server at once.
 *  - `planServerPosture` is the one-time `serverPostureV1` migration (pure).
 *
 * Free of any `electron` import so it can be tested as a plain Node module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface LoopbackListener {
  /** The 127.0.0.1 listener (its address is what callers report). */
  primary: Server;
  /** The ::1 listener on the same port, or null when ::1 is unavailable. */
  v6: Server | null;
  port: number;
}

function listenOne(handler: RequestHandler, port: number, host: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(handler);
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

/** Bind 127.0.0.1:port (required) and ::1:samePort (best-effort). */
export async function listenLoopback(handler: RequestHandler, port: number): Promise<LoopbackListener> {
  const primary = await listenOne(handler, port, '127.0.0.1');
  const addr = primary.address();
  const bound = addr && typeof addr === 'object' ? addr.port : port;
  let v6: Server | null = null;
  try {
    v6 = await listenOne(handler, bound, '::1');
  } catch {
    // No IPv6 loopback on this host (EADDRNOTAVAIL), or ::1 is taken. localhost
    // still reaches 127.0.0.1 through Node's address fallback.
    v6 = null;
  }
  return { primary, v6, port: bound };
}

export function closeLoopback(l: LoopbackListener | null): void {
  if (!l) return;
  try { l.primary.close(); } catch { /* noop */ }
  try { l.v6?.close(); } catch { /* noop */ }
}

// ─── tunnelmole wrapper ──────────────────────────────────────────────────────

const TUNNEL_START_TIMEOUT_MS = 10_000;

/** Every options object handed to tunnelmole, by the server port it forwards. */
const tunnels = new Map<number, Array<{ port: number }>>();
let sink: Server | null = null;
let sinkPort: number | null = null;

/** Open a public tunnelmole URL forwarding to `port`. Times out after 10 s. */
export async function openPublicTunnel(port: number): Promise<string> {
  // NOTE: `tunnelmole` is ESM-only; the main bundle is CommonJS, so it must be a
  // dynamic import (Rollup keeps import() in CJS output). Do not hoist it.
  const { tunnelmole } = await import('tunnelmole');
  const options = { port };
  // Registered before the connection exists, so a tunnel that connects after a
  // timeout is still closed by closePublicTunnels.
  const list = tunnels.get(port) ?? [];
  list.push(options);
  tunnels.set(port, list);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
    tunnelmole(options)
      .then((url) => { clearTimeout(timer); resolve(url); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function ensureSink(): Promise<number | null> {
  if (sink && sinkPort) return sinkPort;
  try {
    const l = await listenLoopback((_req, res) => {
      try {
        res.writeHead(410, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'this public tunnel was closed' }));
      } catch { /* socket gone */ }
    }, 0);
    sink = l.primary;
    sinkPort = l.port;
    // The ::1 half is not needed for the sink: a refused ::1 falls back to 127.0.0.1.
    try { l.v6?.close(); } catch { /* noop */ }
    sink.unref();
    return sinkPort;
  } catch (e) {
    console.error('[tunnel] could not bind the closed-tunnel sink:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Stop every tunnel opened for `port` from reaching it. Returns how many were closed. */
export async function closePublicTunnels(port: number): Promise<number> {
  const list = tunnels.get(port);
  if (!list || list.length === 0) return 0;
  const target = await ensureSink();
  if (target == null) return 0;
  for (const o of list) o.port = target;
  tunnels.delete(port);
  console.log(`[tunnel] closed ${list.length} public tunnel(s) for port ${port}`);
  return list.length;
}

// ─── one-time posture migration ──────────────────────────────────────────────

export interface PosturePlan {
  slackPublicTunnel: boolean;
  webhookPublicTunnel: boolean;
  serverPostureV1: true;
  /** Set when an existing tunnel was kept on, so Settings shows the notice once. */
  serverPostureNoticeV1?: true;
}

/**
 * `serverPostureV1`: before task 13 every running Slack or webhook server was
 * tunneled. Keep that for the connections already in use; new ones start off.
 * Returns null when the migration already ran.
 */
export function planServerPosture(cfg: {
  serverPostureV1?: boolean;
  slackEnabled?: boolean;
  slackPublicTunnel?: boolean;
  webhookPublicTunnel?: boolean;
  webhookTriggers?: Array<{ enabled?: boolean }>;
}): PosturePlan | null {
  if (cfg.serverPostureV1 === true) return null;
  const slack = cfg.slackEnabled === true || cfg.slackPublicTunnel === true;
  const webhook = (cfg.webhookTriggers ?? []).some((t) => t?.enabled === true) || cfg.webhookPublicTunnel === true;
  const plan: PosturePlan = { slackPublicTunnel: slack, webhookPublicTunnel: webhook, serverPostureV1: true };
  if (slack || webhook) plan.serverPostureNoticeV1 = true;
  return plan;
}
