#!/usr/bin/env node
'use strict';
// B2b Task 0: the agent CLI feasibility probe. It proves, on the installed binary, what the adapter relies on,
// and never reaches a model:
//   P-A  answers from a loopback mock model, with a fake home and a fake key      (checks P0-P6, P8, P10)
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
const dropFlag = (argv, flag) => argv.filter((a) => a !== flag);

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

const isolationCanaries = () => ['homeMemory', 'homeRules', 'homeSkill', 'homeAgent', 'homeSettings', 'wtMemory', 'wtDotMemory', 'wtLocalMemory', 'wtSkill', 'wtAgent', 'wtSettings', 'wtMcp'];

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
    add({ id: 'P1', result: hp.code === 0 && missing.length === 0 ? 'pass' : 'fail', detail: missing.length ? `missing pinned flags: ${missing.join(' ')}` : `all ${H.PINNED_FLAGS.length} pinned flags listed; ${H.SKILLS_FILE_FLAG} ${report.helpFlags[H.SKILLS_FILE_FLAG] ? 'named in --help (in the --bare text: "--append-system-prompt[-file]"; not a separate option line)' : 'absent'}` });
    decisions.push({ id: 'P1', branch: missing.length === 0 ? 'all-pinned-flags' : 'STOP:S1' });
    observed.p0p1ProxyHosts = h.proxy.hosts();
  });

  // P2: --safe-mode with the job mcp.json; the recorder must get initialize + tools/list, the model the tool.
  const p2 = await withTurn({ model: 'mock', proxy: 'recorder', script: (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null) },
    (h) => { pinnedJob(h); return { args: h.argvBase, stdin: 'Reply with one word.' }; },
    async (h, r) => {
      const init = initOf(r);
      const methods = h.mcp.methods();
      const tools = h.mock.toolRequests().flatMap((q) => M.toolNames(q.body));
      return { code: r.code, mcpServers: init?.mcp_servers ?? null, methods, hasTool: tools.includes('mcp__nexus__context_get'), stderr: short(r.stderr) };
    });
  // The same turn with only --safe-mode removed, so the evidence names the flag that drops the server.
  const p2diag = await withTurn({ model: 'mock', proxy: 'recorder', script: (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null) },
    (h) => { pinnedJob(h); return { args: dropFlag(h.argvBase, '--safe-mode'), stdin: 'Reply with one word.' }; },
    async (h, r) => {
      const init = initOf(r);
      return { code: r.code, mcpServers: init?.mcp_servers ?? null, methods: h.mcp.methods(), hasTool: h.mock.toolRequests().flatMap((q) => M.toolNames(q.body)).includes('mcp__nexus__context_get') };
    });
  const p2ok = p2.methods.includes('initialize') && p2.methods.includes('tools/list') && p2.hasTool;
  add({
    id: 'P2', result: p2ok ? 'pass' : 'fail',
    detail: `with --safe-mode: exit ${p2.code}, system/init mcp_servers=${JSON.stringify(p2.mcpServers)}, MCP recorder saw ${JSON.stringify(p2.methods)}, mock tool list ${p2.hasTool ? 'has' : 'lacks'} mcp__nexus__context_get. ` +
      `Same argv without --safe-mode: mcp_servers=${JSON.stringify(p2diag.mcpServers)}, recorder saw ${JSON.stringify(p2diag.methods)}, tool ${p2diag.hasTool ? 'present' : 'absent'}`
  });
  decisions.push({ id: 'P2', branch: p2ok ? 'safe-mode-keeps-mcp' : 'STOP:S2' });

  // P3: --settings deny on Read(**/.env*) under --safe-mode; a control run without the deny shows the rule is what denies.
  const readEnvScript = (h) => (_b, s) => (s === 0 ? [{ type: 'tool_use', id: 'toolu_probe_read_env', name: 'Read', input: { file_path: path.join(h.worktree, '.env') } }] : s === 1 ? [{ type: 'text', text: 'done' }] : null);
  const p3run = (settingsFile) => withTurn({ model: 'mock', proxy: 'recorder' },
    (h) => { h.mock.setScript(readEnvScript(h)); pinnedJob(h, { settingsFile }); return { args: h.argvBase, stdin: 'Read the .env file.' }; },
    async (h, r) => {
      const t = resultFor(h.mock, 'toolu_probe_read_env');
      const leaked = h.mock.requests.some((q) => q.raw.includes(h.canaries.envSecret));
      return { code: r.code, result: t, leaked };
    });
  const p3 = await p3run('settings.deny.json');
  const p3ctl = await p3run('settings.no-deny.json');
  const denied = !!p3.result && !p3.leaked && (p3.result.isError || /denied|not allowed|permission/i.test(p3.result.text));
  const ctlAllowed = !!p3ctl.result && p3ctl.leaked;
  add({
    id: 'P3', result: denied ? 'pass' : 'fail',
    detail: `with the deny rule: ${p3.result ? `tool_result is_error=${p3.result.isError} "${short(p3.result.text, 160)}"` : 'no tool_result reached the mock'}, secret ${p3.leaked ? 'LEAKED to the mock' : 'not sent'}. ` +
      `Control without the rule: ${p3ctl.result ? `is_error=${p3ctl.result.isError}` : 'no tool_result'}, secret ${p3ctl.leaked ? 'read (so the deny rule is what refused it)' : 'not read (control inconclusive)'}`
  });
  decisions.push({ id: 'P3', branch: denied ? (ctlAllowed ? 'safe-mode-keeps-settings' : 'safe-mode-keeps-settings (control inconclusive)') : 'STOP:S3' });

  // P4 + P10: prompt delivery and isolation; the same first turn in a fresh home records the home writes.
  const p4turn = (useSkillsFlag, extraDrop) => withTurn({ model: 'mock', proxy: 'recorder', script: (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null) },
    (h) => {
      const f = pinnedJob(h);
      let args = useSkillsFlag ? [...h.argvBase, H.SKILLS_FILE_FLAG, f.skillsMd] : [...h.argvBase];
      for (const d of extraDrop ?? []) args = dropFlag(args, d);
      return { args, stdin: `<nexus-preamble>\n${h.canaries.preamble}\n</nexus-preamble>\nReply with one word.` };
    },
    async (h, r, before) => {
      const first = h.mock.toolRequests()[0] ?? h.mock.messageRequests()[0] ?? null;
      const sys = first ? M.systemText(first.body) : '';
      const all = h.mock.requests.map((q) => q.raw).join('\n');
      const leaks = isolationCanaries(h.canaries).filter((k) => all.includes(h.canaries[k]));
      return {
        code: r.code, stderr: short(r.stderr), requests: h.mock.requests.length,
        skillsInSystem: sys.includes(h.canaries.skills), skillsAnywhere: all.includes(h.canaries.skills),
        preambleInUser: first ? userText(first.body).includes(h.canaries.preamble) : false,
        preambleInSystem: sys.includes(h.canaries.preamble),
        leaks, homeWrites: h.home.diff(before)
      };
    });
  let p4 = await p4turn(true);
  let skillsFlagWorks = p4.code === 0 && p4.skillsInSystem;
  if (p4.code !== 0 || p4.requests === 0) p4 = { ...(await p4turn(false)), skillsFlagRejected: true };
  const p4iso = p4.leaks.length === 0;
  add({
    id: 'P4', result: p4iso && p4.preambleInUser && skillsFlagWorks ? 'pass' : 'fail',
    detail: `skills-file canary ${p4.skillsInSystem ? 'in the system prompt' : p4.skillsAnywhere ? 'in the request but not the system prompt' : 'absent'}${p4.skillsFlagRejected ? ` (${H.SKILLS_FILE_FLAG} rejected)` : ''}; ` +
      `stdin preamble canary ${p4.preambleInUser ? 'in the first user message' : 'absent'}${p4.preambleInSystem ? ' and the system prompt' : ' (not the system prompt: stdin is the user turn)'}; ` +
      `home/worktree canaries in any request: ${p4.leaks.length ? p4.leaks.join(', ') : 'none'}`
  });
  decisions.push({ id: 'P4', branch: !p4iso ? 'STOP:S4' : 'isolated' });
  decisions.push({ id: 'skillsDelivery', branch: report.helpFlags?.[H.SKILLS_FILE_FLAG] && skillsFlagWorks ? 'append-system-prompt-file' : 'stdin-preamble' });
  add({ id: 'P10', result: 'pass', detail: `${p4.homeWrites.length} file(s) written to the fake home in one turn: ${p4.homeWrites.map((f) => `${f.rel} (${f.change})`).join(', ') || 'none'}` });
  observed.homeWrites = p4.homeWrites;
  decisions.push({ id: 'P10', branch: 'recorded' });

  // P5 + P6: the tool allow-list, an Edit inside cwd, an MCP call, the bearer header.
  const p5turn = (argvMut) => withTurn({ model: 'mock', proxy: 'recorder', onCall: (name) => `ctx-ok:${name}` },
    (h) => {
      const target = path.join(h.worktree, 'src', 'app.txt');
      h.mock.setScript((_b, s) => [
        [{ type: 'tool_use', id: 'toolu_probe_read', name: 'Read', input: { file_path: target } }],
        [{ type: 'tool_use', id: 'toolu_probe_edit', name: 'Edit', input: { file_path: target, old_string: 'hello from the worktree', new_string: 'edited by the probe' } }],
        [{ type: 'tool_use', id: 'toolu_probe_mcp', name: 'mcp__nexus__context_get', input: {} }],
        [{ type: 'text', text: 'done' }]
      ][s] ?? null);
      pinnedJob(h);
      return { args: argvMut(h.argvBase), stdin: 'Edit src/app.txt, then read the context.' };
    },
    async (h, r) => {
      const init = initOf(r);
      const offered = h.mock.toolRequests().flatMap((q) => M.toolNames(q.body));
      const edit = resultFor(h.mock, 'toolu_probe_edit');
      const mcpRes = resultFor(h.mock, 'toolu_probe_mcp');
      const fileNow = fs.readFileSync(path.join(h.worktree, 'src', 'app.txt'), 'utf8');
      const initRec = h.mcp.records.find((x) => x.method === 'initialize');
      const argvAll = [h.bin, ...argvMut(h.argvBase)].join(' ');
      return {
        code: r.code, initTools: init?.tools ?? null, offered: [...new Set(offered)],
        editOk: !!edit && !edit.isError && fileNow.includes('edited by the probe'), edit,
        mcpCalled: h.mcp.calls().some((c) => c.params?.name === 'context_get'), mcpRes,
        mcpOk: !!mcpRes && !mcpRes.isError && /ctx-ok:context_get/.test(mcpRes.text),
        auth: initRec ? (initRec.headers.authorization === `Bearer ${h.token}` ? 'expanded' : initRec.headers.authorization ? 'other-value' : 'absent') : 'no-initialize',
        tokenInArgv: argvAll.includes(h.token), result: resultOf(r),
        tokenInHomeFiles: filesContaining(h.home.dir, h.token), tokenInStdout: r.stdout.includes(h.token) || r.stderr.includes(h.token)
      };
    });
  const p5 = await p5turn((a) => a);
  // The brief's names plus `Task`: this build may name its subagent tool either way, and neither may be offered.
  const banned = ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'Task'];
  const offeredBanned = banned.filter((t) => (p5.initTools ?? []).includes(t) || p5.offered.includes(t));
  const p5ok = p5.editOk && p5.mcpOk && offeredBanned.length === 0;
  add({
    id: 'P5', result: p5ok ? 'pass' : 'fail',
    detail: `system/init tools=${JSON.stringify(p5.initTools)}; Edit ${p5.editOk ? 'succeeded (file changed)' : `failed: ${p5.edit ? short(p5.edit.text, 160) : 'no tool_result'}`}; ` +
      `MCP context_get ${p5.mcpOk ? 'succeeded' : `failed: ${p5.mcpRes ? short(p5.mcpRes.text, 200) : 'no tool_result'}${p5.mcpCalled ? '' : ' (never reached the recorder)'}`}; ` +
      `Bash/WebFetch/... offered: ${offeredBanned.length ? offeredBanned.join(',') : 'none'}`
  });
  const p5causeS2 = !p5ok && p5.editOk && offeredBanned.length === 0 && !p5.mcpCalled && !p2ok;
  decisions.push({ id: 'P5', branch: p5ok ? 'as-pinned' : p5causeS2 ? 'STOP:S5 (consequence of S2: the MCP server is absent under --safe-mode; Edit and the tool list are as pinned)' : 'STOP:S5' });
  // The exact built-in tool names: everything `--tools default` offers, in the same fake home, mock answering text only.
  const allTools = await withTurn({ model: 'mock', proxy: 'recorder', script: (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null) },
    (h) => ({ args: ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--strict-mcp-config', '--setting-sources', H.SETTING_SOURCES_FORM, '--tools', 'default', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'], stdin: 'Reply with one word.' }),
    async (_h, r) => initOf(r)?.tools ?? null);
  observed.builtinToolsDefault = allTools;
  observed.builtinToolsPinned = p5.initTools;
  const has = (t) => Array.isArray(allTools) && allTools.includes(t);
  const planned = ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'];
  const subagent = has('Agent') ? 'Agent' : has('Task') ? 'Task' : null;
  const disallowedObserved = [...planned.filter((t) => t !== 'Agent' && has(t)), ...(subagent ? [subagent] : [])];
  const notOffered = planned.filter((t) => !has(t));
  decisions.push({ id: 'toolNames', branch: `pinned:${JSON.stringify({ allowed: p5.initTools, disallowedObserved, subagentToolName: subagent, plannedNamesNotInThisBuild: notOffered })}` });
  const p6ok = p5.auth === 'expanded' && !p5.tokenInArgv;
  add({ id: 'P6', result: p5.auth === 'no-initialize' ? 'n/a' : p6ok ? 'pass' : 'fail', detail: `Authorization header from \${NEXUS_MCP_TOKEN}: ${p5.auth}; token in argv: ${p5.tokenInArgv ? 'YES' : 'no'}; token in fake-home files: ${p5.tokenInHomeFiles.length ? p5.tokenInHomeFiles.join(', ') : 'none'}; token in CLI output: ${p5.tokenInStdout ? 'YES' : 'no'}${p5.auth === 'no-initialize' ? ' (the MCP server was never contacted under the pinned argv, see P2)' : ''}` });

  // Informational for the S2 question only (never a decision): the same P5/P6 turn and the P4 canaries without --safe-mode.
  const p5ns = await p5turn((a) => dropFlag(a, '--safe-mode'));
  const p4ns = await p4turn(true, ['--safe-mode']);
  observed.withoutSafeMode = {
    note: 'Informational for the S2 question only; not a decision. Pinned argv with --safe-mode removed (--restricted, --setting-sources, --strict-mcp-config kept).',
    initTools: p5ns.initTools, editOk: p5ns.editOk, mcpOk: p5ns.mcpOk, mcpHeader: p5ns.auth, tokenInArgv: p5ns.tokenInArgv, tokenInHomeFiles: p5ns.tokenInHomeFiles, tokenInCliOutput: p5ns.tokenInStdout,
    offered: p5ns.offered,
    canaryLeaks: p4ns.leaks, skillsInSystem: p4ns.skillsInSystem, preambleInUser: p4ns.preambleInUser, homeWrites: p4ns.homeWrites.map((f) => f.rel)
  };
  log(`diag without --safe-mode: ${JSON.stringify(observed.withoutSafeMode)}`);
  decisions.push({ id: 'mcpHeaderForm', branch: p5.auth === 'expanded' ? 'env-expansion' : p5.auth === 'no-initialize' ? `pending:S2 (without --safe-mode: ${p5ns.auth === 'expanded' ? 'env-expansion' : 'literal-in-job-file'})` : 'literal-in-job-file' });

  // P8: a 200 KiB context on stdin; argv stays small and the whole context reaches the mock.
  const p8 = await withTurn({ model: 'mock', proxy: 'recorder', script: (_b, s) => (s === 0 ? [{ type: 'text', text: 'ok' }] : null) },
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

  return { checks, decisions, observed };
}

