'use strict';
// B2b Task 0: a plain-node self-test of the agent harness. It never runs the agent CLI.
//   HN1 the mock model serves a scripted turn (JSON and SSE) and records the system prompt and tool list
//   HN2 the proxy recorder refuses and records every CONNECT; the MCP recorder records initialize, tools/list,
//       tools/call with their headers
//   HN3 the fake home and the worktree hold every canary
//   HN4 no real home path appears in env; env is built from nothing; the root is cleaned up
//   HN5 the probe's pure parts: the --help flag reader, the `auth status` parse, the 200 KiB context
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const mockModel = require('./helpers/mockModel.cjs');
const proxyRecorder = require('./helpers/proxyRecorder.cjs');
const mcpRecorder = require('./helpers/mcpRecorder.cjs');
const fakeHome = require('./helpers/fakeHome.cjs');
const H = require('./helpers/agentHarness.cjs');
const probe = require('../tools/nexus-agent-probe.cjs');

const FIX = path.join(__dirname, 'fixtures', 'agent', 'probe');

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('HN1: the mock model serves a scripted tool_use turn, then text, and records system and tools', async () => {
  const mock = await mockModel.start({
    script: (_body, step) => (step === 0 ? [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: 'a.txt' } }] : [{ type: 'text', text: 'done' }])
  });
  try {
    assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const body = { model: 'm', system: [{ type: 'text', text: 'SYS-CANARY' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] };
    const r1 = await post(`${mock.url}/v1/messages`, body);
    assert.equal(r1.status, 200);
    const j1 = JSON.parse(r1.text);
    assert.equal(j1.stop_reason, 'tool_use');
    assert.deepEqual(j1.content[0], { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: 'a.txt' } });
    // second step, streamed
    const body2 = { ...body, stream: true, messages: [...body.messages, { role: 'assistant', content: j1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'file text', is_error: false }] }] };
    const r2 = await post(`${mock.url}/v1/messages`, body2);
    assert.match(r2.headers['content-type'], /text\/event-stream/);
    assert.match(r2.text, /event: message_start/);
    assert.match(r2.text, /"text_delta","text":"done"/);
    assert.match(r2.text, /"stop_reason":"end_turn"/);
    assert.equal(mock.toolRequests().length, 2);
    assert.equal(mockModel.systemText(mock.toolRequests()[0].body), 'SYS-CANARY');
    assert.deepEqual(mockModel.toolNames(mock.toolRequests()[0].body), ['Read']);
    assert.deepEqual(mockModel.toolResults(mock.toolRequests()[1].body), [{ toolUseId: 'toolu_x', isError: false, text: 'file text' }]);
    // a side call without tools gets a short text, and unknown routes are recorded with 404
    const r3 = await post(`${mock.url}/v1/messages`, { model: 'm', messages: [{ role: 'user', content: 'title?' }] });
    assert.equal(JSON.parse(r3.text).content[0].text, 'ok');
    const r4 = await post(`${mock.url}/v1/other`, {});
    assert.equal(r4.status, 404);
    assert.equal(mock.requests.length, 4);
  } finally { await mock.stop(); }
});

