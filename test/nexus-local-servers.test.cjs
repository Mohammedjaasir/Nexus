'use strict';
/**
 * Task 13 (O.9 #11–15): local servers.
 *  - Slack (3847) and webhooks (3849) listen on loopback only; a non-loopback
 *    address of this machine is not listening; `localhost` (the address
 *    tunnelmole forwards to) still reaches them.
 *  - Tunnels are a per-server opt-in; an opted-in tunnel forwards the BOUND port.
 *  - The hook pipe, the telemetry collector and the Ollama bridge need the
 *    agent's token; the real shim sends it, and status flows end to end.
 *  - The one-time serverPostureV1 migration keeps tunnels in use, nothing else.
 * Temp dirs and ephemeral ports only; never the network, the user's config or ~/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// electron stand-in: temp userData (config.ts) + Notification (hooks.ts).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-local-servers-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: { isEncryptionAvailable: () => false },
    Notification: class { show() {} static isSupported() { return false; } }
  }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { WebhookServer } = loadTs('src/main/webhook.ts');
const { SlackWebhookServer } = loadTs('src/main/slack.ts');
const { AgentTokens, authorizeHookPayload, bearerFrom } = loadTs('src/main/hookAuth.ts');
const { startOllamaBridge } = loadTs('src/main/ollama.ts');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { planServerPosture } = loadTs('src/main/serverPosture.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const SECRET = 'a'.repeat(64);
const mk = (o) => new WebhookServer({ port: 0, endpoints: [{ id: 'alpha', name: 'A', secret: SECRET, schema: '{"type":"object"}' }],
  onMessage: () => null, lookupStatus: () => null, ...o });
const mkSlack = (o) => new SlackWebhookServer({ port: 0, signingSecret: 'x', onMessage: () => {}, ...o });
const get = (url) => new Promise((resolve) => http.get(url, (r) => { r.resume(); resolve(r.statusCode); }).on('error', (e) => resolve(e.code)));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** A non-loopback IPv4 address of this machine, or null (then the check is skipped). */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}
/** Resolves 'open' when something accepts a TCP connection, else the error code. */
function probe(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve('open'); });
    s.once('timeout', () => { s.destroy(); resolve('timeout'); });
    s.once('error', (e) => resolve(e.code));
  });
}

// ─── O.9 #11 / #12: webhooks ─────────────────────────────────────────────────

test('O.9 #11/#12: webhooks bind loopback and open no tunnel unless opted in', async () => {
  let tunnels = 0;
  const s = mk({ publicTunnel: false, openTunnel: async () => { tunnels++; return 'https://t'; } });
  assert.deepEqual(await s.start(), { ok: true });
  assert.equal(s.address().address, '127.0.0.1');
  assert.equal(tunnels, 0);
  assert.equal(s.publicUrl(), null);
  s.stop();
});

test('O.9 #12: an opted-in tunnel forwards the bound port', async () => {
  let seen = null;
  const s = mk({ publicTunnel: true, openTunnel: async (port) => { seen = port; return 'https://t.example'; } });
  assert.deepEqual(await s.start(), { ok: true, url: 'https://t.example' });
  assert.equal(seen, s.boundPort());
  assert.ok(seen > 0);
  s.stop();
});

test('a failed tunnel leaves the loopback server up and stoppable', async () => {
  const s = mk({ publicTunnel: true, openTunnel: async () => { throw new Error('offline'); } });
  const r = await s.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /tunnel unavailable: offline/);
  assert.equal(s.listening(), true);
  s.stop();
  assert.equal(s.listening(), false);
});

test('localhost reaches the loopback listener (the path tunnelmole uses)', async () => {
  const s = mk({ publicTunnel: false });
  await s.start();
  const code = await get(`http://localhost:${s.boundPort()}/status/nope`);
  assert.equal(typeof code, 'number', `localhost did not reach 127.0.0.1: ${code}`);
  assert.equal(typeof await get(`http://127.0.0.1:${s.boundPort()}/alpha`), 'number');
  s.stop();
});

test('O.9 #11: a non-loopback address of this machine is not listening (webhooks)', async (t) => {
  const lan = lanAddress();
  if (!lan) { t.skip('no non-loopback IPv4 interface'); return; }
  const s = mk({ publicTunnel: false });
  await s.start();
  assert.equal(await probe('127.0.0.1', s.boundPort()), 'open');
  assert.notEqual(await probe(lan, s.boundPort()), 'open', `${lan}:${s.boundPort()} accepted a connection`);
  s.stop();
});

// ─── O.9 #11 / #12: Slack ────────────────────────────────────────────────────

