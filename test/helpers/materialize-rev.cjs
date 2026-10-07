'use strict';
// Writes the sources an old build of the store needs (db.ts, its queue and crash log,
// the platform core and the shared types) from a git revision into <dir>/old/, keeping
// their repository paths, so a downgrade test can load that build with load-ts.
// Read-only on the repository: git ls-tree and git show only, no checkout.
// `node --test test/` also runs helper files; requiring it does nothing by itself.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PATHS = ['src/main/db.ts', 'src/main/legacyWriteQueue.ts', 'src/main/crashLog.ts', 'src/main/nexus', 'src/shared'];

/** Returns the absolute path of the old src/main/db.ts under <dir>/old. Throws when the revision is not available. */
function materializeRev(rev, dir) {
  const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = git(['ls-tree', '-r', '--name-only', rev, '--', ...PATHS]).split('\n').map((f) => f.trim()).filter(Boolean);
  if (!files.includes('src/main/db.ts')) throw new Error(`${rev} has no src/main/db.ts`);
  const root = path.join(dir, 'old');
  for (const f of files) {
    const out = path.join(root, ...f.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, git(['show', `${rev}:${f}`]));
  }
  return path.join(root, 'src', 'main', 'db.ts');
}

module.exports = { materializeRev };
