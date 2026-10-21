#!/usr/bin/env node
'use strict';
// B2b Task 0: the agent CLI feasibility probe. It proves, on the installed binary, what the adapter relies on,
// and never reaches a model:
//   P-A  answers from a loopback mock model, with a fake home and a fake key  (checks P0-P6, P8, P10, CR3+)
//   P-B  sends the CLI's real API traffic to a recording proxy that refuses every CONNECT        (P7)
//   P-C  reads the login state only, through a deny-all proxy; CONTROLLER ONLY, with the user's go-ahead (P9)
//
// P-A and P-B run only through test/helpers/agentHarness.cjs (decision D-B12). P-C is the one part that reads
// the real home, so it needs both `--parts C` and `--controller-go-ahead`, and it keeps nothing but `signedIn`.
//
// Usage: node tools/nexus-agent-probe.cjs --parts A,B [--out <dir>]
//        node tools/nexus-agent-probe.cjs --parts C --controller-go-ahead [--out <dir>]
// Writes <out>/task0-probe-report.json and .md (default out: .superpowers/sdd/2026-10-21-nexus-b2b), merging a
// later part into an existing report. Exit 0 when no STOP branch fired, 2 when one did, 1 on a probe error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const H = require(path.join(ROOT, 'test', 'helpers', 'agentHarness.cjs'));
const M = require(path.join(ROOT, 'test', 'helpers', 'mockModel.cjs'));
const proxyRecorder = require(path.join(ROOT, 'test', 'helpers', 'proxyRecorder.cjs'));
const FIX = path.join(ROOT, 'test', 'fixtures', 'agent', 'probe');
const DEFAULT_OUT = path.join(ROOT, '.superpowers', 'sdd', '2026-10-21-nexus-b2b');
const P7_WINDOW_MS = 30_000;
const ARGV_LIMIT = 8 * 1024;
const CONTEXT_BYTES = 200 * 1024;

// ---------------------------------------------------------------- pure helpers (exported for the self-test)

/** Which flags `--help` lists. An option line starts with whitespace then a dash; aliases are comma-separated. */
function helpFlagsOf(helpText) {
  const listed = new Set();
  for (const line of String(helpText).split(/\r?\n/)) {
    const m = /^\s{1,8}(-[^<\[]*?)(?:\s{2,}|\s<|\s\[|$)/.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const f = part.trim().split(/\s+/)[0];
      if (/^--?[A-Za-z]/.test(f)) listed.add(f);
    }
  }
  const out = {};
  for (const f of H.PINNED_FLAGS) out[f] = listed.has(f);
  // `--append-system-prompt[-file]` in any form: listed, or named in the help text in either spelling.
  out[H.SKILLS_FILE_FLAG] = listed.has(H.SKILLS_FILE_FLAG) || /--append-system-prompt(?:\[-file\]|-file(?![\w-]))/.test(String(helpText));
  return out;
}

/**
 * The adapter's parse of `auth status`: 'yes' | 'no' | 'unknown'. Nothing else of the output is kept.
 * JSON with a boolean `loggedIn` decides; anything else (no JSON, a network error, a timeout) is 'unknown'.
 */
function parseSignedIn(stdout) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return 'unknown';
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    if (v && typeof v.loggedIn === 'boolean') return v.loggedIn ? 'yes' : 'no';
  } catch { /* fallthrough */ }
  return 'unknown';
}

/** A deterministic context of exactly `bytes` ASCII bytes, with a canary at both ends. */
function makeContext(bytes, canary) {
  const head = `<nexus-context>\n${canary}-START\n`;
  const tail = `\n${canary}-END\n</nexus-context>\n`;
  const lines = [];
  let size = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (let i = 0; size < bytes; i++) {
    const l = `context line ${String(i).padStart(6, '0')} ${crypto.createHash('sha256').update(String(i)).digest('hex').slice(0, 40)}\n`;
    lines.push(l);
    size += l.length;
  }
  let body = lines.join('');
  const over = Buffer.byteLength(head) + Buffer.byteLength(body) + Buffer.byteLength(tail) - bytes;
  if (over > 0) body = body.slice(0, body.length - over);
  return head + body + tail;
}

/** All text of the user messages in a recorded body, joined. */
function userText(body) {
  const out = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') out.push(m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'text') out.push(String(b.text ?? ''));
  }
  return out.join('\n');
}

/** Files under dir whose bytes contain needle (relative paths). */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else if (e.isFile()) { try { if (fs.readFileSync(p).includes(needle)) hits.push(path.relative(dir, p).split(path.sep).join('/')); } catch { /* unreadable */ } }
    }
  };
  walk(dir);
  return hits;
}

// ---------------------------------------------------------------- probe parts