async function partB(log) {
  const checks = [];
  const decisions = [];
  const observed = {};
  const one = async (dropSafe) => {
    const h = await H.start({ home: 'fake', model: 'none', proxy: 'recorder', mcp: 'recorder' });
    try {
      pinnedJob(h);
      const args = dropSafe ? dropFlag(h.argvBase, '--safe-mode') : h.argvBase;
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
        hasBaseUrl: Object.prototype.hasOwnProperty.call(h.env, 'ANTHROPIC_BASE_URL')
      };
    } finally { await h.stop(); }
  };
  const b = await one(false);
  const bns = await one(true);
  const onlyApi = b.hosts.length > 0 && b.hosts.every((x) => x === 'api.anthropic.com:443');
  const others = b.hosts.filter((x) => x !== 'api.anthropic.com:443');
  const mcpReached = b.mcpMethods.includes('initialize');
  let branch;
  if (b.connects === 0 && b.plainRequests === 0) branch = 'STOP:S6';
  else if (others.length) branch = `STOP:S7 (${others.join(', ')})`;
  else branch = mcpReached ? 'proxy-honoured' : 'proxy-honoured; MCP reach pending:S2';
  checks.push({
    id: 'P7', result: onlyApi && mcpReached ? 'pass' : 'fail',
    detail: `no ANTHROPIC_BASE_URL (${b.hasBaseUrl ? 'SET — probe bug' : 'unset'}), fake key, HTTPS_PROXY=recorder, NO_PROXY=127.0.0.1: ` +
      `${b.connects} CONNECT(s) to ${JSON.stringify(b.hosts)} within ${Math.round(b.ms / 1000)} s (${b.killedAtWindow ? 'stopped at the 30 s window' : `exited ${b.code}`}); ` +
      `plain proxy requests: ${b.plainRequests}; MCP recorder reached directly: ${mcpReached ? 'yes' : `no (${JSON.stringify(b.mcpMethods)})`}; CLI said: "${b.error}". ` +
      `Without --safe-mode: ${bns.connects} CONNECT(s) to ${JSON.stringify(bns.hosts)}, MCP reached directly: ${bns.mcpMethods.includes('initialize') ? 'yes' : 'no'}`
  });
  decisions.push({ id: 'P7', branch });
  observed.p7 = { withSafeMode: b, withoutSafeMode: bns };
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
  for (const c of [...report.checks].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))) lines.push(`| ${c.id} | ${c.result} | ${String(c.detail).replace(/\|/g, '\\|')} |`);
  lines.push('', '## Decisions', '', '| Id | Branch |', '|---|---|');
  for (const d of report.decisions) lines.push(`| ${d.id} | ${String(d.branch).replace(/\|/g, '\\|')} |`);
  lines.push('', '## Pinned flags in `--help`', '');
  for (const [f, ok] of Object.entries(report.helpFlags ?? {})) lines.push(`- \`${f}\`: ${ok ? 'listed' : 'MISSING'}`);
  if (report.observed?.homeWrites) {
    lines.push('', '## P10: writes to the fake home after one turn', '');
    for (const f of report.observed.homeWrites) lines.push(`- \`${f.rel}\` (${f.change}, ${f.size} bytes, mtime ${f.mtimeMs})`);
  }
  if (report.observed?.withoutSafeMode) {
    lines.push('', '## Informational for the S2 question (not a decision)', '', '```json', JSON.stringify(report.observed.withoutSafeMode, null, 2), '```');
  }
  lines.push('', '## Limits', '');
  lines.push('- P-A and P-B ran on a fake home only (decision D-B12). P10 lists the fake home; the real store is measured in V3.');
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
