'use strict';
// Child process for test 10b: start the v7 migration and exit while its transaction is open.
// `node --test test/` also runs helper files; without a database path this does nothing.
const file = process.argv[2];
if (file) {
  const path = require('node:path');
  const loadTs = require('../load-ts.cjs');
  const { PersistStore } = loadTs('src/main/db.ts');
  new PersistStore(file).open({ backupDir: path.join(path.dirname(file), 'backups'), log: () => {},
    hooks: { beforeCommit: () => process.exit(42) } });          // dies with the v7 transaction open
}
