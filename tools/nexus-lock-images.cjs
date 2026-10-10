#!/usr/bin/env node
'use strict';
/**
 * tools/nexus-lock-images.cjs (B2a Task 12): pins the three sandbox images' inputs. Controller-run, with the network for
 * METADATA ONLY: it never pulls an image, never builds one, never downloads a package.
 *
 *   node tools/nexus-lock-images.cjs           resolve and write (network: registry manifests and the npm / PyPI JSON APIs)
 *   node tools/nexus-lock-images.cjs --check   no network: verify infra/images/lock.json against the files (exit 1 if stale)
 *   node tools/nexus-lock-images.cjs --rehash  no network: recompute the context and lockfile hashes after a local edit
 *
 * Resolving:
 * - base images: `docker buildx imagetools inspect <ref>` (manifest and config metadata from the registry; nothing is
 *   pulled): the index digest pinned in each Dockerfile's FROM line, the image config's ENV names (a container may carry
 *   only those, the plan's own names aside: preflight's image-environment check), the compressed layer sizes;
 * - sde-node reporters: the npm registry JSON API (abbreviated packuments): the newest jest-junit and
 *   mocha-junit-reporter, their dependency tree resolved with semver and laid out as npm would (hoisted, nested only on a
 *   conflict), written as reporters/package.json (exact versions) and a lockfile v3 with each tarball's `integrity`;
 *   peers are not installed (reporters/.npmrc legacy-peer-deps);
 * - sde-python tools: the PyPI JSON API: every name of requirements.in and its dependency closure for CPython 3.11 on
 *   Linux x86_64 (environment markers evaluated, extras never), the newest release that satisfies every requirement,
 *   written as requirements.lock with the sha256 of each pure-Python wheel.
 * Writing: the lockfiles, the Dockerfiles' FROM digest and `ARG NEXUS_VERSIONS` default (the label the build self-test
 * checks), then infra/images/lock.json: per profile `{ base: { ref, repository, digest }, baseEnv, imageEnv, entrypoint,
 * lockfiles: { <path>: <sha256> }, contextSha256, estimatedBytes, versions }`. `contextSha256` is computed with
 * src/runner/imageBuilder.ts `contextSha256` (THE definition: the sorted [path, sha256] list of `<profile>/**` and
 * `common/**`), so main, the runner and this file agree byte for byte.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'infra', 'images');
const LOCK = path.join(IMAGES, 'lock.json');
const PLATFORM = 'linux/amd64';
const NPM = 'https://registry.npmjs.org';
const PYPI = 'https://pypi.org/pypi';
const TIMEOUT_MS = 60_000;
/** A pure-Python wheel (the only kind the lock pins: one file for every platform). */
const PURE_WHEEL_RE = /-(?:py2\.)?py3-none-any\.whl$/;

/** The profiles: base reference, entrypoint, the lockfiles in their context, and the versions their label names (in order). */
const PROFILES = {
  'sde-node': { base: 'docker.io/library/node:20-bookworm-slim', entrypoint: ['/opt/nexus/nexus-entry'],
    lockfiles: ['sde-node/reporters/package.json', 'sde-node/reporters/package-lock.json'] },
  'sde-python': { base: 'docker.io/library/python:3.11-slim-bookworm', entrypoint: ['/opt/nexus/nexus-entry'],
    lockfiles: ['sde-python/requirements.lock'] },
  'nexus-fwd': { base: 'docker.io/library/alpine:3.20', entrypoint: ['/opt/nexus/fwd-entry'], lockfiles: [] }
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileSha = (rel) => sha256(fs.readFileSync(path.join(IMAGES, ...rel.split('/'))));
const die = (m) => { console.error(`[lock] ${m}`); process.exit(1); };

function loadImageBuilder() {
  const loadTs = require(path.join(ROOT, 'test', 'load-ts.cjs'));
  return loadTs('src/runner/imageBuilder.ts');
}
async function contextOf(profile) {
  const { contextSha256 } = loadImageBuilder();
  const sha = await contextSha256(fsp, IMAGES, profile);
  if (!sha) die(`the build context of ${profile} is missing or holds a link`);
  return sha;
}

// ---------------------------------------------------------------- --check (no network)

async function check() {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) { die(`lock.json is not readable: ${e.message}`); }
  const problems = [];
  for (const id of Object.keys(PROFILES)) {
    const p = lock.profiles?.[id];
    if (!p) { problems.push(`${id}: not in lock.json`); continue; }
    for (const [rel, want] of Object.entries(p.lockfiles ?? {})) if (fileSha(rel) !== want) problems.push(`${id}: ${rel} changed since it was locked`);
    const docker = fs.readFileSync(path.join(IMAGES, id, 'Dockerfile'), 'utf8');
    if (!docker.includes(`FROM ${p.base.ref}@${p.base.digest}`)) problems.push(`${id}: the Dockerfile does not pin ${p.base.ref}@${p.base.digest}`);
    const ctx = await contextOf(id);
    if (ctx !== p.contextSha256) problems.push(`${id}: the build context changed (${ctx.slice(0, 12)} != locked ${String(p.contextSha256).slice(0, 12)})`);
  }
  if (problems.length) { for (const x of problems) console.error(`[lock] STALE ${x}`); process.exit(1); }
  console.log('[lock] lock.json matches the image contexts');
}

