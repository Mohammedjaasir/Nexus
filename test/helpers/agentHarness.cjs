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

/**
 * The flags the adapter relies on (Task 0, P1). `--append-system-prompt-file` is checked separately.
 * `--safe-mode` is not pinned: it drops the job's MCP server (Task 0 STOP S2), and decision D-B15 removed it.
 */
const PINNED_FLAGS = Object.freeze([
  '-p', '--output-format', '--verbose', '--input-format', '--restricted', '--strict-mcp-config',
  '--mcp-config', '--settings', '--setting-sources', '--tools', '--allowedTools', '--disallowedTools',
  '--permission-mode', '--permission-prompts', '--no-session-persistence', '--disable-slash-commands',
  '--no-chrome', '--max-budget-usd', '--append-system-prompt'
]);
const SKILLS_FILE_FLAG = '--append-system-prompt-file';
const VERSION_RE = /^2\.1\.\d+/;

const BUILTIN_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
/** D-B15: both spellings of the subagent tool (2.1.295 names it `Task`), and PowerShell even where the build lacks it. */
const DISALLOWED_TOOLS = Object.freeze(['Task', 'Agent', 'PowerShell', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit']);
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
    homeCommand: `HOME-COMMAND-CANARY-${rand()}`,
    homeSettings: `HOME-SETTINGS-CANARY-${rand()}`,
    homeHook: `HOME-HOOK-CANARY-${rand()}`,
    homeMcp: `HOME-MCP-CANARY-${rand()}`,
    homePlugin: `HOME-PLUGIN-CANARY-${rand()}`,
    wtMemory: `WT-MEMORY-CANARY-${rand()}`,
    wtDotMemory: `WT-DOTMEMORY-CANARY-${rand()}`,
    wtLocalMemory: `WT-LOCALMEMORY-CANARY-${rand()}`,
    wtSkill: `WT-SKILL-CANARY-${rand()}`,
    wtAgent: `WT-AGENT-CANARY-${rand()}`,
    wtCommand: `WT-COMMAND-CANARY-${rand()}`,
    wtSettings: `WT-SETTINGS-CANARY-${rand()}`,
    wtLocalSettings: `WT-LOCALSETTINGS-CANARY-${rand()}`,
    wtHook: `WT-HOOK-CANARY-${rand()}`,
    wtMcp: `WT-MCP-CANARY-${rand()}`,
    wtLocalMcp: `WT-LOCALMCP-CANARY-${rand()}`,
    wtPlugin: `WT-PLUGIN-CANARY-${rand()}`,
    envSecret: `ENV-SECRET-CANARY-${rand()}`,
    skills: `SKILLS-FILE-CANARY-${rand()}`,
    preamble: `STDIN-PREAMBLE-CANARY-${rand()}`
  };
  return c;
}

/** The canaries that must never reach the model or show any effect (everything but the job's own). */
const ISOLATION_CANARY_KEYS = Object.freeze([
  'homeMemory', 'homeRules', 'homeSkill', 'homeAgent', 'homeCommand', 'homeSettings', 'homeHook', 'homeMcp', 'homePlugin',
  'wtMemory', 'wtDotMemory', 'wtLocalMemory', 'wtSkill', 'wtAgent', 'wtCommand', 'wtSettings', 'wtLocalSettings', 'wtHook',
  'wtMcp', 'wtLocalMcp', 'wtPlugin'
]);

/** A settings `model` value that is also a canary: a loaded settings file shows up as the request's model. */
const modelCanary = (s) => `canary-model-${s.toLowerCase()}`;
const fwd = (p) => p.split(path.sep).join('/');

/**
 * A hook that, if it ever runs, prints its canary (hook output can reach the model) and writes a marker file.
 * `&&` and a quoted forward-slash path work in both cmd and bash.
 */