const readFix = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const initOf = (r) => r.events.find((e) => e && e.type === 'system' && e.subtype === 'init') ?? null;
const resultOf = (r) => r.events.find((e) => e && e.type === 'result') ?? null;
const short = (s, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The tool_result for a given tool_use id, from the mock's requests (latest wins). */
function resultFor(mock, id) {
  let found = null;
  for (const q of mock.toolRequests()) for (const t of M.toolResults(q.body)) if (t.toolUseId === id) found = t;
  return found;
}

/** One harness, one turn. `make(h)` returns { args, stdin, timeoutMs }. Always stops the harness. */
async function withTurn(harnessOpts, make, inspect) {
  const h = await H.start({ home: 'fake', mcp: 'recorder', ...harnessOpts });
  try {
    const before = h.home.snapshot();
    const { args, stdin, timeoutMs } = make(h);
    const r = await h.run(args, { stdin, timeoutMs: timeoutMs ?? 90_000 });
    return await inspect(h, r, before);
  } finally {
    await h.stop();
  }
}

function pinnedJob(h, { settingsFile = 'settings.deny.json', skills = true } = {}) {
  const skillsText = skills ? readFix('skills.md').replace('{{SKILLS_CANARY}}', h.canaries.skills) : null;
  return h.writeJobFiles({ settings: JSON.parse(readFix(settingsFile)), skillsText });
}

const textTurn = (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null);
/** Root-relative writes of one run, each with whether it holds the MCP token. */
const writesWithToken = (h, writes) => writes.map((w) => {
  let token = false;
  try { token = fs.readFileSync(path.join(h.root, w.rel)).includes(h.token); } catch { /* gone */ }
  return { ...w, token };
});

/**
 * CR3+ (D-B15): which planted customizations are live. Each group names a plant and the sign it gives when it
 * loads or runs (see agentHarness.detectPlants). A control run without the locks must light up the groups,
 * which proves the plants work; the pinned run must light up none.
 */
const PLANT_GROUPS = [
  ['home CLAUDE.md', (d) => d.plant === 'homeMemory'],
  ['home rules', (d) => d.plant === 'homeRules'],
  ['worktree CLAUDE.md', (d) => d.plant === 'wtMemory'],
  ['worktree .claude/CLAUDE.md', (d) => d.plant === 'wtDotMemory'],
  ['worktree CLAUDE.local.md', (d) => d.plant === 'wtLocalMemory'],
  ['home skill', (d) => d.plant === 'homeSkill' || d.plant === 'skill:"home-canary"'],
  ['worktree skill', (d) => d.plant === 'wtSkill' || d.plant === 'skill:"wt-canary"'],
  ['home agent', (d) => d.plant === 'homeAgent' || d.plant === 'agent:home-canary'],
  ['worktree agent', (d) => d.plant === 'wtAgent' || d.plant === 'agent:wt-canary'],
  ['home command', (d) => d.plant === 'homeCommand' || d.plant === 'command:home-canary'],
  ['worktree command', (d) => d.plant === 'wtCommand' || d.plant === 'command:wt-canary'],
  ['user settings hooks', (d) => /^hook:home-(?!canary-plugin)/.test(d.plant) || d.plant === 'homeHook'],
  ['project settings hooks', (d) => /^hook:wt-(?!canary-plugin)/.test(d.plant) || d.plant === 'wtHook'],
  ['local settings', (d) => d.plant === 'wtLocalSettings'],
  ['user MCP server', (d) => /^mcp:(\/stray\/home-user|home-canary)$/.test(d.plant)],
  ['project MCP server (.mcp.json)', (d) => /^mcp:(\/stray\/wt-project|wt-canary)$/.test(d.plant)],
  ['local MCP server', (d) => /^mcp:(\/stray\/wt-local|wt-local-canary)$/.test(d.plant)],
  ['home plugin', (d) => d.plant === 'plugin:home-canary-plugin' || d.plant === 'homePlugin'],
  ['worktree plugin', (d) => d.plant === 'plugin:wt-canary-plugin' || d.plant === 'wtPlugin'],
  ['plugin hooks', (d) => /^hook:(home|wt)-canary-plugin-/.test(d.plant)],
  ['plugin MCP servers', (d) => /^mcp:(\/stray\/(home|wt)-plugin|plugin:)/.test(d.plant)]
];
const liveGroups = (found) => PLANT_GROUPS.filter(([, t]) => found.some(t)).map(([n]) => n);

async function partA(report, log) {
  const checks = [];
  const decisions = [];
  const observed = {};
  const add = (c) => { checks.push(c); log(`${c.id} ${c.result}: ${c.detail}`); };

  // P0 + P1 (version and flags), in a fake home with no model and a deny-all proxy.
  await withTurn({ model: 'none', proxy: 'deny-all' }, () => ({ args: ['--version'], timeoutMs: 60_000 }), async (h, v) => {
    const versionText = v.stdout.trim();
    const m = /^(\d+\.\d+\.\d+)/.exec(versionText);
    report.cliVersion = m ? m[1] : (versionText || null);
    const ok = v.code === 0 && H.VERSION_RE.test(versionText);
    add({ id: 'P0', result: ok ? 'pass' : 'fail', detail: `--version printed "${short(versionText, 80)}" (exit ${v.code}); expected ^2\\.1\\.\\d+` });
    decisions.push({ id: 'P0', branch: ok ? 'pinned-2.1.x' : 'STOP:S1' });
    const hp = await h.run(['--help'], { timeoutMs: 60_000 });
    report.helpFlags = helpFlagsOf(hp.stdout);
    const missing = H.PINNED_FLAGS.filter((f) => !report.helpFlags[f]);
    add({ id: 'P1', result: hp.code === 0 && missing.length === 0 ? 'pass' : 'fail', detail: (missing.length ? `missing pinned flags: ${missing.join(' ')}` : `all ${H.PINNED_FLAGS.length} pinned flags listed (--safe-mode is no longer pinned: D-B15)`) + `; ${H.SKILLS_FILE_FLAG} ${report.helpFlags[H.SKILLS_FILE_FLAG] ? 'named in --help (in the --bare text: "--append-system-prompt[-file]"; not a separate option line)' : 'absent'}` });
    decisions.push({ id: 'P1', branch: missing.length === 0 ? 'all-pinned-flags' : 'STOP:S1' });
    observed.p0p1ProxyHosts = h.proxy.hosts();
  });

  // P2 (D-B15: no --safe-mode): the recorder must get initialize + tools/list, the model the tool.
  const p2 = await withTurn({ model: 'mock', proxy: 'recorder', script: textTurn },
    (h) => { pinnedJob(h); return { args: h.argvBase, stdin: 'Reply with one word.' }; },
    async (h, r) => {
      const init = initOf(r);
      const tools = h.mock.toolRequests().flatMap((q) => M.toolNames(q.body));
      return { code: r.code, mcpServers: init?.mcp_servers ?? null, methods: h.mcp.methods(), hasTool: tools.includes('mcp__nexus__context_get') };
    });
  const p2ok = p2.methods.includes('initialize') && p2.methods.includes('tools/list') && p2.hasTool;
  add({ id: 'P2', result: p2ok ? 'pass' : 'fail', detail: `pinned argv without --safe-mode (D-B15): exit ${p2.code}, system/init mcp_servers=${JSON.stringify(p2.mcpServers)}, MCP recorder saw ${JSON.stringify(p2.methods)}, mock tool list ${p2.hasTool ? 'has' : 'lacks'} mcp__nexus__context_get` });
  decisions.push({ id: 'P2', branch: p2ok ? 'mcp-loaded (D-B15: no --safe-mode)' : 'STOP:S2' });

  // P3: --settings deny on Read(**/.env*); a control run without the deny shows the rule is what denies.
  const readEnvScript = (h) => (_b, s) => (s === 0 ? [{ type: 'tool_use', id: 'toolu_probe_read_env', name: 'Read', input: { file_path: path.join(h.worktree, '.env') } }] : s === 1 ? [{ type: 'text', text: 'done' }] : null);
  const p3run = (settingsFile) => withTurn({ model: 'mock', proxy: 'recorder' },
    (h) => { h.mock.setScript(readEnvScript(h)); pinnedJob(h, { settingsFile }); return { args: h.argvBase, stdin: 'Read the .env file.' }; },
    async (h, r) => ({ code: r.code, result: resultFor(h.mock, 'toolu_probe_read_env'), leaked: h.mock.requests.some((q) => q.raw.includes(h.canaries.envSecret)) }));
  const p3 = await p3run('settings.deny.json');
  const p3ctl = await p3run('settings.no-deny.json');
  const denied = !!p3.result && !p3.leaked && (p3.result.isError || /denied|not allowed|permission/i.test(p3.result.text));
  const ctlAllowed = !!p3ctl.result && p3ctl.leaked;
  add({
    id: 'P3', result: denied ? 'pass' : 'fail',
    detail: `with the deny rule: ${p3.result ? `tool_result is_error=${p3.result.isError} "${short(p3.result.text, 160)}"` : 'no tool_result reached the mock'}, secret ${p3.leaked ? 'LEAKED to the mock' : 'not sent'}. ` +
      `Control without the rule: ${p3ctl.result ? `is_error=${p3ctl.result.isError}` : 'no tool_result'}, secret ${p3ctl.leaked ? 'read (so the deny rule is what refused it)' : 'not read (control inconclusive)'}`
  });
  decisions.push({ id: 'P3', branch: denied ? (ctlAllowed ? 'settings-deny-applies' : 'settings-deny-applies (control inconclusive)') : 'STOP:S3' });

  // P4 + P10: prompt delivery and isolation; the same first turn in a fresh home records every write.
  const p4turn = (useSkillsFlag) => withTurn({ model: 'mock', proxy: 'recorder', script: textTurn },
    (h) => {
      const f = pinnedJob(h);
      return { args: useSkillsFlag ? [...h.argvBase, H.SKILLS_FILE_FLAG, f.skillsMd] : [...h.argvBase], stdin: `<nexus-preamble>\n${h.canaries.preamble}\n</nexus-preamble>\nReply with one word.` };
    },
    async (h, r) => {
      const first = h.mock.toolRequests()[0] ?? h.mock.messageRequests()[0] ?? null;
      const sys = first ? M.systemText(first.body) : '';
      const all = h.mock.requests.map((q) => q.raw).join('\n');
      return {
        code: r.code, requests: h.mock.requests.length,
        skillsInSystem: sys.includes(h.canaries.skills), skillsAnywhere: all.includes(h.canaries.skills),
        preambleInUser: first ? userText(first.body).includes(h.canaries.preamble) : false,
        preambleInSystem: sys.includes(h.canaries.preamble),
        leaks: [...new Set(h.detectPlants(r).map((d) => `${d.plant} (${d.via})`))],
        writes: writesWithToken(h, r.writes)
      };
    });
  let p4 = await p4turn(true);
  const skillsFlagWorks = p4.code === 0 && p4.skillsInSystem;
  if (p4.code !== 0 || p4.requests === 0) p4 = { ...(await p4turn(false)), skillsFlagRejected: true };
  const p4iso = p4.leaks.length === 0;
  add({
    id: 'P4', result: p4iso && p4.preambleInUser && skillsFlagWorks ? 'pass' : 'fail',
    detail: `skills-file canary ${p4.skillsInSystem ? 'in the system prompt' : p4.skillsAnywhere ? 'in the request but not the system prompt' : 'absent'}${p4.skillsFlagRejected ? ` (${H.SKILLS_FILE_FLAG} rejected)` : ''}; ` +
      `stdin preamble canary ${p4.preambleInUser ? 'in the first user message' : 'absent'}${p4.preambleInSystem ? ' and the system prompt' : ' (not the system prompt: stdin is the user turn)'}; ` +
      `home/worktree plants seen: ${p4.leaks.length ? p4.leaks.join(', ') : 'none'}`
  });
  decisions.push({ id: 'P4', branch: !p4iso ? 'STOP:S4' : 'isolated' });
  decisions.push({ id: 'skillsDelivery', branch: report.helpFlags?.[H.SKILLS_FILE_FLAG] && skillsFlagWorks ? 'append-system-prompt-file' : 'stdin-preamble' });
  const tokenFiles = p4.writes.filter((w) => w.token).map((w) => w.rel);
  add({ id: 'P10', result: tokenFiles.length ? 'fail' : 'pass', detail: `${p4.writes.length} file(s) written under the harness root in one pinned turn: ${p4.writes.map((f) => `${f.rel} (${f.change}, ${f.size} B)`).join(', ') || 'none'}; MCP token in any written file: ${tokenFiles.length ? tokenFiles.join(', ') : 'none'}` });
  observed.homeWrites = p4.writes.filter((w) => w.rel.startsWith('home/')).map((w) => ({ ...w, rel: w.rel.slice('home/'.length) }));
  observed.allWrites = p4.writes;
  decisions.push({ id: 'P10', branch: 'recorded' });

  // CR3+ (D-B15): plants in the fake home and the worktree (CLAUDE.md, rules, skills, agents, commands, user/project/
  // local settings with hooks, user/project/local MCP servers, user and project plugins with hooks and MCP servers).
  // A control run without the locks proves the plants are live; the pinned run must show none of them.
  const cr3Script = (h) => (_b, s) => (s === 0 ? [{ type: 'tool_use', id: 'toolu_cr3_read', name: 'Read', input: { file_path: path.join(h.worktree, 'README.md') } }] : s === 1 ? [{ type: 'text', text: 'done' }] : null);
  const CONTROL_ARGV = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--allowedTools', 'Read', '--no-session-persistence'];
  const cr3run = (locked, harnessExtra = {}) => withTurn({ model: 'mock', proxy: 'recorder', ...harnessExtra },
    (h) => { h.mock.setScript(cr3Script(h)); pinnedJob(h); return { args: locked ? h.argvBase : CONTROL_ARGV, stdin: 'Read the README.' }; },
    async (h, r) => {
      const found = h.detectPlants(r);
      return {
        code: r.code, requests: h.mock.requests.length, found: [...new Set(found.map((d) => `${d.plant} (${d.via})`))], live: liveGroups(found),
        writes: writesWithToken(h, r.writes), mcpNexus: h.mcp.methods().includes('initialize')
      };
    });
  const ctl = await cr3run(false);
  const lk = await cr3run(true);
  const notLive = PLANT_GROUPS.map(([n]) => n).filter((n) => !ctl.live.includes(n));
  const cr3ok = lk.code === 0 && lk.requests > 0 && lk.found.length === 0;
  const wtWrites = (w) => w.filter((x) => x.rel.startsWith('wt/')).map((x) => `${x.rel} (${x.change})`);
  // The worktree write seen under the locks comes from the planted ~/.claude.json project entry; a fresh home without it:
  const lkFresh = await cr3run(true, { homeFiles: { '.claude.json': { hasCompletedOnboarding: true } } });
  add({
    id: 'CR3+', result: cr3ok ? 'pass' : 'fail',
    detail: `control (no locks): exit ${ctl.code}, ${ctl.live.length}/${PLANT_GROUPS.length} plant groups live (${ctl.live.join('; ')})${notLive.length ? `; NOT proven live: ${notLive.join('; ')}` : ''}. ` +
      `Pinned argv: exit ${lk.code}, ${lk.requests} mock request(s), Nexus MCP ${lk.mcpNexus ? 'connected' : 'NOT connected'}, plants seen: ${lk.found.length ? lk.found.join(', ') : 'none'}. ` +
      `Worktree writes under the locks: ${wtWrites(lk.writes).join(', ') || 'none'}; with no project entry in ~/.claude.json: ${wtWrites(lkFresh.writes).join(', ') || 'none'}`
  });
  decisions.push({ id: 'CR3+', branch: cr3ok ? 'no-customization-loads' : 'STOP:S4' });
  observed.cr3 = { controlLive: ctl.live, controlNotLive: notLive, lockedFound: lk.found, lockedWrites: lk.writes, controlWrites: ctl.writes, lockedFreshHomeWrites: lkFresh.writes };

  // P5 + P6: the tool allow-list, an Edit inside cwd, an MCP call, the bearer header.
  const p5 = await withTurn({ model: 'mock', proxy: 'recorder', onCall: (name) => `ctx-ok:${name}` },
    (h) => {
      const target = path.join(h.worktree, 'src', 'app.txt');
      h.mock.setScript((_b, s) => [
        [{ type: 'tool_use', id: 'toolu_probe_read', name: 'Read', input: { file_path: target } }],
        [{ type: 'tool_use', id: 'toolu_probe_edit', name: 'Edit', input: { file_path: target, old_string: 'hello from the worktree', new_string: 'edited by the probe' } }],
        [{ type: 'tool_use', id: 'toolu_probe_mcp', name: 'mcp__nexus__context_get', input: {} }],
        [{ type: 'text', text: 'done' }]
      ][s] ?? null);
      pinnedJob(h);
      return { args: h.argvBase, stdin: 'Edit src/app.txt, then read the context.' };
    },
    async (h, r) => {
      const init = initOf(r);
      const edit = resultFor(h.mock, 'toolu_probe_edit');
      const mcpRes = resultFor(h.mock, 'toolu_probe_mcp');
      const fileNow = fs.readFileSync(path.join(h.worktree, 'src', 'app.txt'), 'utf8');
      const initRec = h.mcp.records.find((x) => x.method === 'initialize');
      return {
        code: r.code, initTools: init?.tools ?? null, offered: [...new Set(h.mock.toolRequests().flatMap((q) => M.toolNames(q.body)))],
        editOk: !!edit && !edit.isError && fileNow.includes('edited by the probe'), edit,
        mcpCalled: h.mcp.calls().some((c) => c.params?.name === 'context_get'), mcpRes,
        mcpOk: !!mcpRes && !mcpRes.isError && /ctx-ok:context_get/.test(mcpRes.text),
        auth: initRec ? (initRec.headers.authorization === `Bearer ${h.token}` ? 'expanded' : initRec.headers.authorization ? 'other-value' : 'absent') : 'no-initialize',
        tokenInArgv: [h.bin, ...h.argvBase].join(' ').includes(h.token),
        tokenInRootFiles: filesContaining(h.root, h.token).filter((f) => !f.startsWith('job/')),
        tokenInStdout: r.stdout.includes(h.token) || r.stderr.includes(h.token),
        writes: writesWithToken(h, r.writes)
      };
    });
  const banned = [...H.DISALLOWED_TOOLS];
  const offeredBanned = banned.filter((t) => (p5.initTools ?? []).includes(t) || p5.offered.includes(t));
  const p5ok = p5.editOk && p5.mcpOk && offeredBanned.length === 0;
  add({
    id: 'P5', result: p5ok ? 'pass' : 'fail',
    detail: `--disallowedTools ${banned.join(' ')}; system/init tools=${JSON.stringify(p5.initTools)}; Edit ${p5.editOk ? 'succeeded (file changed)' : `failed: ${p5.edit ? short(p5.edit.text, 160) : 'no tool_result'}`}; ` +
      `MCP context_get ${p5.mcpOk ? 'succeeded' : `failed: ${p5.mcpRes ? short(p5.mcpRes.text, 200) : 'no tool_result'}${p5.mcpCalled ? '' : ' (never reached the recorder)'}`}; ` +
      `disallowed tools offered: ${offeredBanned.length ? offeredBanned.join(',') : 'none'}`
  });
  decisions.push({ id: 'P5', branch: p5ok ? 'as-pinned' : 'STOP:S5' });
  // The exact built-in tool names: everything `--tools default` offers without --restricted (which removes Bash and WebFetch
  // itself), with no settings sources and no MCP; the mock answers text only.
  const allTools = await withTurn({ model: 'mock', proxy: 'recorder', script: textTurn },
    (h) => ({ args: ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', H.SETTING_SOURCES_FORM, '--tools', 'default', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'], stdin: 'Reply with one word.' }),
    async (_h, r) => initOf(r)?.tools ?? null);
  observed.builtinToolsDefault = allTools;
  observed.builtinToolsPinned = p5.initTools;
  const has = (t) => Array.isArray(allTools) && allTools.includes(t);
  decisions.push({ id: 'toolNames', branch: `pinned:${JSON.stringify({ allowed: p5.initTools, disallowed: banned, offeredByThisBuild: banned.filter(has), notInThisBuild: banned.filter((t) => !has(t)) })}` });
  const p6ok = p5.auth === 'expanded' && !p5.tokenInArgv;
  add({ id: 'P6', result: p5.auth === 'no-initialize' ? 'n/a' : p6ok ? 'pass' : 'fail', detail: `Authorization header from \${NEXUS_MCP_TOKEN}: ${p5.auth}; token in argv: ${p5.tokenInArgv ? 'YES' : 'no'}; token in any file under the harness root outside the job dir: ${p5.tokenInRootFiles.length ? p5.tokenInRootFiles.join(', ') : 'none'}; token in CLI output: ${p5.tokenInStdout ? 'YES' : 'no'}` });
  decisions.push({ id: 'mcpHeaderForm', branch: p6ok ? 'env-expansion' : 'literal-in-job-file' });
  observed.p5Writes = p5.writes;

  // P8: a 200 KiB context on stdin; argv stays small and the whole context reaches the mock.
  const p8 = await withTurn({ model: 'mock', proxy: 'recorder', script: textTurn },
    (h) => {
      const f = pinnedJob(h);
      const ctx = makeContext(CONTEXT_BYTES, `CTX-CANARY-${crypto.randomBytes(4).toString('hex')}`);
      h.__ctx = ctx;
      return { args: [...h.argvBase, ...(decisions.find((d) => d.id === 'skillsDelivery')?.branch === 'append-system-prompt-file' ? [H.SKILLS_FILE_FLAG, f.skillsMd] : [])], stdin: `${ctx}\nReply with one word.` };
    },
    async (h, r) => {
      const first = h.mock.toolRequests()[0] ?? h.mock.messageRequests()[0] ?? null;
      const ut = first ? userText(first.body) : '';
      return { code: r.code, argvBytes: r.argvBytes, intact: ut.includes(h.__ctx), ctxBytes: Buffer.byteLength(h.__ctx), userBytes: Buffer.byteLength(ut) };
    });
  const p8ok = p8.argvBytes < ARGV_LIMIT && p8.intact;
  add({ id: 'P8', result: p8ok ? 'pass' : 'fail', detail: `argv ${p8.argvBytes} bytes (limit ${ARGV_LIMIT}); a ${p8.ctxBytes}-byte context on stdin ${p8.intact ? 'reached the mock intact' : `did NOT reach the mock intact (user text ${p8.userBytes} bytes)`}` });
  decisions.push({ id: 'P8', branch: p8ok ? 'stdin-context' : 'STOP:S8' });
  decisions.push({ id: 'settingSourcesForm', branch: JSON.stringify(H.SETTING_SOURCES_FORM) });
  decisions.push({ id: 'safeMode', branch: 'dropped (D-B15)' });

  return { checks, decisions, observed };
}