// ---------------------------------------------------------------- base images (registry metadata only)

function imagetools(ref, format) {
  const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', format], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  return JSON.parse(out);
}

function inspectBase(ref) {
  const manifest = imagetools(ref, '{{json .Manifest}}');
  let digest = manifest.digest ?? manifest.Digest;
  if (!digest) {
    // A buildx that prints the index without its own digest in the template: the plain output names it.
    const text = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
    digest = (/^Digest:\s+(sha256:[0-9a-f]{64})/m.exec(text) ?? [])[1];
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) die(`${ref}: no index digest`);
  // The platform manifest (an index lists one per platform; a single-platform image is its own manifest).
  let platformDigest = digest;
  if (Array.isArray(manifest.manifests)) {
    const m = manifest.manifests.find((x) => x.platform && `${x.platform.os}/${x.platform.architecture}` === PLATFORM && !x.platform.variant);
    if (!m) die(`${ref}: no ${PLATFORM} manifest`);
    platformDigest = m.digest;
  }
  const repo = ref.replace(/:[^/:]+$/, '');
  // The platform manifest exactly as the registry serves it (`--raw`): its layers carry their compressed sizes.
  const pmText = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${repo}@${platformDigest}`],
    { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  const pm = JSON.parse(pmText);
  const compressed = (pm.layers ?? []).reduce((s, l) => s + (Number(l.size) || 0), 0);
  if (!(compressed > 0)) die(`${ref}: the ${PLATFORM} manifest lists no layer sizes`);
  const raw = imagetools(`${repo}@${platformDigest}`, '{{json .Image}}');
  const img = raw && raw[PLATFORM] ? raw[PLATFORM] : raw;
  const config = img.config ?? img.Config ?? {};
  const env = (config.Env ?? config.env ?? []).map((e) => String(e).split('=')[0]).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const values = Object.fromEntries((config.Env ?? []).map((e) => { const i = String(e).indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));
  return { ref, repository: repo, digest, platformDigest, compressed, env: [...new Set(env)].sort(), values };
}

// ---------------------------------------------------------------- npm (registry JSON API)

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) die(`${url}: HTTP ${r.status}`);
  return r.json();
}
const packuments = new Map();
async function packument(name) {
  if (!packuments.has(name)) packuments.set(name, await getJson(`${NPM}/${name.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json' }));
  return packuments.get(name);
}

async function lockNpm() {
  const semver = require('semver');
  const top = ['jest-junit', 'mocha-junit-reporter'];
  const exact = {};
  for (const n of top) exact[n] = (await packument(n))['dist-tags'].latest;
  // Placement: key = install path ('node_modules/a', 'node_modules/a/node_modules/b'); value = { name, version, meta }.
  const placed = new Map();
  const queue = [];
  const place = async (name, range, parent) => {
    // Resolution as node does: the nearest node_modules up from the dependent.
    const chain = [];
    for (let p = parent; ; p = p.includes('/node_modules/') ? p.slice(0, p.lastIndexOf('/node_modules/')) : '') {
      chain.push(p ? `${p}/node_modules/${name}` : `node_modules/${name}`);
      if (!p) break;
    }
    const found = chain.map((k) => [k, placed.get(k)]).find(([, v]) => v);
    if (found && semver.satisfies(found[1].version, range)) return;
    const pk = await packument(name);
    const version = semver.maxSatisfying(Object.keys(pk.versions), range);
    if (!version) die(`npm: no version of ${name} satisfies ${range}`);
    const meta = pk.versions[version];
    if (!meta.dist?.integrity || !meta.dist?.tarball) die(`npm: ${name}@${version} has no integrity`);
    const key = !found && !placed.has(`node_modules/${name}`) ? `node_modules/${name}` : (parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`);
    if (placed.has(key)) die(`npm: cannot place ${name}@${version} at ${key}`);
    placed.set(key, { name, version, meta });
    queue.push(key);
  };
  for (const n of top) await place(n, exact[n], '');
  while (queue.length) {
    const key = queue.shift();
    const { meta } = placed.get(key);
    for (const [dep, range] of Object.entries(meta.dependencies ?? {})) await place(dep, range, key);
  }
  const pkgPath = path.join(IMAGES, 'sde-node', 'reporters', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = Object.fromEntries(top.map((n) => [n, exact[n]]));
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const packages = { '': { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: { ...pkg.dependencies } } };
  let unpacked = 0;
  for (const key of [...placed.keys()].sort()) {
    const { version, meta } = placed.get(key);
    unpacked += Number(meta.dist.unpackedSize) || 0;
    packages[key] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity,
      ...(meta.license ? { license: typeof meta.license === 'string' ? meta.license : undefined } : {}),
      ...(meta.dependencies && Object.keys(meta.dependencies).length ? { dependencies: { ...meta.dependencies } } : {}),
      ...(meta.peerDependencies ? { peerDependencies: { ...meta.peerDependencies } } : {}),
      ...(meta.bin ? { bin: typeof meta.bin === 'string' ? { [meta.name]: meta.bin } : { ...meta.bin } } : {}),
      ...(meta.engines ? { engines: { ...meta.engines } } : {}) };
  }
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
  fs.writeFileSync(path.join(IMAGES, 'sde-node', 'reporters', 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return { versions: exact, packages: placed.size, unpackedBytes: unpacked };
}

// ---------------------------------------------------------------- PyPI (JSON API): PEP 440 and markers, the parts used here

/** A PEP 440 version as a comparable record (release, pre, post, dev); null for anything else. */
function pv(v) {
  const m = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|rc|alpha|beta|c|pre|preview)[-_.]?(\d*))?(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9.]+)?$/i.exec(String(v).trim());
  if (!m) return null;
  const preKind = m[2] ? ({ alpha: 'a', a: 'a', beta: 'b', b: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' })[m[2].toLowerCase()] : null;
  return { release: m[1].split('.').map(Number), pre: preKind ? [preKind, Number(m[3] || 0)] : null,
    post: m[4] !== undefined || m[5] !== undefined ? Number(m[4] || m[5] || 0) : null, dev: m[6] !== undefined ? Number(m[6] || 0) : null };
}
function cmpRelease(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}
function pvCmp(x, y) {
  const r = cmpRelease(x.release, y.release); if (r) return r;
  // dev < pre < (final) < post, as PEP 440 orders them.
  const key = (v) => [v.pre === null && v.post === null && v.dev !== null ? -2 : v.pre ? -1 : 0,
    v.pre ? ['a', 'b', 'rc'].indexOf(v.pre[0]) : 0, v.pre ? v.pre[1] : 0, v.post ?? -1, v.dev === null ? Infinity : v.dev];
  const a = key(x); const b = key(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/** Whether version `v` satisfies one specifier clause (`>=1.0`, `<3`, `==2.*`, `~=1.4`, `!=1.5`). */
function satisfiesClause(v, clause) {
  const m = /^\s*(===|~=|==|!=|<=|>=|<|>)\s*([^\s]+)\s*$/.exec(clause);
  if (!m) die(`pypi: unsupported specifier ${clause}`);
  const [, op, target] = m;
  const x = pv(v);
  if (op === '===') return v === target;
  if (target.endsWith('.*')) {
    const pre = target.slice(0, -2).split('.').map(Number);
    const eq = pre.every((n, i) => (x.release[i] ?? 0) === n);
    return op === '==' ? eq : op === '!=' ? !eq : die(`pypi: unsupported wildcard ${clause}`);
  }
  const t = pv(target);
  if (!t) die(`pypi: unsupported version ${target}`);
  const c = pvCmp(x, t);
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
    case '<': return c < 0 && !(x.pre && cmpRelease(x.release, t.release) === 0 && !t.pre);
    case '>': return c > 0 && !(x.post !== null && t.post === null && cmpRelease(x.release, t.release) === 0);
    case '~=': {
      if (t.release.length < 2) die(`pypi: ~= needs two release parts (${clause})`);
      return c >= 0 && t.release.slice(0, -1).every((n, i) => (x.release[i] ?? 0) === n);
    }
    default: return false;
  }
}
const satisfies = (v, spec) => !spec || spec.split(',').filter((s) => s.trim()).every((c) => satisfiesClause(v, c));

/** Evaluates a PEP 508 marker for CPython 3.11 on Linux x86_64 (`extra` is never set: no extras are installed). */
function marker(expr, env) {
  const toks = [];
  const re = /\s*(\(|\)|"[^"]*"|'[^']*'|===|==|!=|<=|>=|~=|<|>|not\s+in\b|in\b|and\b|or\b|[A-Za-z_][A-Za-z0-9_.]*)/y;
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) { if (/^\s*$/.test(expr.slice(i))) break; die(`pypi: unsupported marker ${expr}`); }
    toks.push(m[1].replace(/\s+/g, ' ')); i = re.lastIndex;
  }
  let p = 0;
  const value = () => {
    const t = toks[p++];
    if (/^["']/.test(t)) return { lit: t.slice(1, -1) };
    if (!(t in env)) die(`pypi: unsupported marker variable ${t}`);
    return { lit: env[t], name: t };
  };
  const cmp = () => {
    if (toks[p] === '(') { p++; const v = or(); if (toks[p++] !== ')') die(`pypi: bad marker ${expr}`); return v; }
    const a = value(); const op = toks[p++]; const b = value();
    const versiony = ['python_version', 'python_full_version', 'implementation_version'].includes(a.name ?? b.name ?? '');
    if (op === 'in') return b.lit.includes(a.lit);
    if (op === 'not in') return !b.lit.includes(a.lit);
    if (versiony && op !== '===' && pv(a.lit) && pv(b.lit)) return satisfiesClause(a.lit, `${op}${b.lit}`);
    if (op === '==' || op === '===') return a.lit === b.lit;
    if (op === '!=') return a.lit !== b.lit;
    die(`pypi: unsupported marker comparison ${expr}`);
    return false;
  };
  const and = () => { let v = cmp(); while (toks[p] === 'and') { p++; const w = cmp(); v = v && w; } return v; };
  const or = () => { let v = and(); while (toks[p] === 'or') { p++; const w = and(); v = v || w; } return v; };
  const out = or();
  if (p !== toks.length) die(`pypi: bad marker ${expr}`);
  return out;
}

/** `name [extras] (spec) ; marker` -> { name, spec, marker } (normalized name). */
function parseReq(s) {
  const [main, mk] = String(s).split(';');
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*\(?\s*([^)]*?)\s*\)?\s*$/.exec(main);
  if (!m) die(`pypi: unsupported requirement ${s}`);
  return { name: m[1].toLowerCase().replace(/[-_.]+/g, '-'), spec: m[3].trim(), marker: mk ? mk.trim() : null };
}

const pypiCache = new Map();
async function pypiProject(name) {
  if (!pypiCache.has(name)) pypiCache.set(name, await getJson(`${PYPI}/${name}/json`));
  return pypiCache.get(name);
}
const releaseCache = new Map();
async function pypiRelease(name, version) {
  const k = `${name}@${version}`;
  if (!releaseCache.has(k)) releaseCache.set(k, await getJson(`${PYPI}/${name}/${version}/json`));
  return releaseCache.get(k);
}

/** The newest final release of `name` satisfying every spec in `specs`, that has a pure-Python wheel. */
async function pick(name, specs) {
  const proj = await pypiProject(name);
  if (!proj.releases || typeof proj.releases !== 'object') die(`pypi: ${name} lists no releases in its JSON`);
  const versions = Object.keys(proj.releases).filter((v) => { const x = pv(v); return x && !x.pre && x.dev === null; })
    .filter((v) => (proj.releases[v] ?? []).some((f) => !f.yanked && f.packagetype === 'bdist_wheel' && PURE_WHEEL_RE.test(f.filename)))
    .filter((v) => specs.every((s) => satisfies(v, s)))
    .sort((a, b) => pvCmp(pv(b), pv(a)));
  if (!versions.length) die(`pypi: no wheel release of ${name} satisfies ${specs.join(' and ') || 'any version'}`);
  return versions[0];
}

async function lockPython(pythonVersion) {
  const env = { python_version: pythonVersion.split('.').slice(0, 2).join('.'), python_full_version: pythonVersion, os_name: 'posix',
    sys_platform: 'linux', platform_system: 'Linux', platform_machine: 'x86_64', platform_release: '', platform_version: '',
    implementation_name: 'cpython', implementation_version: pythonVersion, platform_python_implementation: 'CPython', extra: '' };
  const tops = fs.readFileSync(path.join(IMAGES, 'sde-python', 'requirements.in'), 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(parseReq);
  const specs = new Map();                  // name -> [spec...]
  const why = new Map();                    // name -> [by...]
  for (const t of tops) { specs.set(t.name, [t.spec].filter(Boolean)); why.set(t.name, ['requirements.in']); }
  let chosen = new Map();
  for (let round = 0; round < 20; round++) {
    const next = new Map();
    const queue = [...specs.keys()];
    const seen = new Set();
    let changed = false;
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n)) continue; seen.add(n);
      const v = await pick(n, specs.get(n) ?? []);
      next.set(n, v);
      const rel = await pypiRelease(n, v);
      for (const r of rel.info.requires_dist ?? []) {
        const q = parseReq(r);
        if (q.marker && !marker(q.marker, env)) continue;
        const list = specs.get(q.name) ?? [];
        if (q.spec && !list.includes(q.spec)) { list.push(q.spec); changed = true; }
        if (!specs.has(q.name)) changed = true;
        specs.set(q.name, list);
        why.set(q.name, [...new Set([...(why.get(q.name) ?? []), `${n}==${v}`])]);
        queue.push(q.name);
      }
    }
    const stable = !changed && [...next].every(([n, v]) => chosen.get(n) === v);
    chosen = next;
    if (stable) break;
    if (round === 19) die('pypi: the resolution did not settle');
  }
  // Every chosen release must satisfy every requirement that names it (checked again, whole).
  for (const [n, v] of chosen) for (const s of specs.get(n) ?? []) if (!satisfies(v, s)) die(`pypi: ${n}==${v} does not satisfy ${s}`);
  const lines = ['# Generated by tools/nexus-lock-images.cjs from requirements.in for CPython ' + pythonVersion + ' on Linux x86_64.',
    '# Exact versions and the sha256 of each pure-Python wheel; installed with pip --require-hashes --no-deps --only-binary=:all:.',
    '# Do not edit by hand: change requirements.in and run the lock tool again.'];
  let bytes = 0;
  const versions = {};
  for (const n of [...chosen.keys()].sort()) {
    const v = chosen.get(n);
    versions[n] = v;
    const rel = await pypiRelease(n, v);
    const wheels = rel.urls.filter((f) => !f.yanked && f.packagetype === 'bdist_wheel' && PURE_WHEEL_RE.test(f.filename));
    if (!wheels.length) die(`pypi: ${n}==${v} has no pure-Python wheel`);
    bytes += wheels[0].size || 0;
    lines.push(`${n}==${v} \\`, ...wheels.map((w, i) => `    --hash=sha256:${w.digests.sha256}${i < wheels.length - 1 ? ' \\' : ''}`),
      `    # via ${(why.get(n) ?? []).join(', ')}`);
  }
  fs.writeFileSync(path.join(IMAGES, 'sde-python', 'requirements.lock'), `${lines.join('\n')}\n`);
  return { versions, wheelBytes: bytes };
}

// ---------------------------------------------------------------- Dockerfiles

function pinDockerfile(profile, ref, digest, versions) {
  const f = path.join(IMAGES, profile, 'Dockerfile');
  let s = fs.readFileSync(f, 'utf8');
  const from = new RegExp(`^FROM ${ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@sha256:[0-9a-f]{64}$`, 'm');
  if (!from.test(s)) die(`${profile}: the Dockerfile has no FROM ${ref}@sha256:<digest> line`);
  s = s.replace(from, `FROM ${ref}@${digest}`);
  if (!/^ARG NEXUS_VERSIONS=".*"$/m.test(s)) die(`${profile}: the Dockerfile has no ARG NEXUS_VERSIONS line`);
  s = s.replace(/^ARG NEXUS_VERSIONS=".*"$/m, `ARG NEXUS_VERSIONS="${versions}"`);
  fs.writeFileSync(f, s);
}

async function resolve() {
  console.log('[lock] resolving base images (registry metadata only; nothing is pulled)');
  const bases = {};
  for (const [id, p] of Object.entries(PROFILES)) {
    bases[id] = inspectBase(p.base);
    console.log(`[lock]   ${id}: ${p.base}@${bases[id].digest} (${PLATFORM} ${bases[id].platformDigest.slice(0, 19)}, ${(bases[id].compressed / 2 ** 20).toFixed(1)} MiB compressed)`);
  }
  console.log('[lock] resolving the sde-node reporters (npm registry JSON API)');
  const npm = await lockNpm();
  console.log(`[lock]   jest-junit ${npm.versions['jest-junit']}, mocha-junit-reporter ${npm.versions['mocha-junit-reporter']} (${npm.packages} packages)`);
  const nodeVersion = bases['sde-node'].values.NODE_VERSION;
  const pythonVersion = bases['sde-python'].values.PYTHON_VERSION;
  if (!nodeVersion || !pythonVersion) die('the base images do not declare NODE_VERSION / PYTHON_VERSION');
  console.log(`[lock] resolving the sde-python tools for CPython ${pythonVersion} (PyPI JSON API)`);
  const py = await lockPython(pythonVersion);
  console.log(`[lock]   ${Object.entries(py.versions).map(([n, v]) => `${n}==${v}`).join(', ')}`);
  const fwdDocker = fs.readFileSync(path.join(IMAGES, 'nexus-fwd', 'Dockerfile'), 'utf8');
  const socat = (/apk add --no-cache socat=([0-9A-Za-z._-]+)/.exec(fwdDocker) ?? [])[1];
  if (!socat) die('nexus-fwd: the Dockerfile pins no socat version');
  const versions = {
    'sde-node': { node: nodeVersion, 'jest-junit': npm.versions['jest-junit'], 'mocha-junit-reporter': npm.versions['mocha-junit-reporter'] },
    'sde-python': { python: pythonVersion, pytest: py.versions.pytest, build: py.versions.build, wheel: py.versions.wheel, setuptools: py.versions.setuptools },
    'nexus-fwd': { alpine: '3.20', socat }
  };
  for (const [id, v] of Object.entries(versions)) pinDockerfile(id, PROFILES[id].base, bases[id].digest, Object.entries(v).map(([k, x]) => `${k}=${x}`).join(' '));
  const extra = { 'sde-node': npm.unpackedBytes, 'sde-python': py.wheelBytes * 3, 'nexus-fwd': 2 * 2 ** 20 };
  const lock = { version: 1, generatedBy: 'tools/nexus-lock-images.cjs', platform: PLATFORM, profiles: {} };
  for (const [id, p] of Object.entries(PROFILES)) {
    const b = bases[id];
    lock.profiles[id] = {
      base: { ref: p.base, repository: b.repository, digest: b.digest, platformDigest: b.platformDigest },
      baseEnv: b.env, imageEnv: b.env, entrypoint: p.entrypoint,
      lockfiles: Object.fromEntries(p.lockfiles.map((rel) => [rel, fileSha(rel)])),
      contextSha256: await contextOf(id),
      // The download and the unpacked size, roughly: compressed base layers x 3, plus the pinned packages.
      estimatedBytes: Math.round(b.compressed * 3 + extra[id]),
      versions: versions[id]
    };
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log('[lock] wrote infra/images/lock.json');
  for (const [id, p] of Object.entries(lock.profiles)) console.log(`[lock]   ${id}: context ${p.contextSha256}, ~${(p.estimatedBytes / 2 ** 20).toFixed(0)} MiB`);
}

/**
 * `--rehash` (no network): after a local edit of a context file (the entry script, a Dockerfile comment), recompute the
 * lockfile hashes and each profile's contextSha256 into lock.json; everything resolved from the network stays as locked.
 */
async function rehash() {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  for (const [id, p] of Object.entries(PROFILES)) {
    const l = lock.profiles?.[id];
    if (!l) die(`${id}: not in lock.json (run the tool without --rehash)`);
    const docker = fs.readFileSync(path.join(IMAGES, id, 'Dockerfile'), 'utf8');
    if (!docker.includes(`FROM ${l.base.ref}@${l.base.digest}`)) die(`${id}: the Dockerfile no longer pins the locked base`);
    l.lockfiles = Object.fromEntries(p.lockfiles.map((rel) => [rel, fileSha(rel)]));
    l.contextSha256 = await contextOf(id);
  }
  fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  for (const [id, p] of Object.entries(lock.profiles)) console.log(`[lock] ${id}: context ${p.contextSha256}`);
}

if (require.main === module) {
  const run = process.argv.includes('--check') ? check : process.argv.includes('--rehash') ? rehash : resolve;
  run().catch((e) => die(e && e.stack ? e.stack : String(e)));
}

module.exports = { PROFILES, pv, pvCmp, satisfies, marker, parseReq };
