'use strict';
// Child process for test 10b: start the v7 migration and get killed while its transaction is open.
// cache_size=1 forces dirty pages out to the WAL before COMMIT, so the database file really
// carries uncommitted frames when the process dies. Before dying it reports the WAL size.
// With a second argument `v8` it opens a v7 file and dies inside the v8 transaction instead.
// `node --test test/` also runs helper files; without a database path this does nothing.
const file = process.argv[2];
const onlyV8 = process.argv[3] === 'v8';
if (file) {
  const fs = require('node:fs');
  const path = require('node:path');
  const loadTs = require('../load-ts.cjs');
  const { PersistStore } = loadTs('src/main/db.ts');
  new PersistStore(file).open({ backupDir: path.join(path.dirname(file), 'backups'), log: () => {},
    hooks: {
      beforeTransaction: (db) => { db.pragma('cache_size = 1'); },
      beforeCommit: (_db, toVersion) => {
        if (onlyV8 && toVersion !== 8) return;
        let wal = 0;
        try { wal = fs.statSync(`${file}-wal`).size; } catch { /* no WAL */ }
        fs.writeSync(1, `IN_TXN wal=${wal}\n`);
        process.kill(process.pid, 'SIGKILL');   // no exit handlers, no rollback by the process
      }
    } });
  fs.writeSync(1, 'NOT_KILLED\n');
}