test('O.9 #11/#12: Slack binds loopback and opens no tunnel unless opted in', async () => {
  let tunnels = 0;
  const s = mkSlack({ publicTunnel: false, openTunnel: async () => { tunnels++; return 'https://t'; } });
  assert.deepEqual(await s.start(), { ok: true });
  assert.equal(s.address().address, '127.0.0.1');
  assert.equal(tunnels, 0);
  // A POST from localhost reaches the handler (403: no Slack signature).
  const code = await new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: s.boundPort(), path: '/', method: 'POST' }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on('error', (e) => resolve(e.code));
    req.end('{}');
  });
  assert.equal(code, 403);
  s.stop();
});

test('O.9 #12: an opted-in Slack tunnel forwards the bound port', async () => {
  let seen = null;
  const s = mkSlack({ publicTunnel: true, openTunnel: async (port) => { seen = port; return 'https://s.example'; } });
  assert.deepEqual(await s.start(), { ok: true, url: 'https://s.example' });
  assert.equal(seen, s.boundPort());
  s.stop();
});

test('O.9 #11: a non-loopback address of this machine is not listening (Slack)', async (t) => {
  const lan = lanAddress();
  if (!lan) { t.skip('no non-loopback IPv4 interface'); return; }
  const s = mkSlack({ publicTunnel: false });
  await s.start();
  assert.notEqual(await probe(lan, s.boundPort()), 'open');
  s.stop();
});

