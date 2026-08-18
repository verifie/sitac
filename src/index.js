/*!
 * SITAC — Stable-Identity Temporal Audit Chain
 * Reference implementation (CSDRS-DATA-001)
 *
 * @author    Paul Emerton
 * @license   MIT
 *
 * Default entry point — MySQL dialect (mysql2 compatible).
 * For PostgreSQL use: require('sitac-core/postgres')
 */

'use strict';

const mysqlDialect = require('./dialects/mysql');
const engine = require('./engine');

/**
 * Archive the current state of `table` row `id`, then stamp the canonical.
 * (MySQL / mysql2)
 *
 * @param {object} conn - Active mysql2 connection
 * @param {object} opts - See README
 * @returns {Promise<{snapshotId: number}|{skipped: string}>}
 */
function sitacSnapshotAndStamp(conn, opts) {
  return engine.sitacSnapshotAndStamp(conn, mysqlDialect, opts);
}

/**
 * Restore a soft-deleted canonical row (MySQL / mysql2)
 *
 * @param {object} conn
 * @param {object} opts
 * @returns {Promise<{snapshotId: number}|{skipped: string}>}
 */
function sitacRestore(conn, opts) {
  return engine.sitacRestore(conn, mysqlDialect, opts);
}

module.exports = {
  sitacSnapshotAndStamp,
  sitacRestore,
  hasMaterialChange: engine.hasMaterialChange,
  clearColumnCache: engine.clearColumnCache,
  // advanced
  tableColumns: (conn, table, forceRefresh) =>
    engine.tableColumns(conn, mysqlDialect, table, forceRefresh)
};
