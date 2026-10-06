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
  /** The ::1 listener on the same port, or null when ::1 could not be bound. */
  v6: Server | null;
  /** Why ::1 could not be bound (an errno code such as EADDRNOTAVAIL or
   *  EADDRINUSE), or null when it is bound. */
  v6Error: string | null;
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

/** Bind 127.0.0.1:port (required) and ::1:samePort (best-effort; the reason it
 *  failed is returned and logged, never swallowed). */
export async function listenLoopback(handler: RequestHandler, port: number): Promise<LoopbackListener> {
  const primary = await listenOne(handler, port, '127.0.0.1');
  const addr = primary.address();
  const bound = addr && typeof addr === 'object' ? addr.port : port;
  let v6: Server | null = null;
  let v6Error: string | null = null;
  try {
    v6 = await listenOne(handler, bound, '::1');
  } catch (e) {
    v6Error = (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));
    if (v6Error !== 'EADDRNOTAVAIL') console.warn(`[server] could not listen on [::1]:${bound} (${v6Error})`);
  }
  return { primary, v6, v6Error, port: bound };
}

/**
 * Whether a tunnel may forward to this listener. tunnelmole forwards to
 * `localhost`, which resolves to ::1 first. If ::1 failed for any reason other
 * than "this host has no IPv6 loopback", another program may hold `[::]:port`
 * or `[::1]:port` and would receive the tunnelled traffic, so the tunnel must
 * not open. Returns the user-facing reason, or null when it is safe.
 */
export function tunnelBlockReason(l: LoopbackListener): string | null {
  if (!l.v6Error || l.v6Error === 'EADDRNOTAVAIL') return null;
  return `The public tunnel was not opened: another program is using port ${l.port} on [::1] (${l.v6Error}), so tunnelled requests could reach it instead of Nexus. Close that program or choose another port.`;
}

export function closeLoopback(l: LoopbackListener | null): void {
  if (!l) return;
  try { l.primary.close(); } catch { /* noop */ }
  try { l.v6?.close(); } catch { /* noop */ }
}

// ─── tunnelmole wrapper ──────────────────────────────────────────────────────

const TUNNEL_START_TIMEOUT_MS = 10_000;

type TunnelmoleFn = (options: { port: number }) => Promise<string>;
// NOTE: `tunnelmole` is ESM-only; the main bundle is CommonJS, so it must be a
// dynamic import (Rollup keeps import() in CJS output). Do not hoist it.
let loadTunnelmole: () => Promise<TunnelmoleFn> = async () => (await import('tunnelmole')).tunnelmole;
let tunnelTimeoutMs = TUNNEL_START_TIMEOUT_MS;

/** Tests only: replace tunnelmole (a real tunnel must never start in a test). */
export function setTunnelmoleForTests(fn: TunnelmoleFn | null, timeoutMs?: number): void {
  loadTunnelmole = fn ? async () => fn : async () => (await import('tunnelmole')).tunnelmole;
  tunnelTimeoutMs = timeoutMs ?? TUNNEL_START_TIMEOUT_MS;
}

/** Every live options object handed to tunnelmole, by the server port it forwards. */
const tunnels = new Map<number, Array<{ port: number }>>();
let sink: LoopbackListener | null = null;
/** tunnelmole resolves every pending call on one global URL_ASSIGNED event, so
 *  two tunnels opening at once can both get the first URL. Opens are serialized. */
let openChain: Promise<unknown> = Promise.resolve();

/** The loopback port of the closed-tunnel sink (answers 410 to everything). */
export async function ensureTunnelSink(): Promise<number> {
  if (sink) return sink.port;
  const l = await listenLoopback((_req, res) => {
    try {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'this public tunnel was closed' }));
    } catch { /* socket gone */ }
  }, 0);
  // Both halves stay open: tunnelmole's `localhost` hop tries ::1 first.
  l.primary.unref();
  l.v6?.unref();
  sink = l;
  return l.port;
}

function retarget(options: { port: number }): void {
  if (sink) options.port = sink.port;
}

/**
 * Open a public tunnelmole URL forwarding to `port`. Times out after 10 s; a
 * tunnel that connects after that is pointed at the sink, never left live.
 * Refuses when the sink cannot bind, because such a tunnel could not be closed.
 */
export function openPublicTunnel(port: number): Promise<string> {
  const run = async (): Promise<string> => {
    await ensureTunnelSink();
    const tunnelmole = await loadTunnelmole();
    const options = { port };
    // Registered before the connection exists, so closePublicTunnels reaches it.
    const list = tunnels.get(port) ?? [];
    list.push(options);
    tunnels.set(port, list);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        retarget(options);
        const l = tunnels.get(port);
        if (l) tunnels.set(port, l.filter((o) => o !== options));
        reject(new Error('timed out'));
      }, tunnelTimeoutMs);
      tunnelmole(options)
        .then((url) => { clearTimeout(timer); resolve(url); })
        .catch((e) => { clearTimeout(timer); retarget(options); reject(e); });
    });
  };
  const p = openChain.then(run, run);
  openChain = p.catch(() => undefined);
  return p;
}

/** Stop every tunnel opened for `port` from reaching it, synchronously (the sink
 *  exists before any tunnel opens). Returns how many were closed. */
export function closePublicTunnels(port: number): number {
  const list = tunnels.get(port);
  tunnels.delete(port);
  if (!list || list.length === 0) return 0;
  for (const o of list) retarget(o);
  console.log(`[tunnel] closed ${list.length} public tunnel(s) for port ${port}`);
  return list.length;
}

/** Tests: how many live tunnels forward to `port`. */
export function liveTunnelCount(port: number): number {
  return tunnels.get(port)?.length ?? 0;
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
