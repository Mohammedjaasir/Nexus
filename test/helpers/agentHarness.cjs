'use strict';
// The agent harness (B2b Task 0; used by Tasks 6, 12 and 13). It is the ONLY way a task may run the
// installed agent CLI (decision D-B12):
//   - a planted fake home (HOME, USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA all point into it);
//   - a fake key;
//   - a loopback mock model (model: 'mock'), or none at all (model: 'none');
//   - a loopback proxy that refuses every CONNECT and records it (proxy: 'deny-all' | 'recorder');
//   - a loopback MCP recorder (mcp: 'recorder').
// It never uses the real home, the real login or CLI store, or the network. The env is built from an empty
// object (nothing is inherited from this process), and every value in it points into the harness root.
//
// start(opts) -> { env, argvBase, home, mock, proxy, mcp, stop(), ...extras }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fakeHome = require('./fakeHome.cjs');
const mockModel = require('./mockModel.cjs');
const proxyRecorder = require('./proxyRecorder.cjs');
const mcpRecorder = require('./mcpRecorder.cjs');

/** The flags the adapter relies on (Task 0, P1). `--append-system-prompt-file` is checked separately. */
const PINNED_FLAGS = Object.freeze([
  '-p', '--output-format', '--verbose', '--input-format', '--restricted', '--safe-mode', '--strict-mcp-config',
  '--mcp-config', '--settings', '--setting-sources', '--tools', '--allowedTools', '--disallowedTools',
  '--permission-mode', '--permission-prompts', '--no-session-persistence', '--disable-slash-commands',
  '--no-chrome', '--max-budget-usd', '--append-system-prompt'
]);
const SKILLS_FILE_FLAG = '--append-system-prompt-file';
const VERSION_RE = /^2\.1\.\d+/;

const BUILTIN_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
const DISALLOWED_TOOLS = Object.freeze(['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent']);
const MCP_SERVER_NAME = 'nexus';
const FAKE_KEY = 'sk-ant-api03-FAKE-nexus-harness-key-000000000000000000000000000000000000000000000000000000-AAAAAA';
/** `--setting-sources` takes a comma list of sources; the adapter loads none of user/project/local. */
const SETTING_SOURCES_FORM = '';

/** Where the CLI is: NEXUS_AGENT_CLI, else the native `claude.exe` (or `claude`) on PATH. Null when absent. */
function resolveCli(envPath = process.env.PATH ?? process.env.Path ?? '') {
  const explicit = process.env.NEXUS_AGENT_CLI;
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return path.resolve(p); } catch { /* next */ }
    }
  }
  return null;
}

const rand = () => crypto.randomBytes(6).toString('hex');

/** Canary strings and where they are planted. None of them may reach the model under the isolation flags. */
function makeCanaries() {
  const c = {
    homeMemory: `HOME-MEMORY-CANARY-${rand()}`,
    homeRules: `HOME-RULES-CANARY-${rand()}`,
    homeSkill: `HOME-SKILL-CANARY-${rand()}`,
    homeAgent: `HOME-AGENT-CANARY-${rand()}`,
    homeSettings: `HOME-SETTINGS-CANARY-${rand()}`,
    wtMemory: `WT-MEMORY-CANARY-${rand()}`,
    wtDotMemory: `WT-DOTMEMORY-CANARY-${rand()}`,
    wtLocalMemory: `WT-LOCALMEMORY-CANARY-${rand()}`,
    wtSkill: `WT-SKILL-CANARY-${rand()}`,
    wtAgent: `WT-AGENT-CANARY-${rand()}`,
    wtSettings: `WT-SETTINGS-CANARY-${rand()}`,
    wtMcp: `WT-MCP-CANARY-${rand()}`,
    envSecret: `ENV-SECRET-CANARY-${rand()}`,
    skills: `SKILLS-FILE-CANARY-${rand()}`,
    preamble: `STDIN-PREAMBLE-CANARY-${rand()}`
  };
  return c;
}

