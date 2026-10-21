'use strict';
// A planted fake home for the agent harness (B2b Task 0). Generic: the caller says which files to plant
// (canaries, settings), and this module builds the folder, the home-shaped env that points into it, and a
// file-list snapshot with mtimes so a caller can see what a process wrote there.
//
// The root is chosen OUTSIDE the real home when the machine has one (a process that walks up from its cwd
// looking for config must never reach the real home's files). Order: NEXUS_AGENT_HARNESS_ROOT, then
// <system drive>\tmp or \temp when it exists and is not under the real home, then os.tmpdir().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realHome = () => path.resolve(os.homedir());

function isUnder(child, parent) {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The base folder new harness roots are made in, and whether it sits under the real home. */
function pickBase() {
  const cands = [];
  if (process.env.NEXUS_AGENT_HARNESS_ROOT) cands.push(process.env.NEXUS_AGENT_HARNESS_ROOT);
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
    cands.push(`${drive}\\tmp`, `${drive}\\temp`);
  } else {
    cands.push('/tmp');
  }
  for (const c of cands) {
    try {
      if (fs.statSync(c).isDirectory() && !isUnder(c, realHome())) {
        fs.accessSync(c, fs.constants.W_OK);
        return { base: path.resolve(c), underRealHome: false };
      }
    } catch { /* next */ }
  }
  const t = path.resolve(os.tmpdir());
  return { base: t, underRealHome: isUnder(t, realHome()) };
}

/** A fresh, empty, uniquely named root folder for one harness. */
function makeRoot(prefix = 'nxh-') {
  const { base, underRealHome } = pickBase();
  return { root: fs.mkdtempSync(path.join(base, prefix)), underRealHome };
}

function plant(dir, files) {
  for (const [rel, content] of Object.entries(files ?? {})) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`fakeHome: refusing path ${rel}`);
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  }
}

/** Every file under dir: { rel (forward slashes), size, mtimeMs }. Links are listed, never followed. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isDirectory() && !e.isSymbolicLink()) { walk(p); continue; }
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      out.push({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Files added or changed between two snapshots: { rel, change: 'added'|'changed', size, mtimeMs }. */
function diff(before, after) {
  const prev = new Map(before.map((f) => [f.rel, f]));
  const out = [];
  for (const f of after) {
    const p = prev.get(f.rel);
    if (!p) out.push({ ...f, change: 'added' });
    else if (p.size !== f.size || p.mtimeMs !== f.mtimeMs) out.push({ ...f, change: 'changed' });
  }
  return out;
}

/**
 * create({ root, files }) -> { dir, env, snapshot(), diff(before), files }
 * `root` is a harness root from makeRoot(); the home is <root>/home. `env` points HOME, USERPROFILE,
 * HOMEDRIVE/HOMEPATH, APPDATA and LOCALAPPDATA into it.
 */
function create({ root, files } = {}) {
  if (!root) throw new Error('fakeHome.create: root is required');
  const dir = path.join(root, 'home');
  fs.mkdirSync(dir, { recursive: true });
  const appData = path.join(dir, 'AppData', 'Roaming');
  const localAppData = path.join(dir, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  plant(dir, files);
  const parsed = path.parse(dir);
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData
  };
  if (process.platform === 'win32') {
    env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '');
    env.HOMEPATH = dir.slice(env.HOMEDRIVE.length);
  }
  return {
    dir,
    env,
    files: { ...(files ?? {}) },
    snapshot: () => snapshot(dir),
    diff: (before) => diff(before, snapshot(dir))
  };
}

/** Remove a harness root. Refuses anything that is not a direct child of the picked base or os.tmpdir(). */
function removeRoot(root) {
  if (!root) return;
  const r = path.resolve(root);
  const parent = path.dirname(r);
  const okParents = [pickBase().base, path.resolve(os.tmpdir())].map((p) => p.toLowerCase());
  if (!okParents.includes(parent.toLowerCase()) || !/^nx/.test(path.basename(r))) throw new Error(`fakeHome: refusing to remove ${r}`);
  fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

module.exports = { create, makeRoot, removeRoot, snapshot, diff, plant, pickBase, realHome, isUnder };
