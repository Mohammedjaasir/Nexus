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
  assert.match(idx, /closePublicTunnels\(port\); lastSlackUrl = undefined/);
  assert.match(idx, /closePublicTunnels\(port\); lastWebhookUrl = undefined/);
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

// ─── Fix round 1 ─────────────────────────────────────────────────────────────

const posture = loadTs('src/main/serverPosture.ts');
const codexDaemon = loadTs('src/main/codexDaemon.ts');

/** A fake tunnelmole: records each options object; never touches the network. */
function fakeTunnelmole({ delayMs = 0, hang = false } = {}) {
  const calls = [];
  const fn = (options) => {
    calls.push({ options, at: Date.now() });
    if (hang) return new Promise(() => {});
    const n = calls.length;
    return new Promise((r) => setTimeout(() => r(`https://fake-${n}.example`), delayMs));
  };
  return { fn, calls };
}
/** What a tunnelmole forwarder does per request: GET localhost:<options.port>. */
const forward = (options, p = '/alpha') => get(`http://localhost:${options.port}${p}`);

/** Hold [::1]:port so 127.0.0.1:port is free but ::1 is taken. Null without IPv6 loopback. */
async function holdV6() {
  const blocker = http.createServer((q, r) => r.end('intruder'));
  try { await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(0, '::1', res); }); }
  catch { return null; }
  return blocker;
}

test('round 1: a ::1 bind failure is reported, not swallowed', async (t) => {
  const blocker = await holdV6();
  if (!blocker) { t.skip('no IPv6 loopback'); return; }
  const port = blocker.address().port;
  const l = await posture.listenLoopback((q, r) => r.end('ok'), port);
  assert.equal(l.v6, null);
  assert.equal(l.v6Error, 'EADDRINUSE');
  assert.match(posture.tunnelBlockReason(l), /another program is using port \d+ on \[::1\] \(EADDRINUSE\)/);
  posture.closeLoopback(l);
  blocker.close();
  assert.equal(posture.tunnelBlockReason({ v6Error: 'EADDRNOTAVAIL', port: 1 }), null, 'no IPv6 loopback is safe');
  assert.equal(posture.tunnelBlockReason({ v6Error: 'EAFNOSUPPORT', port: 1 }), null, 'no IPv6 in the kernel is safe');
  assert.match(posture.tunnelBlockReason({ v6Error: 'EACCES', port: 1 }), /EACCES/);
  assert.equal(posture.tunnelBlockReason({ v6Error: null, port: 1 }), null);
});

test('round 1: with ::1 held by another program the tunnel is refused, the local server still runs', async (t) => {
  for (const make of [mk, mkSlack]) {
    const blocker = await holdV6();
    if (!blocker) { t.skip('no IPv6 loopback'); return; }
    const port = blocker.address().port;
    let opened = 0;
    const s = make({ port, publicTunnel: true, openTunnel: async () => { opened++; return 'https://t'; } });
    const r = await s.start();
    assert.equal(r.ok, false);
    assert.match(r.error, /public tunnel was not opened: another program is using port/);
    assert.equal(opened, 0, 'the tunnel must not open');
    assert.equal(s.listening(), true);
    assert.equal(await probe('127.0.0.1', port), 'open');
    s.stop();
    // Without a tunnel the same situation is fine: nothing is forwarded.
    const local = make({ port, publicTunnel: false });
    assert.deepEqual(await local.start(), { ok: true });
    local.stop();
    blocker.close();
  }
});

test('round 1: the sink keeps its ::1 listener, so a closed tunnel answers 410 on localhost', async (t) => {
  const port = await posture.ensureTunnelSink();
  assert.equal(await get(`http://127.0.0.1:${port}/`), 410);
  assert.equal(await get(`http://localhost:${port}/`), 410);
  const blocker = await holdV6();
  if (!blocker) { t.skip('no IPv6 loopback'); return; }
  blocker.close();
  assert.equal(await probe('::1', port), 'open', 'the sink must still listen on ::1');
});