function homeFiles(c) {
  return {
    '.claude/CLAUDE.md': `# Home memory\n${c.homeMemory}\n`,
    '.claude/rules/canary.md': `# Home rule\n${c.homeRules}\n`,
    '.claude/skills/home-canary/SKILL.md': `---\nname: home-canary\ndescription: ${c.homeSkill}\n---\n${c.homeSkill}\n`,
    '.claude/agents/home-canary.md': `---\nname: home-canary\ndescription: ${c.homeAgent}\n---\n${c.homeAgent}\n`,
    '.claude/settings.json': {
      env: { NEXUS_HOME_SETTINGS_CANARY: c.homeSettings },
      permissions: { allow: ['Bash(*)', 'WebFetch'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${c.homeSettings}` }] }] }
    }
  };
}

function worktreeFiles(c, strayMcpUrl) {
  return {
    'README.md': '# probe worktree\n',
    'src/app.txt': 'hello from the worktree\n',
    '.env': `SECRET=${c.envSecret}\n`,
    'CLAUDE.md': `# Worktree memory\n${c.wtMemory}\n`,
    'CLAUDE.local.md': `# Worktree local memory\n${c.wtLocalMemory}\n`,
    '.claude/CLAUDE.md': `# Worktree dot memory\n${c.wtDotMemory}\n`,
    '.claude/skills/wt-canary/SKILL.md': `---\nname: wt-canary\ndescription: ${c.wtSkill}\n---\n${c.wtSkill}\n`,
    '.claude/agents/wt-canary.md': `---\nname: wt-canary\ndescription: ${c.wtAgent}\n---\n${c.wtAgent}\n`,
    '.claude/settings.json': {
      env: { NEXUS_WT_SETTINGS_CANARY: c.wtSettings },
      permissions: { allow: ['Bash(*)', 'WebFetch'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${c.wtSettings}` }] }] }
    },
    '.mcp.json': { mcpServers: { [`wt-canary`]: { type: 'http', url: strayMcpUrl, headers: { 'X-Canary': c.wtMcp } } } }
  };
}

/** The adapter's env allow-list, built from nothing. `extra` adds test-seam names (base URL, key). */
function buildEnv({ home, tmp, proxyUrl, token, systemRoot, extra }) {
  const sysRoot = systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const env = {
    SystemRoot: sysRoot,
    windir: sysRoot,
    PATH: process.platform === 'win32'
      ? [path.join(sysRoot, 'System32'), sysRoot, path.join(sysRoot, 'System32', 'Wbem'), path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
      : '/usr/bin:/bin',
    ...home.env,
    TEMP: tmp,
    TMP: tmp,
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: '127.0.0.1',
    NEXUS_MCP_TOKEN: token,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(extra ?? {})
  };
  return env;
}

/** The isolation argv of one turn (before the skills flag), with the job's file paths. */
function turnArgv({ jobDir, mcpTools, budgetUsd = 2, settingSources = SETTING_SOURCES_FORM }) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text',
    '--restricted', '--safe-mode', '--strict-mcp-config',
    '--mcp-config', path.join(jobDir, 'mcp.json'),
    '--settings', path.join(jobDir, 'settings.json'),
    '--setting-sources', settingSources,
    '--tools', BUILTIN_TOOLS.join(','),
    '--allowedTools', ...BUILTIN_TOOLS, ...mcpTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`),
    '--disallowedTools', ...DISALLOWED_TOOLS,
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--max-budget-usd', String(budgetUsd)
  ];
}

/** Parse stream-json stdout into events; non-JSON lines are kept as { type: '(text)', line }. */
function parseEvents(stdout) {
  return String(stdout).split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    try { return JSON.parse(line); } catch { return { type: '(text)', line }; }
  });
}

/** Write the job's mcp.json (env-expanded bearer by default), settings.json and optional skills file. */
function writeJobFiles({ jobDir, mcpUrl, headerForm = 'env', token, settings, skillsText }) {
  fs.mkdirSync(jobDir, { recursive: true });
  const authorization = headerForm === 'env' ? 'Bearer ${NEXUS_MCP_TOKEN}' : `Bearer ${token}`;
  const mcp = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl, headers: { Authorization: authorization } } } };
  fs.writeFileSync(path.join(jobDir, 'mcp.json'), JSON.stringify(mcp, null, 2));
  const s = settings ?? {
    permissions: {
      deny: ['Read(**/.env*)', 'Edit(**/.env*)', 'Read(**/*.pem)', 'Edit(**/*.pem)']
    },
    disableAllHooks: true
  };
  fs.writeFileSync(path.join(jobDir, 'settings.json'), JSON.stringify(s, null, 2));
  if (skillsText != null) fs.writeFileSync(path.join(jobDir, 'skills.md'), skillsText);
  return { mcpJson: path.join(jobDir, 'mcp.json'), settingsJson: path.join(jobDir, 'settings.json'), skillsMd: path.join(jobDir, 'skills.md') };
}

/**
 * start({ home: 'fake', model: 'mock'|'none', proxy: 'deny-all'|'recorder', mcp: 'recorder', script?, sideScript?,
 *         mcpTools?, onCall?, homeFiles?, worktreeFiles? })
 *   -> { env, argvBase, home, mock, proxy, mcp, stop(),
 *        bin, root, worktree, jobDir, tmp, token, canaries, run(args, opts), writeJobFiles(opts), underRealHome }
 */