test('servers never ask for the wildcard address; tunnelmole is imported only in serverPosture', () => {
  for (const f of ['src/main/slack.ts', 'src/main/webhook.ts']) {
    const src = read(f);
    assert.doesNotMatch(src, /\.listen\(this\.port,\s*\(\)/, `${f} still listens on all interfaces`);
    assert.doesNotMatch(src, /import\('tunnelmole'\)/, `${f} opens tunnels itself`);
    assert.match(src, /listenLoopback\(/);
  }
  const posture = read('src/main/serverPosture.ts');
  assert.match(posture, /listenOne\(handler, port, '127\.0\.0\.1'\)/);
  assert.match(posture, /listenOne\(handler, bound, '::1'\)/);
  assert.doesNotMatch(posture, /0\.0\.0\.0'/);
});

// ─── O.9 #12: migration + config ─────────────────────────────────────────────

test('serverPostureV1 keeps tunnels in use and nothing else', () => {
  assert.equal(planServerPosture({ serverPostureV1: true, slackEnabled: true }), null);
  assert.deepEqual(planServerPosture({ serverPostureV1: false, slackEnabled: true, webhookTriggers: [{ enabled: false }] }),
    { slackPublicTunnel: true, webhookPublicTunnel: false, serverPostureV1: true, serverPostureNoticeV1: true });
  assert.deepEqual(planServerPosture({ slackEnabled: false, webhookTriggers: [{ enabled: false }, { enabled: true }] }),
    { slackPublicTunnel: false, webhookPublicTunnel: true, serverPostureV1: true, serverPostureNoticeV1: true });
  assert.deepEqual(planServerPosture({ slackEnabled: false, webhookTriggers: [] }),
    { slackPublicTunnel: false, webhookPublicTunnel: false, serverPostureV1: true });
  // A Task 12 build persisted the default `false`; the migration overrides it.
  assert.equal(planServerPosture({ slackEnabled: true, slackPublicTunnel: false }).slackPublicTunnel, true);
});

test('readConfig: an older config.json is migrated, a new install is not', () => {
  const config = loadTs('src/main/config.ts');
  const file = path.join(userData, 'config.json');
  if (fs.existsSync(file)) fs.rmSync(file);
  // No file: defaults are already decided.
  assert.equal(config.readConfig().serverPostureV1, true);
  // A file written before task 13 (no key, even with the Task 12 defaults).
  fs.writeFileSync(file, JSON.stringify({ onboardingComplete: true, slackEnabled: true, slackPublicTunnel: false, triggersMigratedV1: true }));
  const old = config.readConfig();
  assert.equal(old.serverPostureV1, false);
  const plan = planServerPosture(old);
  config.writeConfig(plan);
  const after = config.readConfig();
  assert.equal(after.serverPostureV1, true);
  assert.equal(after.slackPublicTunnel, true);
  assert.equal(after.webhookPublicTunnel, false);
  assert.equal(planServerPosture(after), null, 'runs once');
  // A config written by this build keeps its decision.
  fs.writeFileSync(file, JSON.stringify({ ...after, slackEnabled: true, slackPublicTunnel: false }));
  assert.equal(config.readConfig().slackPublicTunnel, false);
  assert.equal(planServerPosture(config.readConfig()), null);
  fs.rmSync(file);
});

test('tunnel policy: on asks in main with the brief copy; the notice can only be dismissed', () => {
  const p = loadTs('src/main/configPolicy.ts');
  const cur = { slackPublicTunnel: false, webhookPublicTunnel: false };
  assert.deepEqual(p.classifyConfigPatch({ slackPublicTunnel: true }, cur).confirm.map((c) => c.key), ['slackPublicTunnel']);
  assert.deepEqual(p.classifyConfigPatch({ webhookPublicTunnel: false }, { webhookPublicTunnel: true }).apply, { webhookPublicTunnel: false });
  assert.deepEqual(p.confirmPrompt('slackPublicTunnel', true), {
    message: 'Open a public tunnel for Slack?',
    detail: "Nexus will ask tunnelmole for a public URL that forwards to this computer. Anyone with the URL can send requests; each request is still checked (Slack's signature). You can turn it off in Settings → Connections.",
    confirmLabel: 'Open tunnel'
  });
  assert.deepEqual(p.confirmPrompt('webhookPublicTunnel', true), {
    message: 'Open a public tunnel for webhooks?',
    detail: "Nexus will ask tunnelmole for a public URL that forwards to this computer. Anyone with the URL can send requests; each request is still checked (the webhook's secret). You can turn it off in Settings → Connections.",
    confirmLabel: 'Open tunnel'
  });
  assert.deepEqual(p.classifyConfigPatch({ serverPostureNoticeV1: false }, {}).apply, { serverPostureNoticeV1: false });
  assert.deepEqual(p.classifyConfigPatch({ serverPostureNoticeV1: true }, {}).rejected, ['serverPostureNoticeV1']);
  assert.equal(p.CONFIG_KEY_POLICY.serverPostureV1, 'internal');
});

test('Settings → Connections carries the exact tunnel copy', () => {
  const src = read('src/renderer/src/components/SettingsModal.tsx');
  for (const s of [
    'Public tunnel for Slack',
    "Slack can reach this computer only through a public tunnel (tunnelmole). Off by default. Requests still need Slack's signature.",
    'Public tunnel for webhooks',
    "Callers outside this computer can reach your webhooks only through a public tunnel. Each request still needs the webhook's secret.",
    'Public tunnels stay on for the Slack and webhook connections you already use. New connections start with them off.',
    'This makes the endpoint reachable from the internet.',
    'Listening on this computer only (127.0.0.1:{slackLocalPort}).',
    'Listening on this computer only (127.0.0.1:{webhookLocalPort}).'
  ]) assert.ok(src.includes(s), `missing: ${s}`);
  // The toggle goes through config:update (main's confirmation), not a new channel.
  assert.match(src, /window\.cth\.updateConfig\(\{ \[key\]: want \}/);
});

test('index.ts: servers start with the opt-in, the migration runs before auto-start, posture changes apply', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /publicTunnel: cfg\.slackPublicTunnel === true/);
  assert.match(idx, /publicTunnel: cfg\.webhookPublicTunnel === true/);
  const mig = idx.indexOf('  runServerPostureMigration();');
  assert.ok(mig > 0 && mig < idx.indexOf('const slackCfg = readConfig();'), 'migration must run before the Slack/webhook auto-start');
  assert.match(idx, /await applyTunnelPosture\(postureBefore, next\)/);
  assert.match(idx, /await closePublicTunnels\(port\)/);
});

// ─── O.9 #13: hook pipe ──────────────────────────────────────────────────────

test('O.9 #13: an unsigned or wrongly signed hook message is rejected', () => {
  const t = new AgentTokens();
  const a = t.issue('a'); const b = t.issue('b');
  assert.equal(authorizeHookPayload({ agent_id: 'a', hook_token: a }, t), true);
  assert.equal(authorizeHookPayload({ agent_id: 'a' }, t), false);
  assert.equal(authorizeHookPayload({ agent_id: 'a', hook_token: b }, t), false);
  assert.equal(authorizeHookPayload({ agent_id: 'a', hook_token: a.slice(1) }, t), false);
  assert.equal(authorizeHookPayload({ agent_id: null, hook_token: a }, t), false);
  t.revoke('a');
  assert.equal(authorizeHookPayload({ agent_id: 'a', hook_token: a }, t), false);
  assert.equal(t.agentFor(b), 'b');
});

test('tokens: 32 random bytes, re-issue replaces, odd input never throws', () => {
  const t = new AgentTokens();
  const one = t.issue('x');
  assert.match(one, /^[0-9a-f]{64}$/);
  const two = t.issue('x');
  assert.notEqual(one, two);
  assert.equal(t.verify('x', one), false);
  assert.equal(t.agentFor(one), null);
  assert.equal(t.verify('x', two), true);
  for (const bad of [undefined, null, 42, {}, [], '', 'é'.repeat(64)]) assert.equal(t.verify('x', bad), false);
  assert.equal(authorizeHookPayload(null, t), false);
});

test('bearer parsing', () => {
  assert.equal(bearerFrom('Bearer abc'), 'abc');
  assert.equal(bearerFrom('bearer abc'), 'abc');
  assert.equal(bearerFrom('Bearer%20abc'), 'abc');
  assert.equal(bearerFrom(undefined), null);
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom('Bearer'), null);
});

function hookFloor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-hook-auth-'));
  const tokens = new AgentTokens();
  const hive = new HiveManager(() => home);
  hive.setHookTokens(tokens);
  const sent = [];
  const wc = { send: (channel, payload) => sent.push({ channel, payload }) };
  const server = new HookServer(hive, () => wc, () => ({ notifications: false }), tokens, undefined, undefined);
  t.after(() => { try { server.stop(); } catch { /* noop */ } fs.rmSync(home, { recursive: true, force: true }); });
  return { home, tokens, hive, server, sent };
}