test('HN2: the proxy recorder refuses every CONNECT with 403 and records host:port; the MCP recorder records with headers', async () => {
  const proxy = await proxyRecorder.start({ mode: 'recorder' });
  try {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => s.write('CONNECT api.example.invalid:443 HTTP/1.1\r\nHost: api.example.invalid:443\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => { buf += d.toString('utf8'); });
      s.on('close', () => resolve(buf));
      s.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.deepEqual(proxy.hosts(), ['api.example.invalid:443']);
    assert.equal(proxy.connects[0].port, 443);
    const plain = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: 'http://plain.example.invalid/x', method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.end();
    });
    assert.equal(plain, 403);
    assert.ok(proxy.hosts().includes('plain.example.invalid'));
  } finally { await proxy.stop(); }

  const mcp = await mcpRecorder.start({ onCall: (name, args) => `called ${name} ${JSON.stringify(args)}` });
  try {
    const auth = { authorization: 'Bearer tok-123', accept: 'application/json, text/event-stream' };
    const init = await post(mcp.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, auth);
    assert.equal(JSON.parse(init.text).result.protocolVersion, '2025-06-18');
    assert.ok(init.headers['mcp-session-id']);
    const note = await post(mcp.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    assert.equal(note.status, 202);
    const list = await post(mcp.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    assert.deepEqual(JSON.parse(list.text).result.tools.map((t) => t.name), ['context_get', 'changeset_register']);
    const call = await post(mcp.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_get', arguments: { part: 'x' } } }, auth);
    assert.deepEqual(JSON.parse(call.text).result, { content: [{ type: 'text', text: 'called context_get {"part":"x"}' }], isError: false });
    const bad = await post(mcp.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, auth);
    assert.equal(JSON.parse(bad.text).error.code, -32602);
    assert.deepEqual(mcp.methods(), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
    assert.ok(mcp.records.every((r) => r.headers.authorization === 'Bearer tok-123'));
    assert.equal(mcp.calls()[0].params.name, 'context_get');
  } finally { await mcp.stop(); }
});

test('HN3: the fake home and the worktree hold every canary; the job files carry the env-form bearer', async () => {
  const h = await H.start({ home: 'fake', model: 'mock', proxy: 'deny-all', mcp: 'recorder', bin: null });
  try {
    const c = h.canaries;
    const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    const inHome = {
      homeMemory: '.claude/CLAUDE.md', homeRules: '.claude/rules/canary.md', homeSkill: '.claude/skills/home-canary/SKILL.md',
      homeAgent: '.claude/agents/home-canary.md', homeCommand: '.claude/commands/home-canary.md', homeHook: '.claude/settings.json',
      homeMcp: '.claude.json', wtLocalMcp: '.claude.json', homePlugin: '.canary-market/home-canary-plugin/.claude-plugin/plugin.json'
    };
    for (const [k, rel] of Object.entries(inHome)) assert.ok(read(h.home.dir, rel).includes(c[k]), `${k} in ${rel}`);
    assert.ok(read(h.home.dir, '.claude/settings.json').includes(H.modelCanary(c.homeSettings)), 'user settings carry a model canary');
    for (const rel of ['skills/home-canary-plugin-skill/SKILL.md', 'commands/home-canary-plugin-cmd.md', 'agents/home-canary-plugin-agent.md', 'hooks/hooks.json']) {
      assert.ok(read(h.home.dir, `.canary-market/home-canary-plugin/${rel}`).includes(c.homePlugin), `plugin ${rel}`);
    }
    const installed = JSON.parse(read(h.home.dir, '.claude/plugins/installed_plugins.json'));
    assert.ok(installed.plugins['home-canary-plugin@nexus-canary-market'] && installed.plugins['wt-canary-plugin@nexus-canary-wt-market']);
    const inWt = {
      wtMemory: 'CLAUDE.md', wtLocalMemory: 'CLAUDE.local.md', wtDotMemory: '.claude/CLAUDE.md', wtSkill: '.claude/skills/wt-canary/SKILL.md',
      wtAgent: '.claude/agents/wt-canary.md', wtCommand: '.claude/commands/wt-canary.md', wtHook: '.claude/settings.json',
      wtMcp: '.mcp.json', envSecret: '.env', wtPlugin: '.canary-market/wt-canary-plugin/.claude-plugin/plugin.json'
    };
    for (const [k, rel] of Object.entries(inWt)) assert.ok(read(h.worktree, rel).includes(c[k]), `${k} in ${rel}`);
    assert.ok(read(h.worktree, '.claude/settings.json').includes(H.modelCanary(c.wtSettings)));
    assert.ok(read(h.worktree, '.claude/settings.local.json').includes(H.modelCanary(c.wtLocalSettings)));
    // every isolation canary is planted somewhere
    const planted = [h.home.dir, h.worktree].map((d) => fakeHome.snapshot(d).map((f) => fs.readFileSync(path.join(d, f.rel), 'utf8')).join('\n')).join('\n');
    for (const k of H.ISOLATION_CANARY_KEYS) assert.ok(planted.includes(c[k]), `${k} is planted`);
    // hooks point at the marker folder, which exists and is empty
    assert.ok(read(h.home.dir, '.claude/settings.json').includes(h.markerDir.split(path.sep).join('/')));
    assert.deepEqual(fs.readdirSync(h.markerDir), []);
    assert.equal(new Set(Object.values(c)).size, Object.keys(c).length, 'canaries are distinct');
    const f = h.writeJobFiles({ skillsText: `skills ${c.skills}` });
    const mcp = JSON.parse(fs.readFileSync(f.mcpJson, 'utf8'));
    assert.equal(mcp.mcpServers.nexus.headers.Authorization, 'Bearer ${NEXUS_MCP_TOKEN}');
    assert.equal(mcp.mcpServers.nexus.url, h.mcp.url);
    assert.ok(!fs.readFileSync(f.mcpJson, 'utf8').includes(h.token), 'the env form keeps the token out of mcp.json');
    assert.ok(fs.readFileSync(f.skillsMd, 'utf8').includes(c.skills));
    // the probe's fixture settings deny .env reads
    assert.ok(JSON.parse(fs.readFileSync(path.join(FIX, 'settings.deny.json'), 'utf8')).permissions.deny.includes('Read(**/.env*)'));
  } finally { await h.stop(); }
});

test('HN4: no real home path appears in env, env is built from nothing, and stop() removes the root', async () => {
  const h = await H.start({ home: 'fake', model: 'mock', proxy: 'deny-all', mcp: 'recorder', bin: null });
  const root = h.root;
  try {
    const realHome = path.resolve(os.homedir()).toLowerCase();
    for (const [k, v] of Object.entries(h.env)) assert.ok(!String(v).toLowerCase().includes(realHome), `${k} must not point into the real home`);
    for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(fakeHome.isUnder(h.env[k], h.root), `${k} is inside the harness root`);
    const allow = ['SystemRoot', 'windir', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'HTTPS_PROXY', 'NO_PROXY',
      'NEXUS_MCP_TOKEN', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      ...(process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH'] : [])];
    const seam = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];
    assert.deepEqual(Object.keys(h.env).sort(), [...allow, ...seam].sort(), 'env = the allow-list plus exactly the two test-seam names');
    assert.equal(h.env.HTTPS_PROXY, h.proxy.url);
    assert.equal(h.env.NO_PROXY, '127.0.0.1');
    assert.equal(h.env.ANTHROPIC_BASE_URL, h.mock.url);
    assert.ok(!('HTTP_PROXY' in h.env) && !('CLAUDE_CONFIG_DIR' in h.env) && !('NODE_EXTRA_CA_CERTS' in h.env));
    assert.match(h.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(h.mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(!h.argvBase.join(' ').includes(h.token), 'argv holds no token');
    assert.ok(Buffer.byteLength(h.argvBase.join(' ')) < 8 * 1024);
    for (const f of H.PINNED_FLAGS.filter((x) => x !== '--append-system-prompt')) assert.ok(h.argvBase.includes(f), `argvBase carries ${f}`);
    assert.ok(!h.argvBase.includes('--safe-mode'), 'D-B15: --safe-mode is not passed');
    const dis = h.argvBase.indexOf('--disallowedTools');
    assert.deepEqual(h.argvBase.slice(dis + 1, dis + 8).sort(), ['Agent', 'Bash', 'NotebookEdit', 'PowerShell', 'Task', 'WebFetch', 'WebSearch']);
    assert.equal(h.argvBase[h.argvBase.indexOf('--setting-sources') + 1], '');
    if (!h.underRealHome) assert.ok(!fakeHome.isUnder(h.root, os.homedir()), 'the root is outside the real home');
    // model 'none' drops the base URL but keeps the fake key
    const h2 = await H.start({ home: 'fake', model: 'none', proxy: 'recorder', mcp: 'recorder', bin: null });
    try {
      assert.equal(h2.mock, null);
      assert.ok(!('ANTHROPIC_BASE_URL' in h2.env));
      assert.equal(h2.env.ANTHROPIC_API_KEY, H.FAKE_KEY);
    } finally { await h2.stop(); }
    assert.throws(() => fakeHome.removeRoot(os.homedir()), /refusing/);
  } finally { await h.stop(); }
  assert.equal(fs.existsSync(root), false, 'stop() removed the harness root');
});

test('HN5: the probe reads --help flags, parses auth status to signedIn only, and builds a 200 KiB context', () => {
  const help = [
    'Options:',
    '  -p, --print                           Print response and exit',
    '  --allowedTools, --allowed-tools <tools...>',
    '  --bare                                Minimal mode. Explicitly provide context via: --system-prompt[-file],',
    '                                        --append-system-prompt[-file], --add-dir',
    '  --verbose                             Override verbose mode'
  ].join('\n');
  const flags = probe.helpFlagsOf(help);
  assert.equal(flags['-p'], true);
  assert.equal(flags['--allowedTools'], true);
  assert.equal(flags['--verbose'], true);
  assert.equal(flags['--restricted'], false);
  assert.equal('--safe-mode' in flags, false, 'D-B15: --safe-mode is not pinned');
  assert.equal(flags['--append-system-prompt-file'], true, 'named in any form');
  assert.equal(probe.helpFlagsOf('  --append-system-prompt <p>   x')['--append-system-prompt-file'], false);

  const signedIn = fs.readFileSync(path.join(FIX, 'auth-status.signed-in.json'), 'utf8');
  for (const f of ['auth-status.signed-in.json', 'auth-status.signed-out.json']) JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  assert.equal(probe.parseSignedIn(signedIn), 'yes');
  assert.equal(probe.parseSignedIn(fs.readFileSync(path.join(FIX, 'auth-status.signed-out.json'), 'utf8')), 'no');
  assert.equal(probe.parseSignedIn(fs.readFileSync(path.join(FIX, 'auth-status.unreachable.txt'), 'utf8')), 'unknown');
  assert.equal(probe.parseSignedIn(''), 'unknown');
  assert.equal(probe.parseSignedIn('{"loggedIn":"yes"}'), 'unknown');
  // only the three-valued answer leaves the parse: nothing of the identity is returned
  assert.ok(!JSON.stringify(probe.parseSignedIn(signedIn)).includes('example.invalid'));

  const ctx = probe.makeContext(200 * 1024, 'CTX-T');
  assert.equal(Buffer.byteLength(ctx), 200 * 1024);
  assert.ok(ctx.includes('CTX-T-START') && ctx.includes('CTX-T-END'));
  assert.equal(probe.userText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }), 'a\nc');
});

test('HN6: detectPlants sees every kind of sign a plant gives, and nothing on a clean run', async () => {
  const h = await H.start({ home: 'fake', model: 'mock', proxy: 'deny-all', mcp: 'recorder', bin: null });
  try {
    const clean = { events: [{ type: 'system', subtype: 'init', model: 'm', mcp_servers: [{ name: 'nexus', status: 'connected' }], plugins: [{ name: 'builtin-x' }], agents: ['Explore'], skills: [], slash_commands: [] }] };
    assert.deepEqual(h.detectPlants(clean), []);
    // canary text and a canary model in a request to the mock
    await post(`${h.mock.url}/v1/messages`, { model: H.modelCanary(h.canaries.wtLocalSettings), system: `x ${h.canaries.homeMemory}`, messages: [{ role: 'user', content: 'hi' }] });
    // a hook marker and a stray MCP request
    fs.writeFileSync(path.join(h.markerDir, 'home-SessionStart.txt'), 'ran');
    await post(`${h.strayMcpUrl}/home-user`, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    const run = { events: [{ type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'init', model: 'm', mcp_servers: [{ name: 'home-canary', status: 'failed' }], plugins: [{ name: 'home-canary-plugin' }], agents: ['wt-canary'], skills: ['home-canary'], slash_commands: ['wt-canary'] }] };
    const plants = h.detectPlants(run).map((d) => d.plant);
    for (const p of ['homeMemory', 'wtLocalSettings', 'hook:home-SessionStart', 'mcp:/stray/home-user', 'mcp:home-canary', 'plugin:home-canary-plugin', 'agent:wt-canary', 'skill:"home-canary"', 'command:wt-canary', 'hook-event:hook_started']) {
      assert.ok(plants.includes(p), `detects ${p}: ${JSON.stringify(plants)}`);
    }
  } finally { await h.stop(); }
});
