'use strict';
/**
 * nexus egress proxy (B2a stabilization, constraint 5): the ONLY way out of an approved dependency install.
 *
 * Topology (src/main/nexus/exec/planBuilder.ts, src/runner/core.ts): the install container sits on an `--internal`
 * network with no route out; this proxy is its only peer there (alias `nexus-egress-proxy`, port 3128) and also sits on
 * the job's outbound bridge. The install reaches the registries through HTTPS_PROXY; anything that ignores the proxy
 * has no route at all.
 *
 * Policy (fail closed; every decision is printed as one `nexus-egress {json}` line the runner turns into a job event):
 *  - only `CONNECT host:port HTTP/1.x`; any other method (plain HTTP through the proxy) is refused (`plain_http`);
 *  - the host is a DNS name on the allow-list in NEXUS_EGRESS_ALLOW (`host:port` entries, set by main per recipe),
 *    compared exactly after lower-casing and dropping one trailing dot; an IP literal is refused (`ip_literal`), a name
 *    not on the list (`host_not_allowed`), a port other than the entry's (`port_not_allowed`);
 *  - the client's TLS ClientHello must name the same host (SNI); a missing or different name is refused (`sni_mismatch`,
 *    `not_tls`), so a tunnel opened for an allowed name cannot be used for another TLS name at the same address;
 *  - the proxy resolves the name itself and refuses when ANY address is loopback, private, link-local, CGNAT, cloud
 *    metadata, multicast, reserved or otherwise not globally routable (`private_address`); it then connects to the very
 *    address it checked (no second lookup: DNS rebinding cannot swap it);
 *  - a test-only entry `host:port=ip` (never produced by main; the runner refuses it in a plan) connects to that one
 *    address without resolving and without the private-address rule; every other entry keeps the rule.
 * Logged: decision, host, port, reason, and the address used. Never a path, a query string or a header.
 *
 * Pure functions are exported for the unit tests (test/nexus-platform-exec-egress.test.cjs); run as a program, it
 * listens. Node built-ins only: no package, nothing downloaded.
 */
const net = require('node:net');
const dns = require('node:dns');

const PORT = 3128;
const HEAD_MAX = 8192;
const HELLO_MAX = 16384 + 5;
const HEAD_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 120000;
const MAX_TUNNELS = 64;
const REASONS = Object.freeze(['allowed', 'plain_http', 'malformed', 'ip_literal', 'host_not_allowed', 'port_not_allowed',
  'not_tls', 'sni_mismatch', 'private_address', 'dns_failed', 'connect_failed', 'busy']);

// ---------------------------------------------------------------- addresses

/** IPv4 dotted quad -> 32-bit number, or null. */
function v4num(s) {
  if (typeof s !== 'string' || !net.isIPv4(s)) return null;
  const p = s.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const cidr4 = (a, bits) => { const base = v4num(a); const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return [(base & mask) >>> 0, mask]; };
/** Not globally reachable IPv4 ranges (RFC 6890 and friends), plus cloud metadata endpoints. */
const V4_BLOCKED = Object.freeze([
  // Cloud metadata first (so the reason names it): AWS/GCP/Azure IMDS, AWS ECS, Azure wireserver, Alibaba.
  ['169.254.169.254', 32, 'metadata'], ['169.254.170.2', 32, 'metadata'], ['168.63.129.16', 32, 'metadata'], ['100.100.100.200', 32, 'metadata'],
  ['0.0.0.0', 8, 'this-network'], ['10.0.0.0', 8, 'private'], ['100.64.0.0', 10, 'cgnat'], ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], ['172.16.0.0', 12, 'private'], ['192.0.0.0', 24, 'ietf'], ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'], ['192.168.0.0', 16, 'private'], ['198.18.0.0', 15, 'benchmark'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved']
].map(([a, b, why]) => [...cidr4(a, b), why]));

/** Why an IPv4 address is refused, or null when it is globally routable. */
function v4Blocked(s) {
  const n = v4num(s);
  if (n === null) return 'unparsable';
  for (const [base, mask, why] of V4_BLOCKED) if (((n & mask) >>> 0) === base) return why;
  return null;
}