test('O.9 #13: HookServer emits nothing and records nothing for an unsigned message', (t) => {
  const { tokens, server, sent } = hookFloor(t);
  const tok = tokens.issue('a1');
  assert.deepEqual(server.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', transcript_path: '/x' }), {});
  assert.deepEqual(server.handle({ agent_id: 'a1', hook_token: 'nope', hook_event_name: 'Status', context_window: { total_input_tokens: 1, context_window_size: 2 } }), {});
  assert.equal(sent.length, 0);
  assert.equal(server.transcriptPath('a1'), undefined);
  assert.equal(server.contextFor('a1'), undefined);
  server.handle({ agent_id: 'a1', hook_token: tok, hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: '/x' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.event, 'PreToolUse');
  assert.equal(server.transcriptPath('a1'), '/x');
});

test('ensureAgent issues HIVE_HOOK_TOKEN and the OTel bearer header; a respawn replaces it', async (t) => {
  const { home, tokens, hive } = hookFloor(t);
  hive.setOtelEndpoint('http://127.0.0.1:1');
  const one = await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home }, {});
  assert.match(one.env.HIVE_HOOK_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(one.env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer%20' + one.env.HIVE_HOOK_TOKEN);
  assert.equal(tokens.verify('c1', one.env.HIVE_HOOK_TOKEN), true);
  const two = await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home }, {});
  assert.equal(tokens.verify('c1', one.env.HIVE_HOOK_TOKEN), false);
  assert.equal(tokens.verify('c1', two.env.HIVE_HOOK_TOKEN), true);
});