async function partB(log) {
  const checks = [];
  const decisions = [];
  const observed = {};
  const one = async () => {
    const h = await H.start({ home: 'fake', model: 'none', proxy: 'recorder', mcp: 'recorder' });
    try {
      pinnedJob(h);
      const args = h.argvBase;
      const r = await h.run(args, { stdin: 'Reply with one word.', timeoutMs: P7_WINDOW_MS });
      const res = resultOf(r);
      return {
        code: r.code, killedAtWindow: r.timedOut, ms: r.ms, hosts: h.proxy.hosts(), connects: h.proxy.connects.length,
        plainRequests: h.proxy.requests.length, mcpMethods: h.mcp.methods(),
        error: (() => {
          if (res) return short(res.result ?? res.subtype ?? '', 200);
          const retries = r.events.filter((e) => e && e.type === 'system' && e.subtype === 'api_retry');
          const last = retries[retries.length - 1];
          if (last) return `${retries.length} api_retry event(s), last attempt ${last.attempt}/${last.max_retries}, error=${last.error}, status=${last.error_status}`;
          return short(r.stderr || r.stdout.split(/\r?\n/).filter(Boolean).slice(-1)[0], 200);
        })(),
        writes: r.writes.map((w) => w.rel),
        hasBaseUrl: Object.prototype.hasOwnProperty.call(h.env, 'ANTHROPIC_BASE_URL')
      };
    } finally { await h.stop(); }
  };
  const b = await one();
  const onlyApi = b.hosts.length > 0 && b.hosts.every((x) => x === 'api.anthropic.com:443');
  const others = b.hosts.filter((x) => x !== 'api.anthropic.com:443');
  const mcpReached = b.mcpMethods.includes('initialize');
  let branch;
  if (b.connects === 0 && b.plainRequests === 0) branch = 'STOP:S6';
  else if (others.length) branch = `STOP:S7 (${others.join(', ')})`;
  else branch = mcpReached ? 'proxy-honoured' : 'STOP:S6 (the MCP server was not reached directly)';
  checks.push({
    id: 'P7', result: onlyApi && mcpReached ? 'pass' : 'fail',
    detail: `no ANTHROPIC_BASE_URL (${b.hasBaseUrl ? 'SET — probe bug' : 'unset'}), fake key, HTTPS_PROXY=recorder, NO_PROXY=127.0.0.1: ` +
      `${b.connects} CONNECT(s) to ${JSON.stringify(b.hosts)} within ${Math.round(b.ms / 1000)} s (${b.killedAtWindow ? 'stopped at the 30 s window' : `exited ${b.code}`}); ` +
      `plain proxy requests: ${b.plainRequests}; MCP recorder reached directly: ${mcpReached ? 'yes' : `no (${JSON.stringify(b.mcpMethods)})`}; CLI said: "${b.error}"`
  });
  decisions.push({ id: 'P7', branch });
  observed.p7 = b;
  log(`P7 ${checks[0].result}: ${checks[0].detail}`);
  return { checks, decisions, observed };
}