test('round 1: stop() closes every tunnel on the port; a restart never inherits the old URL', async (t) => {
  const fake = fakeTunnelmole();
  posture.setTunnelmoleForTests(fake.fn);
  t.after(() => posture.setTunnelmoleForTests(null));
  const sinkPort = await posture.ensureTunnelSink();
  const s = mk({ publicTunnel: true });
  const r = await s.start();
  assert.equal(r.ok, true);
  const port = s.boundPort();
  const first = fake.calls[0].options;
  assert.equal(first.port, port);
  const live = await forward(first);
  assert.equal(typeof live, 'number');
  assert.notEqual(live, 410);
  s.stop();
  assert.equal(first.port, sinkPort, 'stop must retarget the old tunnel');
  assert.equal(await forward(first), 410);
  assert.equal(posture.liveTunnelCount(port), 0);
  // Restart on the same port (a port change or Start again): only the new URL works.
  const again = mk({ port, publicTunnel: true });
  await again.start();
  const second = fake.calls[1].options;
  assert.equal(second.port, port);
  assert.equal(await forward(first), 410, 'the earlier URL still forwards nowhere');
  assert.notEqual(await forward(second), 410);
  again.stop();
  assert.equal(await forward(second), 410);
  // Slack does the same.
  const sl = mkSlack({ publicTunnel: true });
  await sl.start();
  const third = fake.calls[2].options;
  assert.equal(third.port, sl.boundPort());
  sl.stop();
  assert.equal(third.port, sinkPort);
});

test('round 1: server stop() calls the injected closeTunnel with the bound port', async () => {
  for (const make of [mk, mkSlack]) {
    const closed = [];
    const s = make({ publicTunnel: false, closeTunnel: (p) => closed.push(p) });
    await s.start();
    const port = s.boundPort();
    s.stop();
    assert.deepEqual(closed, [port]);
  }
});

test('round 1: index.ts closes tunnels on Stop and before every restart', () => {
  const idx = read('src/main/index.ts');
  const body = (name) => { const i = idx.indexOf(`function ${name}(`); return idx.slice(i, idx.indexOf('\n}\n', i)); };
  assert.match(body('stopSlackServer'), /closePublicTunnels\(port\)[\s\S]*slackServer\?\.stop\(\)/);
  assert.match(body('stopWebhookServer'), /closePublicTunnels\(port\)[\s\S]*webhookServer\?\.stop\(\)/);
  assert.match(body('startSlackServer'), /closePublicTunnels\(prevSlackPort\);\s*slackServer\?\.stop\(\)/);
  assert.match(body('applyTunnelPosture'), /stopWebhookServer\(\);\s*const r = await startWebhookServer\(\)/);
  assert.match(idx, /tunnelError: lastSlackTunnelError/);
  assert.match(idx, /tunnelError: lastWebhookTunnelError/);
  const settings = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(settings, /t\.on && t\.error/);
});

test('round 1: a tunnel that connects after the timeout is dead, not live', async (t) => {
  const fake = fakeTunnelmole({ hang: true });
  posture.setTunnelmoleForTests(fake.fn, 50);
  t.after(() => posture.setTunnelmoleForTests(null));
  const sinkPort = await posture.ensureTunnelSink();
  await assert.rejects(() => posture.openPublicTunnel(4321), /timed out/);
  assert.equal(fake.calls[0].options.port, sinkPort);
  assert.equal(posture.liveTunnelCount(4321), 0);
});