test('every shim and plugin template sends HIVE_HOOK_TOKEN', () => {
  const src = read('src/main/hive.ts');
  for (const name of ['HOOK_SHIM', 'AGY_HOOK_SHIM', 'PI_EXTENSION', 'OPENCODE_PLUGIN', 'PROXY_BRIDGE_SHIM', 'GROK_HOOK_SHIM']) {
    const start = src.indexOf(`const ${name} = \``);
    assert.ok(start > 0, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n`;', start));
    assert.match(body, /hook_token = process\.env\.HIVE_HOOK_TOKEN \|\| null/, `${name} does not send the token`);
  }
  // The qwen sidecar gets the token in its own env.
  assert.match(src, /HIVE_HOOK_TOKEN: cfg\.hookToken/);
});

test('ensureHive rewrites the boot shims every time, with the token', (t) => {
  const { home, hive } = hookFloor(t);
  hive.ensureHive();
  const shim = path.join(home, 'hive', 'bin', 'cth-hook.cjs');
  const proxy = path.join(home, 'hive', 'bin', 'hive-proxy.cjs');
  fs.writeFileSync(shim, '// an older shim without the token\n');
  hive.ensureHive();
  assert.match(fs.readFileSync(shim, 'utf8'), /HIVE_HOOK_TOKEN/);
  assert.match(fs.readFileSync(proxy, 'utf8'), /HIVE_HOOK_TOKEN/);
});

/** Run the REAL generated cth-hook shim against a live HookServer. */
function runShim(shim, env, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('end to end: the real cth-hook shim carries the token, a tokenless one goes nowhere', async (t) => {
  const { tokens, hive, server, sent } = hookFloor(t);
  hive.ensureHive();
  server.start();
  await new Promise((r) => setTimeout(r, 100));
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');
  const token = tokens.issue('e2e');
  const base = { HIVE_SOCK: hive.sockPath(), AGENT_ID: 'e2e' };
  await runShim(shim, { ...base, HIVE_HOOK_TOKEN: token }, { hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(sent.filter((s) => s.channel === 'hive:hookEvent').length, 1, 'status went dark: the signed shim message was not handled');
  await runShim(shim, { ...base, HIVE_HOOK_TOKEN: '' }, { hook_event_name: 'PreToolUse', tool_name: 'Read' });
  await runShim(shim, { ...base, HIVE_HOOK_TOKEN: 'f'.repeat(64) }, { hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(sent.filter((s) => s.channel === 'hive:hookEvent').length, 1, 'an unsigned message was handled');
});

// ─── O.9 #14: telemetry ──────────────────────────────────────────────────────

function postJson(port, pathName, body, headers = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.on('error', (e) => resolve(e.code));
    req.end(data);
  });
}
const metrics = (agentId) => ({
  resourceMetrics: [{
    resource: { attributes: [{ key: 'agent.id', value: { stringValue: agentId } }] },
    scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [{
      asInt: '100',
      attributes: [{ key: 'session.id', value: { stringValue: `s-${agentId}` } }, { key: 'type', value: { stringValue: 'input' } }]
    }] } }] }]
  }]
});

test('O.9 #14: the telemetry collector needs the agent token and only takes that agent\'s data', async () => {
  const tokens = new AgentTokens();
  const tok = tokens.issue('t1');
  tokens.issue('t2');
  const c = new TelemetryCollector({ tokens });
  const r = await c.start();
  assert.equal(r.ok, true);
  const port = Number(new URL(c.endpoint()).port);
  assert.equal(await postJson(port, '/v1/metrics', metrics('t1')), 401);
  assert.equal(await postJson(port, '/v1/metrics', metrics('t1'), { authorization: 'Bearer nope' }), 401);
  assert.equal(c.getAgentUsage('t1'), null);
  assert.equal(await postJson(port, '/v1/metrics', metrics('t1'), { authorization: `Bearer ${tok}` }), 200);
  assert.equal(c.getAgentUsage('t1').input, 100);
  // t1's token cannot write t2's numbers.
  assert.equal(await postJson(port, '/v1/metrics', metrics('t2'), { authorization: `Bearer ${tok}` }), 200);
  assert.equal(c.getAgentUsage('t2'), null);
  // An exporter that does not percent-decode OTEL_EXPORTER_OTLP_HEADERS still works.
  assert.equal(await postJson(port, '/v1/metrics', metrics('t1'), { authorization: `Bearer%20${tok}` }), 200);
  assert.equal(c.getAgentUsage('t1').input, 200);
  c.stop();
});

test('O.9 #14: without tokens the collector refuses everything', async () => {
  const c = new TelemetryCollector({});
  await c.start();
  const port = Number(new URL(c.endpoint()).port);
  assert.equal(await postJson(port, '/v1/logs', {}, { authorization: 'Bearer x' }), 401);
  c.stop();
});

// ─── O.9 #15: Ollama bridge ──────────────────────────────────────────────────

test('O.9 #15: the Ollama bridge refuses requests without the agent token and strips it upstream', async () => {
  let upstreamAuth = 'unset';
  const up = http.createServer((req, res) => { upstreamAuth = req.headers.authorization ?? null; res.end('{}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const bridge = await startOllamaBridge(process.cwd(), `http://127.0.0.1:${up.address().port}`, { token: 'tok' });
  const call = (headers) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/v1/models', method: 'GET', headers }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.end();
  });
  assert.equal(await call({}), 401);
  assert.equal(await call({ authorization: 'Bearer nope' }), 401);
  assert.equal(upstreamAuth, 'unset', 'a refused request must not reach upstream');
  assert.equal(await call({ authorization: 'Bearer tok' }), 200);
  assert.equal(upstreamAuth, null);
  bridge.close(); up.close();
});

test('O.9 #15: a bridge cannot start without a token; OpenCode sends it as apiKey', async () => {
  await assert.rejects(() => startOllamaBridge(process.cwd(), 'http://127.0.0.1:1', { token: '' }));
  const idx = read('src/main/index.ts');
  assert.match(idx, /startOllamaBridge\(opts\.cwd, effectiveLocalBaseUrl, \{ token \}\)/);
  assert.match(idx, /apiKey: bridgeToken/);
});