/** IPv6 text -> 8 groups (numbers), or null. Handles `::` and a dotted IPv4 tail; a zone id is refused. */
function v6groups(s) {
  if (typeof s !== 'string' || s.includes('%') || !net.isIPv6(s)) return null;
  let text = s;
  const dot = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dot) {
    const n = v4num(dot[1]); if (n === null) return null;
    text = `${text.slice(0, -dot[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (h) => (h === '' ? [] : h.split(':').map((x) => (/^[0-9a-fA-F]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/** Why an IPv6 address is refused, or null when it is globally routable. Embedded IPv4 (NAT64, 6to4) is judged as IPv4. */
function v6Blocked(s) {
  const g = v6groups(s);
  if (!g) return 'unparsable';
  const v4of = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return 'v4-mapped';
  if (g.slice(0, 6).every((x) => x === 0)) return 'v4-compatible';
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(v4of(g[6], g[7])) ? 'nat64-private' : null;
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'nat64-local';
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return 'discard';
  if (g[0] === 0x2001 && g[1] < 0x200) return 'ietf';                   // 2001::/23 (Teredo, ORCHID, benchmarking, ...)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'documentation';
  if (g[0] === 0x2002) return v4Blocked(v4of(g[1], g[2])) ? '6to4-private' : null;
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return 'metadata';            // fd00:ec2::254 (inside fc00::/7 too)
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x3fff && g[1] < 0x1000) return 'documentation';          // 3fff::/20
  return null;
}

/** Why an address (IPv4 or IPv6 text) may not be connected to, or null. */
function addressBlocked(addr) {
  if (net.isIPv4(addr)) return v4Blocked(addr);
  if (net.isIPv6(addr)) return v6Blocked(addr);
  return 'unparsable';
}

// ---------------------------------------------------------------- the allow-list

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A DNS host name as the proxy compares it (lower case, one trailing dot dropped), or null (an IP literal is null). */
function normalizeHost(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 254) return null;
  let s = h.toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length === 0 || s.length > 253 || net.isIP(s)) return null;
  const labels = s.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]) || /^0x/i.test(labels[0])) return null;   // numeric forms inet_aton would read
  return s;
}

/** `host:port[=ip]` entries, comma-separated -> [{ host, port, pin }]. Throws on anything else (the proxy refuses to start). */
function parseAllow(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2048) throw new Error('NEXUS_EGRESS_ALLOW is empty or too long');
  const out = [];
  for (const raw of text.split(',')) {
    const m = /^([a-z0-9.-]{1,253}):([0-9]{1,5})(?:=([0-9.]{7,15}))?$/.exec(raw);
    if (!m) throw new Error(`allow-list entry ${JSON.stringify(raw.slice(0, 80))} is not host:port`);
    const host = normalizeHost(m[1]);
    const port = Number(m[2]);
    if (!host || host !== m[1] || port < 1 || port > 65535) throw new Error(`allow-list entry ${JSON.stringify(raw.slice(0, 80))} is not host:port`);
    if (m[3] !== undefined && !net.isIPv4(m[3])) throw new Error('a pinned address is not an IPv4 address');
    out.push({ host, port, pin: m[3] ?? null });
  }
  if (out.length > 16) throw new Error('the allow-list has more than 16 entries');
  return out;
}

// ---------------------------------------------------------------- the request

/**
 * The request head (bytes up to and including the blank line) -> one of
 *   { kind: 'connect', host, port, literal }   (host as written, lower case; literal: an IP literal or bracketed form)
 *   { kind: 'plain', method, host }            (any other method; host only, never the path or query)
 *   { kind: 'malformed' }
 */
function parseHead(head) {
  const text = Buffer.isBuffer(head) ? head.toString('latin1') : String(head);
  const end = text.indexOf('\r\n');
  if (end <= 0) return { kind: 'malformed' };
  const line = text.slice(0, end);
  const m = /^([A-Z]{1,16}) (\S{1,2048}) HTTP\/1\.[01]$/.exec(line);
  if (!m) return { kind: 'malformed' };
  if (m[1] !== 'CONNECT') {
    const abs = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(\[[^\]/]*\]|[^/:?#@]*)/.exec(m[2]);
    return { kind: 'plain', method: m[1], host: abs ? abs[1].toLowerCase().slice(0, 255) : '' };
  }
  const a = /^(\[[0-9a-fA-F:.%]{2,64}\]|[^\s:/?#@[\]]{1,254}):([0-9]{1,5})$/.exec(m[2]);
  if (!a) return { kind: 'malformed' };
  const port = Number(a[2]);
  if (port < 1 || port > 65535 || String(port) !== a[2]) return { kind: 'malformed' };
  const host = a[1].toLowerCase();
  const literal = host.startsWith('[') || net.isIP(host) !== 0;
  return { kind: 'connect', host, port, literal };
}

/** The allow-list decision for a parsed request: { ok: true, entry } or { ok: false, reason }. */
function decideRequest(req, allow) {
  if (!req || req.kind === 'malformed') return { ok: false, reason: 'malformed' };
  if (req.kind === 'plain') return { ok: false, reason: 'plain_http' };
  if (req.literal) return { ok: false, reason: 'ip_literal' };
  const host = normalizeHost(req.host);
  if (!host) return { ok: false, reason: net.isIP(req.host.replace(/\.$/, '')) ? 'ip_literal' : 'host_not_allowed' };
  const byHost = allow.filter((e) => e.host === host);
  if (byHost.length === 0) return { ok: false, reason: 'host_not_allowed' };
  const entry = byHost.find((e) => e.port === req.port);
  if (!entry) return { ok: false, reason: 'port_not_allowed' };
  return { ok: true, entry };
}

/** The resolved addresses decision: every address must be routable (one bad address refuses all). */
function decideAddresses(entry, addresses) {
  if (entry.pin) return { ok: true, addresses: [entry.pin] };
  const list = Array.isArray(addresses) ? addresses.filter((a) => typeof a === 'string') : [];
  if (list.length === 0) return { ok: false, reason: 'dns_failed' };
  for (const a of list) {
    const why = addressBlocked(a);
    if (why) return { ok: false, reason: 'private_address', address: a, why };
  }
  return { ok: true, addresses: list };
}

/**
 * The SNI host name of a TLS ClientHello (the first bytes the client sends in the tunnel), or
 *   { need: true } when more bytes are needed, { error: 'not_tls' } when it is not a ClientHello, { sni: null } without SNI.
 */
function clientHelloSni(buf) {
  if (buf.length < 5) return { need: true };
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return { error: 'not_tls' };
  const recLen = buf.readUInt16BE(3);
  if (recLen < 4 || recLen > 16384) return { error: 'not_tls' };
  if (buf.length < 5 + recLen) return { need: true };
  const b = buf.subarray(5, 5 + recLen);
  if (b[0] !== 0x01) return { error: 'not_tls' };
  const hsLen = (b[1] << 16) | (b[2] << 8) | b[3];
  if (hsLen + 4 > b.length) return { error: 'not_tls' };          // a ClientHello split over records is not accepted
  let p = 4 + 2 + 32;
  const need = (n) => { if (p + n > 4 + hsLen) throw new Error('short'); };
  try {
    need(1); p += 1 + b[p];                                        // session id
    need(2); p += 2 + b.readUInt16BE(p);                           // cipher suites
    need(1); p += 1 + b[p];                                        // compression methods
    if (p === 4 + hsLen) return { sni: null };
    need(2); const extEnd = p + 2 + b.readUInt16BE(p); p += 2;
    if (extEnd > 4 + hsLen) return { error: 'not_tls' };
    while (p + 4 <= extEnd) {
      const type = b.readUInt16BE(p); const len = b.readUInt16BE(p + 2); p += 4;
      if (p + len > extEnd) return { error: 'not_tls' };
      if (type === 0) {
        let q = p + 2; const listEnd = p + 2 + b.readUInt16BE(p);
        while (q + 3 <= listEnd) {
          const nt = b[q]; const nl = b.readUInt16BE(q + 1); q += 3;
          if (q + nl > listEnd) return { error: 'not_tls' };
          if (nt === 0) return { sni: b.subarray(q, q + nl).toString('latin1') };
          q += nl;
        }
        return { sni: null };
      }
      p += len;
    }
    return { sni: null };
  } catch { return { error: 'not_tls' }; }
}

/** The tunnel's first bytes must be a ClientHello naming the CONNECT host. */
function decideSni(entry, hello) {
  const r = clientHelloSni(hello);
  if (r.need) return { need: true };
  if (r.error) return { ok: false, reason: 'not_tls' };
  const sni = typeof r.sni === 'string' ? normalizeHost(r.sni) : null;
  return sni === entry.host ? { ok: true } : { ok: false, reason: 'sni_mismatch' };
}

/** One decision line (what the runner reads): never a path, query string or header. */
function decisionLine(d) {
  const host = typeof d.host === 'string' ? d.host.replace(/[^a-z0-9.:[\]_-]/gi, '?').slice(0, 255) : '';
  const rec = { decision: d.reason === 'allowed' ? 'allowed' : 'refused', host, port: Number.isInteger(d.port) ? d.port : 0,
    reason: REASONS.includes(d.reason) ? d.reason : 'malformed', ...(typeof d.address === 'string' ? { address: d.address.slice(0, 45) } : {}) };
  return `nexus-egress ${JSON.stringify(rec)}`;
}

// ---------------------------------------------------------------- the server

function serve(allow, o = {}) {
  const log = o.log ?? ((l) => process.stdout.write(`${l}\n`));
  const lookup = o.lookup ?? ((host, cb) => dns.lookup(host, { all: true, verbatim: true }, (e, list) => cb(e, e ? [] : list.map((x) => x.address))));
  let open = 0;
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    let done = false;
    // 'head' (reading the request), 'hello' (200 sent, reading the ClientHello), 'connect' (resolving and connecting), 'tunnel'.
    let stage = 'head';
    let target = { host: '', port: 0 };
    const say = (d) => log(decisionLine(d));
    const refuse = (status, d) => {
      if (done) return; done = true;
      say(d);
      try { client.end(`HTTP/1.1 ${status}\r\nX-Nexus-Egress: ${d.reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    };
    client.setTimeout(HEAD_TIMEOUT_MS, () => {
      if (stage === 'head') refuse('408 Request Timeout', { reason: 'malformed', host: '', port: 0 });
      else if (stage === 'hello' && !done) { done = true; say({ reason: 'not_tls', ...target }); client.destroy(); }
      else if (stage !== 'connect') client.destroy();
    });
    client.on('error', () => { /* the client went away */ });
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > HEAD_MAX) refuse('400 Bad Request', { reason: 'malformed', host: '', port: 0 }); return; }
      client.off('data', onHead);
      const rest = head.subarray(end + 4);
      const req = parseHead(head.subarray(0, end + 4));
      const d = decideRequest(req, allow);
      if (!d.ok) {
        const status = d.reason === 'malformed' ? '400 Bad Request' : '403 Forbidden';
        return refuse(status, { reason: d.reason, host: req.host ?? '', port: req.port ?? 0 });
      }
      if (open >= MAX_TUNNELS) return refuse('503 Service Unavailable', { reason: 'busy', host: d.entry.host, port: req.port });
      open++;
      client.once('close', () => { open--; });
      target = { host: d.entry.host, port: req.port };
      // The tunnel is answered now; the ClientHello comes next and decides before anything leaves.
      stage = 'hello';
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let hello = rest;
      const onHello = (c) => {
        if (done) return;
        hello = Buffer.concat([hello, c]);
        const s = decideSni(d.entry, hello);
        if (s.need) { if (hello.length > HELLO_MAX) { done = true; say({ reason: 'not_tls', ...target }); client.destroy(); } return; }
        client.off('data', onHello);
        if (!s.ok) { done = true; say({ reason: s.reason, ...target }); client.destroy(); return; }
        client.pause();
        stage = 'connect';
        connectChecked(d.entry, hello);
      };
      client.on('data', onHello);
      if (hello.length > 0) onHello(Buffer.alloc(0));
    };
    const connectChecked = (entry, hello) => {
      // A pinned (test-only) entry is never resolved; every other name is resolved here, by the proxy, once.
      const resolve = entry.pin ? (h, cb) => cb(null, []) : lookup;
      resolve(entry.host, (err, addresses) => {
        const a = err ? { ok: false, reason: 'dns_failed' } : decideAddresses(entry, addresses);
        if (!a.ok) { done = true; say({ reason: a.reason, host: entry.host, port: entry.port, address: a.address }); client.destroy(); return; }
        const tryNext = (i) => {
          if (i >= a.addresses.length) { done = true; say({ reason: 'connect_failed', host: entry.host, port: entry.port }); client.destroy(); return; }
          const up = net.connect({ host: a.addresses[i], port: entry.port });
          const t = setTimeout(() => up.destroy(new Error('timeout')), CONNECT_TIMEOUT_MS);
          up.once('error', () => { clearTimeout(t); if (!done) tryNext(i + 1); });
          up.once('connect', () => {
            clearTimeout(t);
            done = true;
            stage = 'tunnel';
            say({ reason: 'allowed', host: entry.host, port: entry.port, address: a.addresses[i] });
            client.setTimeout(IDLE_TIMEOUT_MS, () => { client.destroy(); up.destroy(); });
            up.setTimeout(IDLE_TIMEOUT_MS, () => { client.destroy(); up.destroy(); });
            up.on('error', () => client.destroy());
            client.on('close', () => up.destroy());
            up.on('close', () => client.destroy());
            up.write(hello);
            client.pipe(up); up.pipe(client);
            client.resume();
          });
        };
        tryNext(0);
      });
    };
    client.on('data', onHead);
  });
  return server;
}

module.exports = { PORT, REASONS, v4Blocked, v6Blocked, v6groups, addressBlocked, normalizeHost, parseAllow, parseHead, decideRequest,
  decideAddresses, clientHelloSni, decideSni, decisionLine, serve };

if (require.main === module) {
  let allow;
  try { allow = parseAllow(process.env.NEXUS_EGRESS_ALLOW); } catch (e) { process.stderr.write(`nexus-egress: ${e.message}\n`); process.exit(64); }
  const server = serve(allow);
  server.on('error', (e) => { process.stderr.write(`nexus-egress: ${e.message}\n`); process.exit(70); });
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`nexus-egress-ready ${JSON.stringify({ port: PORT, allow: allow.map((e) => `${e.host}:${e.port}${e.pin ? '=pinned' : ''}`) })}\n`);
  });
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