function hookSet(canary, markerDir, tag) {
  const cmd = (ev) => ({ type: 'command', command: `echo ${canary} && echo ${ev}>"${fwd(path.join(markerDir, `${tag}-${ev}.txt`))}"` });
  return {
    SessionStart: [{ hooks: [cmd('SessionStart')] }],
    UserPromptSubmit: [{ hooks: [cmd('UserPromptSubmit')] }],
    PreToolUse: [{ matcher: '*', hooks: [cmd('PreToolUse')] }],
    Stop: [{ hooks: [cmd('Stop')] }]
  };
}

/** A local plugin marketplace holding one plugin with a skill, a command, an agent, a hook and an MCP server. */
function pluginFiles(prefix, name, canary, { markerDir, strayUrl }) {
  return {
    [`${prefix}/.claude-plugin/marketplace.json`]: { name: 'nexus-canary-market', owner: { name: 'probe' }, plugins: [{ name, source: `./${name}`, description: canary }] },
    [`${prefix}/${name}/.claude-plugin/plugin.json`]: {
      name, version: '1.0.0', description: canary,
      mcpServers: { [`${name}-mcp`]: { type: 'http', url: strayUrl, headers: { 'X-Canary': canary } } }
    },
    [`${prefix}/${name}/skills/${name}-skill/SKILL.md`]: `---\nname: ${name}-skill\ndescription: ${canary}\n---\n${canary}\n`,
    [`${prefix}/${name}/commands/${name}-cmd.md`]: `---\ndescription: ${canary}\n---\n${canary}\n`,
    [`${prefix}/${name}/agents/${name}-agent.md`]: `---\nname: ${name}-agent\ndescription: ${canary}\n---\n${canary}\n`,
    [`${prefix}/${name}/hooks/hooks.json`]: { hooks: hookSet(canary, markerDir, name) }
  };
}

/** The fake home's plants: memory, rules, skill, agent, command, user settings (+hooks), user MCP, a plugin. */
function homeFiles(c, { home, worktree, markerDir, strayUrl }) {
  const market = path.join(home, '.canary-market');
  const wtMarket = path.join(worktree, '.canary-market');
  const pluginName = 'home-canary-plugin';
  const now = new Date(0).toISOString();
  return {
    '.claude/CLAUDE.md': `# Home memory\n${c.homeMemory}\n`,
    '.claude/rules/canary.md': `# Home rule\n${c.homeRules}\n`,
    '.claude/skills/home-canary/SKILL.md': `---\nname: home-canary\ndescription: ${c.homeSkill}\n---\n${c.homeSkill}\n`,
    '.claude/agents/home-canary.md': `---\nname: home-canary\ndescription: ${c.homeAgent}\n---\n${c.homeAgent}\n`,
    '.claude/commands/home-canary.md': `---\ndescription: ${c.homeCommand}\n---\n${c.homeCommand}\n`,
    '.claude/settings.json': {
      model: modelCanary(c.homeSettings),
      env: { NEXUS_HOME_SETTINGS_CANARY: c.homeSettings },
      permissions: { allow: ['Bash(*)', 'WebFetch'] },
      hooks: hookSet(c.homeHook, markerDir, 'home'),
      enabledPlugins: { [`${pluginName}@nexus-canary-market`]: true },
      extraKnownMarketplaces: { 'nexus-canary-market': { source: { source: 'directory', path: market } } }
    },
    '.claude/plugins/known_marketplaces.json': {
      'nexus-canary-market': { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: now },
      'nexus-canary-wt-market': { source: { source: 'directory', path: wtMarket }, installLocation: wtMarket, lastUpdated: now }
    },
    '.claude/plugins/installed_plugins.json': {
      version: 2,
      plugins: {
        [`${pluginName}@nexus-canary-market`]: [{ scope: 'user', installPath: path.join(market, pluginName), version: '1.0.0', installedAt: now, lastUpdated: now }],
        'wt-canary-plugin@nexus-canary-wt-market': [{ scope: 'project', projectPath: worktree, installPath: path.join(wtMarket, 'wt-canary-plugin'), version: '1.0.0', installedAt: now, lastUpdated: now }]
      }
    },
    ...pluginFiles('.canary-market', pluginName, c.homePlugin, { markerDir, strayUrl: `${strayUrl}/home-plugin` }),
    '.claude.json': {
      hasCompletedOnboarding: true,
      mcpServers: { 'home-canary': { type: 'http', url: `${strayUrl}/home-user`, headers: { 'X-Canary': c.homeMcp } } },
      projects: {
        [fwd(worktree)]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['wt-canary'],
          mcpServers: { 'wt-local-canary': { type: 'http', url: `${strayUrl}/wt-local`, headers: { 'X-Canary': c.wtLocalMcp } } }
        }
      }
    }
  };
}