test('round 1: tunnel opens are serialized (tunnelmole has one global URL_ASSIGNED)', async (t) => {
  const fake = fakeTunnelmole({ delayMs: 80 });
  posture.setTunnelmoleForTests(fake.fn);
  t.after(() => posture.setTunnelmoleForTests(null));
  const [a, b] = await Promise.all([posture.openPublicTunnel(5001), posture.openPublicTunnel(5002)]);
  assert.notEqual(a, b);
  assert.ok(fake.calls[1].at - fake.calls[0].at >= 70, 'the second open started before the first resolved');
  posture.closePublicTunnels(5001); posture.closePublicTunnels(5002);
  const idx = read('src/main/index.ts');
  assert.match(idx, /void bootSlack\.then\(\(\) => \{\s*if \(enabledWebhookEndpoints\(\)\.length === 0\) return;\s*return startWebhookServer\(\)/,
    'boot must start webhooks after Slack');
});

test('round 1: tunnelmole is pinned and still reads options.port per forwarded request', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies.tunnelmole, '2.4.0');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].dependencies.tunnelmole, '2.4.0');
  assert.equal(JSON.parse(read('node_modules/tunnelmole/package.json')).version, '2.4.0');
  const src = read('node_modules/tunnelmole/dist/src/message-handlers/forwarded-request.js');
  const start = src.indexOf('export default async function forwardedRequest(forwardedRequestMessage, websocket, options)');
  assert.ok(start >= 0, 'forwardedRequest signature changed: closePublicTunnels relies on it');
  const handler = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(handler, /const port = options\.port;/, 'the forwarder must read options.port per request');
  assert.match(handler, /hostname: 'localhost',\s*method,\s*port,/, 'the forwarder must use that port for localhost');
});