/** P-C: controller only. Reads the real home's login state through a deny-all proxy; keeps only `signedIn`. */
async function partC(log) {
  const bin = H.resolveCli();
  if (!bin) return { checks: [{ id: 'P9', result: 'n/a', detail: 'the agent CLI is not installed' }], decisions: [{ id: 'P9', branch: 'not-checked-yet' }], observed: {} };
  const proxy = await proxyRecorder.start({ mode: 'deny-all' });
  try {
    const real = process.env;
    const sysRoot = real.SystemRoot ?? 'C:\\Windows';
    const env = {
      SystemRoot: sysRoot, windir: sysRoot, PATH: [path.join(sysRoot, 'System32'), sysRoot].join(';'),
      USERPROFILE: real.USERPROFILE, HOMEDRIVE: real.HOMEDRIVE, HOMEPATH: real.HOMEPATH, APPDATA: real.APPDATA, LOCALAPPDATA: real.LOCALAPPDATA,
      TEMP: real.TEMP, TMP: real.TMP, LANG: 'en_US.UTF-8', HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    };
    for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
    const out = await new Promise((resolve) => {
      const child = spawn(bin, ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const chunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30_000);
      child.once('error', () => { clearTimeout(timer); resolve(''); });
      child.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    const signedIn = parseSignedIn(out); // the raw output goes out of scope here; it is never printed or stored
    const check = { id: 'P9', result: signedIn === 'no' ? 'fail' : 'pass', detail: `signedIn=${signedIn}; deny-all proxy saw ${proxy.connects.length} CONNECT(s) to ${JSON.stringify(proxy.hosts())}` };
    log(`P9 ${check.result}: ${check.detail}`);
    return { checks: [check], decisions: [{ id: 'P9', branch: signedIn === 'yes' ? 'signed-in' : signedIn === 'no' ? 'user-signs-in-then-rerun' : 'not-checked-yet' }], observed: {} };
  } finally { await proxy.stop(); }
}

// ---------------------------------------------------------------- report

function mergeById(prev, next) {
  const map = new Map((prev ?? []).map((x) => [x.id, x]));
  for (const x of next) map.set(x.id, x);
  return [...map.values()];
}

function stopsOf(report) { return report.decisions.filter((d) => /^STOP/.test(d.branch)); }

function toMarkdown(report) {
  const lines = [];
  lines.push('# B2b Task 0: agent CLI feasibility probe — results', '');
  lines.push(`Generated by \`tools/nexus-agent-probe.cjs\` (parts ${report.meta.parts.join(',')}) at ${report.meta.generatedAt}. These are probe results, not code.`, '');
  lines.push(`- CLI version: \`${report.cliVersion}\``);
  const stops = stopsOf(report);
  lines.push(`- STOP branches fired: ${stops.length ? stops.map((s) => `**${s.branch}** (${s.id})`).join(', ') : 'none'}`, '');
  lines.push('## Checks', '', '| Id | Result | Detail |', '|---|---|---|');
  const order = ['P0', 'P1', 'P2', 'P3', 'P4', 'CR3+', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  for (const c of [...report.checks].sort((a, b) => rank(a.id) - rank(b.id))) lines.push(`| ${c.id} | ${c.result} | ${String(c.detail).replace(/\|/g, '\\|')} |`);
  lines.push('', '## Decisions', '', '| Id | Branch |', '|---|---|');
  for (const d of report.decisions) lines.push(`| ${d.id} | ${String(d.branch).replace(/\|/g, '\\|')} |`);
  lines.push('', '## Pinned flags in `--help`', '');
  for (const [f, ok] of Object.entries(report.helpFlags ?? {})) lines.push(`- \`${f}\`: ${ok ? 'listed' : 'MISSING'}`);
  const writeList = (title, ws) => {
    if (!Array.isArray(ws)) return;
    lines.push('', `## ${title}`, '');
    if (!ws.length) lines.push('- none');
    for (const f of ws) lines.push(`- \`${f.rel}\` (${f.change}, ${f.size} bytes, mtime ${f.mtimeMs}${f.token ? ', HOLDS THE MCP TOKEN' : ''})`);
  };
  writeList('P10: every file the CLI wrote under the harness root in one pinned turn (home = the fake home)', report.observed?.allWrites);
  writeList('P5: every file written in the pinned Edit + MCP turn', report.observed?.p5Writes);
  if (report.observed?.cr3) {
    const c = report.observed.cr3;
    lines.push('', '## CR3+: planted customizations (D-B15)', '');
    lines.push(`- Live in the control run (no locks): ${c.controlLive.join('; ')}`);
    lines.push(`- Not proven live in the control run: ${c.controlNotLive.length ? c.controlNotLive.join('; ') : 'none'}`);
    lines.push(`- Seen under the pinned argv: ${c.lockedFound.length ? c.lockedFound.join(', ') : 'none'}`);
    writeList('CR3+: files written under the pinned argv (with the planted ~/.claude.json project entry)', c.lockedWrites);
    writeList('CR3+: files written under the pinned argv (fresh ~/.claude.json, no project entry)', c.lockedFreshHomeWrites);
    writeList('CR3+: files written by the control run (no locks)', c.controlWrites);
  }
  lines.push('', '## Limits', '');
  lines.push('- P-A and P-B ran on a fake home only (decision D-B12). The write lists cover the fake home and the harness root; the real store (including the MCP log under the real LOCALAPPDATA) is measured in V3.');
  lines.push('- P9 (P-C) reads the real home and is run only by the controller with the user\'s go-ahead.');
  lines.push('- P7: every CONNECT was refused by the recording proxy, so no request left the machine.');
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const parts = String(get('--parts') ?? 'A,B').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const outDir = path.resolve(get('--out') ?? DEFAULT_OUT);
  if (parts.includes('C') && !argv.includes('--controller-go-ahead')) {
    console.error('Part C reads the real home: it runs only for the controller, with the user\'s go-ahead (--controller-go-ahead).');
    return 1;
  }
  if (!H.resolveCli()) { console.error('NOT RUN: the agent CLI is not installed.'); return 3; }
  const jsonPath = path.join(outDir, 'task0-probe-report.json');
  let report = { cliVersion: null, helpFlags: {}, checks: [], decisions: [] };
  try { report = { ...report, ...JSON.parse(fs.readFileSync(jsonPath, 'utf8')) }; } catch { /* new report */ }
  report.observed = report.observed ?? {};
  if (parts.includes('A') && parts.includes('B')) {
    // A full agent-side run replaces everything earlier except the controller's P9.
    report = { cliVersion: null, helpFlags: {}, checks: report.checks.filter((c) => c.id === 'P9'), decisions: report.decisions.filter((d) => d.id === 'P9'), observed: {}, meta: report.meta?.parts?.includes('C') ? { parts: ['C'] } : undefined };
  }
  const log = (s) => console.log(s);
  const results = [];
  if (parts.includes('A')) results.push(await partA(report, log));
  if (parts.includes('B')) results.push(await partB(log));
  if (parts.includes('C')) results.push(await partC(log));
  for (const r of results) {
    report.checks = mergeById(report.checks, r.checks);
    report.decisions = mergeById(report.decisions, r.decisions);
    Object.assign(report.observed, r.observed);
  }
  if (!report.checks.some((c) => c.id === 'P9')) {
    report.checks.push({ id: 'P9', result: 'n/a', detail: 'controller only (P-C reads the real home); not run by the task agent' });
    report.decisions.push({ id: 'P9', branch: 'pending:controller' });
  }
  const prevParts = report.meta?.parts ?? [];
  report.meta = { generatedAt: new Date().toISOString(), parts: [...new Set([...prevParts, ...parts])].sort(), platform: process.platform, node: process.version };
  const ordered = { cliVersion: report.cliVersion, helpFlags: report.helpFlags, checks: report.checks, decisions: report.decisions, meta: report.meta, observed: report.observed };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(ordered, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'task0-probe-report.md'), toMarkdown(ordered));
  const stops = stopsOf(ordered);
  console.log(stops.length ? `STOP: ${stops.map((s) => `${s.id} ${s.branch}`).join('; ')}` : 'no STOP branch fired');
  return stops.length ? 2 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e?.stack ?? e); process.exitCode = 1; });
}

module.exports = { helpFlagsOf, parseSignedIn, makeContext, userText, toMarkdown };
