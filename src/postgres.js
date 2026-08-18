/*!
 * SITAC — Stable-Identity Temporal Audit Chain
 * PostgreSQL entry point
 *
 * Usage:
 *   const { sitacSnapshotAndStamp, sitacRestore } = require('sitac-core/postgres');
 *
 * Compatible with the `pg` (node-postgres) client / PoolClient.
 * Requires PostgreSQL 13+ for gen_random_uuid() (or enable pgcrypto on older versions).
 */

'use strict';

const postgresDialect = require('./dialects/postgres');
const engine = require('./engine');

/**
 * Archive the current state of `table` row `id`, then stamp the canonical.
 * (PostgreSQL)
 *
 * @param {object} conn - Active pg client / PoolClient
 * @param {object} opts - See README
 * @returns {Promise<{snapshotId: number}|{skipped: string}>}
 */
function sitacSnapshotAndStamp(conn, opts) {
  return engine.sitacSnapshotAndStamp(conn, postgresDialect, opts);
}

/**
 * Restore a soft-deleted canonical row (PostgreSQL)
 *
 * @param {object} conn
 * @param {object} opts
 * @returns {Promise<{snapshotId: number}|{skipped: string}>}
 */
function sitacRestore(conn, opts) {
  return engine.sitacRestore(conn, postgresDialect, opts);
}

module.exports = {
  sitacSnapshotAndStamp,
  sitacRestore,
  hasMaterialChange: engine.hasMaterialChange,
  clearColumnCache: engine.clearColumnCache,
  // advanced
  tableColumns: (conn, table, forceRefresh) =>
    engine.tableColumns(conn, postgresDialect, table, forceRefresh)
};