test('round 1: Codex Remote daemon restarts when its hook token changed', () => {
  const { planDaemonRestart, tokenFingerprint, readDaemonFingerprint, writeDaemonFingerprint, daemonRestartError } = codexDaemon;
  const tok = 'a'.repeat(64);
  const fp = tokenFingerprint(tok);
  assert.ok(!fp.includes(tok) && fp.length === 32);
  assert.equal(tokenFingerprint(''), '');
  assert.deepEqual(planDaemonRestart(null, fp), { stop: 'best-effort', start: true });
  assert.deepEqual(planDaemonRestart(tokenFingerprint('b'.repeat(64)), fp), { stop: 'required', start: true });
  assert.deepEqual(planDaemonRestart(fp, fp), { stop: 'none', start: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-codex-daemon-'));
  try {
    assert.equal(readDaemonFingerprint(home), null);
    writeDaemonFingerprint(home, fp);
    assert.equal(readDaemonFingerprint(home), fp);
    assert.ok(!fs.readFileSync(path.join(home, '.nexus-daemon-token'), 'utf8').includes(tok));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  assert.match(daemonRestartError('x'), /needs your attention/);
  const idx = read('src/main/index.ts');
  const i = idx.indexOf('async function enableCodexRemoteInner(');
  const body = idx.slice(i, idx.indexOf('\n}\n', i));
  assert.match(body, /if \(process\.platform === 'win32'\) return false;/, 'Windows unchanged');
  assert.match(body, /restartDaemonWithToken\(\{[\s\S]*socketExists: \(\) => existsSync\(socket\)[\s\S]*\['app-server', 'daemon', cmd\]/);
  assert.match(body, /if \(restarted\.attention\)[\s\S]*return \{ remote: false, error: restarted\.attention \}/);
  assert.match(idx, /send\('hive:hookEvent', \{ agentId, event: 'Notification', message/);
});

test('round 1: hookAuth documents what env-held tokens do not cover', () => {
  const src = read('src/main/hookAuth.ts');
  assert.match(src, /SAME user can read another process's environment/);
  assert.match(src, /do NOT guard against a same-user process/);
});

// ─── Fix round 2: Codex daemon stop that finds nothing running ───────────────

function daemonHome(t, fingerprint) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-codex-restart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (fingerprint) codexDaemon.writeDaemonFingerprint(home, fingerprint);
  return home;
}
const fakeRun = (results) => {
  const calls = [];
  return { calls, run: async (cmd) => { calls.push(cmd); return results[cmd]; } };
};

test('round 2: a stale marker after a reboot: stop says not running, start runs, marker rewritten', async (t) => {
  const { restartDaemonWithToken, tokenFingerprint, readDaemonFingerprint } = codexDaemon;
  const old = tokenFingerprint('o'.repeat(64));
  const next = tokenFingerprint('n'.repeat(64));
  // Socket still on disk (stale), output says nothing is running.
  const home = daemonHome(t, old);
  const f = fakeRun({ stop: { ok: false, error: 'Error: daemon is not running' }, start: { ok: true } });
  assert.deepEqual(await restartDaemonWithToken({ codexHome: home, fingerprint: next, socketExists: () => true, run: f.run }), { ok: true });
  assert.deepEqual(f.calls, ['stop', 'start']);
  assert.equal(readDaemonFingerprint(home), next);
  // Socket gone (crash/reboot cleaned it), unhelpful error text: still not running.
  const home2 = daemonHome(t, old);
  const g = fakeRun({ stop: { ok: false, error: 'exit code 1' }, start: { ok: true } });
  assert.deepEqual(await restartDaemonWithToken({ codexHome: home2, fingerprint: next, socketExists: () => false, run: g.run }), { ok: true });
  assert.deepEqual(g.calls, ['stop', 'start']);
  assert.equal(readDaemonFingerprint(home2), next);
  // The next spawn after that is a normal restart again, not a permanent fallback.
  const newer = tokenFingerprint('m'.repeat(64));
  const h = fakeRun({ stop: { ok: true }, start: { ok: true } });
  assert.deepEqual(await restartDaemonWithToken({ codexHome: home2, fingerprint: newer, socketExists: () => true, run: h.run }), { ok: true });
  assert.equal(readDaemonFingerprint(home2), newer);
});

test('round 2: a real stop failure with the daemon still up falls back to local with the notice', async (t) => {
  const { restartDaemonWithToken, tokenFingerprint, readDaemonFingerprint, stopLeftNothingRunning } = codexDaemon;
  const old = tokenFingerprint('o'.repeat(64));
  const home = daemonHome(t, old);
  const f = fakeRun({ stop: { ok: false, error: 'permission denied' }, start: { ok: true } });
  const r = await restartDaemonWithToken({ codexHome: home, fingerprint: tokenFingerprint('n'.repeat(64)), socketExists: () => true, run: f.run });
  assert.equal(r.ok, false);
  assert.match(r.attention, /Codex Remote needs your attention: .*permission denied/);
  assert.deepEqual(f.calls, ['stop'], 'must not start against a daemon holding the old token');
  assert.equal(readDaemonFingerprint(home), old, 'marker untouched');
  // No marker (pre-upgrade daemon): a failed stop is best-effort.
  const fresh = daemonHome(t, null);
  const g = fakeRun({ stop: { ok: false, error: 'permission denied' }, start: { ok: true } });
  assert.deepEqual(await restartDaemonWithToken({ codexHome: fresh, fingerprint: 'x', socketExists: () => true, run: g.run }), { ok: true });
  // A start failure is the old local fallback, without the notice.
  const s = fakeRun({ stop: { ok: true }, start: { ok: false, error: 'boom' } });
  const sr = await restartDaemonWithToken({ codexHome: daemonHome(t, old), fingerprint: 'y', socketExists: () => true, run: s.run });
  assert.deepEqual(sr, { ok: false, error: 'boom' });
  // The classifier itself.
  assert.equal(stopLeftNothingRunning({ ok: true }, true), true);
  assert.equal(stopLeftNothingRunning({ ok: false, error: 'x' }, false), true);
  for (const e of ['daemon is not running', 'No daemon running', "daemon isn't running", 'connect ECONNREFUSED /tmp/x.sock', 'ENOENT: no such file']) {
    assert.equal(stopLeftNothingRunning({ ok: false, error: e }, true), true, e);
  }
  assert.equal(stopLeftNothingRunning({ ok: false, error: 'permission denied' }, true), false);
});
