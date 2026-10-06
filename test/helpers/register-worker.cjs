'use strict';
const { parentPort, workerData } = require('node:worker_threads');
// node --test test/ also loads this file directly; it only does work inside a worker.
if (!parentPort || !workerData) return;
const loadTs = require('../load-ts.cjs');
const Database = require('better-sqlite3');
const { createNexusPlatform } = loadTs('src/main/nexus/platform.ts');
const db = new Database(workerData.file); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 10000'); db.pragma('foreign_keys = ON');
const nx = createNexusPlatform(db, {});
const me = nx.principals.localUser();
for (let i = 0; i < workerData.n; i++) nx.artifacts.registerVersion(me, { artifactId: workerData.artifactId, storage: { kind: 'inline', json: { i, t: Math.random() } } });
db.close(); parentPort.postMessage('done');
