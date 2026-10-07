'use strict';
// B1 Task 7: the orphan queries O1-O9. `orphans(db)` returns { O1: n, ..., O9: n }; after any sequence of normal
// UI operations every count must be 0. `orphanRows(db)` returns the offending rows themselves, for messages.
// Pure reads: nothing here writes. The v8 queries (O3-O6) count 0 on a database without the handoff tables.
const loadTs = require('../load-ts.cjs');

const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Each query selects the offending rows (one id-like column `id` plus context). */
const QUERIES = {
  // O1 artifacts with no version.
  O1: () => `SELECT a.id FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.artifact_id = a.id)`,
  // O2 artifacts whose current_version_id is not an active version of the same artifact.
  O2: () => `SELECT a.id, a.current_version_id AS current FROM artifacts a WHERE a.current_version_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.id = a.current_version_id AND v.artifact_id = a.id AND v.status = 'active')`,
  // O3 handoffs whose subject count differs from subject_count.
  O3: (v8) => v8 ? `SELECT h.id, h.subject_count AS declared,
      (SELECT COUNT(*) FROM handoff_subjects s WHERE s.handoff_id = h.id) AS actual FROM handoffs h
    WHERE h.subject_count <> (SELECT COUNT(*) FROM handoff_subjects s WHERE s.handoff_id = h.id)` : null,
  // O4 accepted handoffs with no receipt, or a receipt not owned by to_participation_id.
  O4: (v8) => v8 ? `SELECT h.id, h.receipt_version_id AS receipt FROM handoffs h WHERE h.status = 'accepted' AND (
      h.receipt_version_id IS NULL OR NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.id = h.receipt_version_id AND a.kind = 'handoff_receipt' AND a.owner_participation_id = h.to_participation_id))` : null,
  // O5 handoff_receipt artifacts that no handoff points at.
  O5: (v8) => v8 ? `SELECT a.id FROM artifacts a WHERE a.kind = 'handoff_receipt' AND NOT EXISTS (
      SELECT 1 FROM handoffs h JOIN artifact_versions v ON v.id = h.receipt_version_id WHERE v.artifact_id = a.id)`
    : `SELECT a.id FROM artifacts a WHERE a.kind = 'handoff_receipt'`,
  // O6 handoff_convert edges whose from is not the receipt of an accepted handoff, or whose to is not one of its subjects.
  O6: (v8) => v8 ? `SELECT e.id, e.from_version_id AS fromV, e.to_version_id AS toV FROM artifact_edges e
    WHERE e.source = 'handoff_convert' AND NOT EXISTS (SELECT 1 FROM handoffs h JOIN handoff_subjects s ON s.handoff_id = h.id
      WHERE h.status = 'accepted' AND h.receipt_version_id = e.from_version_id AND s.version_id = e.to_version_id)`
    : `SELECT e.id FROM artifact_edges e WHERE e.source = 'handoff_convert'`,
  // O7 versions whose participation_id is not their artifact's owner participation.
  O7: () => `SELECT v.id, v.participation_id AS versionParticipation, a.owner_participation_id AS owner FROM artifact_versions v
    JOIN artifacts a ON a.id = v.artifact_id WHERE v.participation_id IS NOT a.owner_participation_id`,
  // O8 participations, artifacts, versions, handoffs or edges naming a missing project (beside foreign_key_check).
  O8: (v8) => [
    `SELECT 'project_workspaces' AS t, id FROM project_workspaces WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifacts' AS t, id FROM artifacts WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifact_versions' AS t, id FROM artifact_versions WHERE project_id NOT IN (SELECT id FROM projects)`,
    `SELECT 'artifact_edges' AS t, e.id FROM artifact_edges e WHERE NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN projects p ON p.id = v.project_id
       WHERE v.id = e.from_version_id) OR NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN projects p ON p.id = v.project_id WHERE v.id = e.to_version_id)`,
    ...(v8 ? [`SELECT 'handoffs' AS t, id FROM handoffs WHERE project_id NOT IN (SELECT id FROM projects)`] : [])
  ].join(' UNION ALL '),
  // O9 succeeded mutation rows in activity whose entity_id names no row in the matching table.
  O9: (v8) => `SELECT a.seq AS id, a.action, a.entity_id AS entity FROM activity a WHERE a.status = 'succeeded' AND (
      (substr(a.action, 1, 9) = 'artifact.' AND NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.id = a.entity_id))
   OR (substr(a.action, 1, 8) = 'version.' AND NOT EXISTS (SELECT 1 FROM artifact_versions x WHERE x.id = a.entity_id))
   OR (a.action = 'lineage.write' AND NOT EXISTS (SELECT 1 FROM artifact_edges x WHERE x.id = a.entity_id))
   OR (substr(a.action, 1, 8) = 'handoff.' AND ${v8 ? 'NOT EXISTS (SELECT 1 FROM handoffs x WHERE x.id = a.entity_id)' : '1'})
   OR (substr(a.action, 1, 14) = 'participation.' AND NOT EXISTS (SELECT 1 FROM project_workspaces x WHERE x.id = a.entity_id)))`
};
const IDS = Object.freeze(Object.keys(QUERIES));

function orphanRows(db) {
  const v8 = hasTable(db, 'handoffs') && hasTable(db, 'handoff_subjects');
  const out = {};
  for (const id of IDS) {
    const sql = QUERIES[id](v8);
    out[id] = sql ? db.prepare(sql).all() : [];
  }
  return out;
}

function orphans(db) {
  const rows = orphanRows(db);
  return Object.fromEntries(IDS.map((id) => [id, rows[id].length]));
}

/** Every check the flows end with: orphans all 0, foreign_key_check empty, integrity_check ok, the activity chain verifies. */
function storeHealth(db) {
  const { verifyActivityChain } = loadTs('src/main/nexus/activity/writer.ts');
  return {
    orphans: orphans(db),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    integrity: db.pragma('integrity_check', { simple: true }),
    chain: verifyActivityChain(db)
  };
}

const ZERO = Object.freeze(Object.fromEntries(IDS.map((id) => [id, 0])));

module.exports = { orphans, orphanRows, storeHealth, ORPHAN_IDS: IDS, ZERO };