async function start(opts = {}) {
  if ((opts.home ?? 'fake') !== 'fake') throw new Error('agentHarness: only a fake home is allowed');
  const modelMode = opts.model ?? 'mock';
  if (modelMode !== 'mock' && modelMode !== 'none') throw new Error(`agentHarness: model must be 'mock' or 'none'`);
  const proxyMode = opts.proxy ?? 'deny-all';
  if (proxyMode !== 'deny-all' && proxyMode !== 'recorder') throw new Error(`agentHarness: proxy must be 'deny-all' or 'recorder'`);
  if ((opts.mcp ?? 'recorder') !== 'recorder') throw new Error(`agentHarness: mcp must be 'recorder'`);

  const { root, underRealHome } = fakeHome.makeRoot('nxh-');
  const started = [];
  try {
    const canaries = makeCanaries();
    const mcp = await mcpRecorder.start({ tools: opts.mcpTools, onCall: opts.onCall });
    started.push(mcp);
    const strayMcpUrl = mcp.url.replace(/\/mcp$/, '/stray-mcp');
    const home = fakeHome.create({ root, files: { ...homeFiles(canaries), ...(opts.homeFiles ?? {}) } });
    const worktree = path.join(root, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    fakeHome.plant(worktree, { ...worktreeFiles(canaries, strayMcpUrl), ...(opts.worktreeFiles ?? {}) });
    const jobDir = path.join(root, 'job');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    const proxy = await proxyRecorder.start({ mode: proxyMode });
    started.push(proxy);
    const mock = modelMode === 'mock' ? await mockModel.start({ script: opts.script, sideScript: opts.sideScript }) : null;
    if (mock) started.push(mock);
    const token = `nxt_${crypto.randomBytes(16).toString('hex')}`;
    const extra = { ANTHROPIC_API_KEY: FAKE_KEY };
    if (mock) extra.ANTHROPIC_BASE_URL = mock.url;
    const env = buildEnv({ home, tmp, proxyUrl: proxy.url, token, extra });
    const mcpToolNames = mcp.tools.map((t) => t.name);
    const argvBase = turnArgv({ jobDir, mcpTools: mcpToolNames });
    const bin = opts.bin ?? resolveCli();
    let stopped = false;
    const children = new Set();

    /** Run the CLI once. Never through a shell; stdin is written then closed. */
    function run(args, runOpts = {}) {
      if (!bin) return Promise.reject(new Error('agentHarness: the agent CLI is not installed'));
      const timeoutMs = runOpts.timeoutMs ?? 90_000;
      const childEnv = { ...env, ...(runOpts.env ?? {}) };
      for (const k of runOpts.unsetEnv ?? []) delete childEnv[k];
      return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(bin, args, { cwd: runOpts.cwd ?? worktree, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        children.add(child);
        const out = [];
        const err = [];
        let timedOut = false;
        child.stdout.on('data', (d) => { out.push(d); runOpts.onStdout?.(d); });
        child.stderr.on('data', (d) => err.push(d));
        child.stdin.on('error', () => {});
        if (runOpts.stdin != null) child.stdin.end(runOpts.stdin); else child.stdin.end();
        const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
        const finish = (code, signal, spawnError) => {
          clearTimeout(timer);
          children.delete(child);
          const stdout = Buffer.concat(out).toString('utf8');
          resolve({
            code, signal, timedOut, spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
            ms: Date.now() - t0, stdout, stderr: Buffer.concat(err).toString('utf8'), events: parseEvents(stdout),
            argvBytes: Buffer.byteLength([bin, ...args].join(' '), 'utf8')
          });
        };
        child.once('error', (e) => finish(null, null, e));
        child.once('close', (code, signal) => finish(code, signal, null));
      });
    }

    return {
      env,
      argvBase,
      home,
      mock,
      proxy,
      mcp,
      bin,
      root,
      underRealHome,
      worktree,
      jobDir,
      tmp,
      token,
      canaries,
      strayMcpUrl,
      mcpToolNames,
      run,
      writeJobFiles: (o = {}) => writeJobFiles({ jobDir, mcpUrl: mcp.url, token, ...o }),
      async stop() {
        if (stopped) return;
        stopped = true;
        for (const c of children) { try { c.kill(); } catch {} }
        for (const s of started.reverse()) { try { await s.stop(); } catch {} }
        try { fakeHome.removeRoot(root); } catch { /* best effort; reported by the caller's cleanup check */ }
      }
    };
  } catch (e) {
    for (const s of started.reverse()) { try { await s.stop(); } catch {} }
    try { fakeHome.removeRoot(root); } catch {}
    throw e;
  }
}

module.exports = {
  start, resolveCli, buildEnv, turnArgv, parseEvents, writeJobFiles, makeCanaries,
  PINNED_FLAGS, SKILLS_FILE_FLAG, VERSION_RE, BUILTIN_TOOLS, DISALLOWED_TOOLS, MCP_SERVER_NAME, FAKE_KEY, SETTING_SOURCES_FORM
};