/** The worktree's plants: memory files, skill, agent, command, project and local settings (+hooks), .mcp.json, a plugin. */
function worktreeFiles(c, { worktree, markerDir, strayUrl }) {
  const pluginName = 'wt-canary-plugin';
  return {
    'README.md': '# probe worktree\n',
    'src/app.txt': 'hello from the worktree\n',
    '.env': `SECRET=${c.envSecret}\n`,
    'CLAUDE.md': `# Worktree memory\n${c.wtMemory}\n`,
    'CLAUDE.local.md': `# Worktree local memory\n${c.wtLocalMemory}\n`,
    '.claude/CLAUDE.md': `# Worktree dot memory\n${c.wtDotMemory}\n`,
    '.claude/skills/wt-canary/SKILL.md': `---\nname: wt-canary\ndescription: ${c.wtSkill}\n---\n${c.wtSkill}\n`,
    '.claude/agents/wt-canary.md': `---\nname: wt-canary\ndescription: ${c.wtAgent}\n---\n${c.wtAgent}\n`,
    '.claude/commands/wt-canary.md': `---\ndescription: ${c.wtCommand}\n---\n${c.wtCommand}\n`,
    '.claude/settings.json': {
      model: modelCanary(c.wtSettings),
      env: { NEXUS_WT_SETTINGS_CANARY: c.wtSettings },
      permissions: { allow: ['Bash(*)', 'WebFetch'] },
      hooks: hookSet(c.wtHook, markerDir, 'wt'),
      enableAllProjectMcpServers: true,
      enabledPlugins: { [`${pluginName}@nexus-canary-wt-market`]: true },
      extraKnownMarketplaces: { 'nexus-canary-wt-market': { source: { source: 'directory', path: path.join(worktree, '.canary-market') } } }
    },
    '.claude/settings.local.json': { model: modelCanary(c.wtLocalSettings), env: { NEXUS_WT_LOCAL_SETTINGS_CANARY: c.wtLocalSettings } },
    '.mcp.json': { mcpServers: { 'wt-canary': { type: 'http', url: `${strayUrl}/wt-project`, headers: { 'X-Canary': c.wtMcp } } } },
    ...pluginFiles('.canary-market', pluginName, c.wtPlugin, { markerDir, strayUrl: `${strayUrl}/wt-plugin` })
  };
}

/**
 * Every sign that a planted customization loaded or ran, from one run: canary text in any request to the mock,
 * a canary model in a request, a hook marker file, a stray MCP request, or a planted name in system/init.
 * Returns [{ plant, via }]; empty means isolated.
 */
function detectPlants(h, run, { since = { mock: 0, strays: 0 } } = {}) {
  const found = [];
  const c = h.canaries;
  const reqs = h.mock ? h.mock.requests.slice(since.mock) : [];
  const raw = reqs.map((q) => q.raw).join('\n');
  for (const k of ISOLATION_CANARY_KEYS) {
    if (raw.includes(c[k])) found.push({ plant: k, via: 'request text' });
    if (raw.toLowerCase().includes(modelCanary(c[k]))) found.push({ plant: k, via: 'request model' });
  }
  let markers = [];
  try { markers = fs.readdirSync(h.markerDir); } catch { /* none */ }
  for (const m of markers) found.push({ plant: `hook:${m.replace(/\.txt$/, '')}`, via: 'marker file' });
  for (const s of h.mcp.strays.slice(since.strays)) found.push({ plant: `mcp:${s.path}`, via: `stray MCP ${s.method}` });
  const init = run?.events?.find((e) => e && e.type === 'system' && e.subtype === 'init');
  if (init) {
    for (const s of init.mcp_servers ?? []) if (s?.name !== MCP_SERVER_NAME) found.push({ plant: `mcp:${s.name}`, via: `init.mcp_servers (${s.status})` });
    for (const p of init.plugins ?? []) if (/canary/i.test(JSON.stringify(p))) found.push({ plant: `plugin:${p.name}`, via: 'init.plugins' });
    for (const a of init.agents ?? []) if (/canary/i.test(String(a))) found.push({ plant: `agent:${a}`, via: 'init.agents' });
    for (const s of init.skills ?? []) if (/canary/i.test(JSON.stringify(s))) found.push({ plant: `skill:${JSON.stringify(s)}`, via: 'init.skills' });
    for (const s of init.slash_commands ?? []) if (/canary/i.test(String(s))) found.push({ plant: `command:${s}`, via: 'init.slash_commands' });
    if (/canary-model/i.test(String(init.model))) found.push({ plant: `model:${init.model}`, via: 'init.model' });
  }
  for (const e of run?.events ?? []) {
    if (e && e.type === 'system' && /hook/i.test(String(e.subtype))) found.push({ plant: `hook-event:${e.subtype}`, via: 'stream event' });
  }
  return found;
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
    '--restricted', '--strict-mcp-config',
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
 *        bin, root, worktree, jobDir, tmp, token, canaries, markerDir, run(args, opts) (its result carries .writes),
 *        writeJobFiles(opts), detectPlants(runResult), underRealHome }
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
    const strayMcpUrl = mcp.url.replace(/\/mcp$/, '/stray');
    const worktree = path.join(root, 'wt');
    const markerDir = path.join(root, 'markers');
    fs.mkdirSync(markerDir, { recursive: true }); // a hook that runs leaves its marker here
    const plantCtx = { home: path.join(root, 'home'), worktree, markerDir, strayUrl: strayMcpUrl };
    const home = fakeHome.create({ root, files: { ...homeFiles(canaries, plantCtx), ...(opts.homeFiles ?? {}) } });
    fs.mkdirSync(worktree, { recursive: true });
    fakeHome.plant(worktree, { ...worktreeFiles(canaries, plantCtx), ...(opts.worktreeFiles ?? {}) });
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
        const before = fakeHome.snapshot(root);
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
            argvBytes: Buffer.byteLength([bin, ...args].join(' '), 'utf8'),
            // every file added or changed anywhere under the harness root in this run (home, worktree, job, tmp)
            writes: fakeHome.diff(before, fakeHome.snapshot(root))
          });
        };
        child.once('error', (e) => finish(null, null, e));
        child.once('close', (code, signal) => finish(code, signal, null));
      });
    }

    const self = {
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
      markerDir,
      mcpToolNames,
      detectPlants: (r, o) => detectPlants(self, r, o),
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
    return self;
  } catch (e) {
    for (const s of started.reverse()) { try { await s.stop(); } catch {} }
    try { fakeHome.removeRoot(root); } catch {}
    throw e;
  }
}

module.exports = {
  start, resolveCli, buildEnv, turnArgv, parseEvents, writeJobFiles, makeCanaries, detectPlants, modelCanary, ISOLATION_CANARY_KEYS,
  PINNED_FLAGS, SKILLS_FILE_FLAG, VERSION_RE, BUILTIN_TOOLS, DISALLOWED_TOOLS, MCP_SERVER_NAME, FAKE_KEY, SETTING_SOURCES_FORM
};
