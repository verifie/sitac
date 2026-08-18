'use strict';

/**
 * MySQL dialect for sitac-core.
 * Compatible with mysql2 promise connections.
 */

module.exports = {
  name: 'mysql',

  /** Quote an identifier (table or column) */
  quote(id) {
    return '`' + String(id).replace(/`/g, '``') + '`';
  },

  /** Placeholder for the n-th parameter (1-based index) */
  placeholder(_n) {
    return '?';
  },

  uuidExpr() {
    return 'UUID()';
  },

  nowExpr() {
    return 'NOW()';
  },

  trueExpr() {
    return 'TRUE';
  },

  /** SQL fragment: row is a live canonical */
  liveCanonicalCondition() {
    return 'deleted_at IS NULL AND COALESCE(is_snapshot, 0) = 0';
  },

  /** SQL fragment: row is a deleted canonical */
  deletedCanonicalCondition() {
    return 'deleted_at IS NOT NULL AND COALESCE(is_snapshot, 0) = 0';
  },

  /**
   * Return column names for a table.
   * @param {object} conn
   * @param {string} table
   * @returns {Promise<string[]>}
   */
  async getColumns(conn, table) {
    const [cols] = await conn.query(`SHOW COLUMNS FROM ${this.quote(table)}`);
    return cols.map(c => c.Field);
  },

  /**
   * Extract the auto-generated id from an INSERT result.
   * mysql2: query returns [ResultSetHeader, fields], ResultSetHeader.insertId
   */
  extractInsertId(queryResult) {
    // queryResult is the first element of the array returned by mysql2
    if (queryResult && typeof queryResult.insertId === 'number') {
      return queryResult.insertId;
    }
    throw new Error('SITAC (mysql): could not extract insertId from query result');
  },

  /**
   * Normalize the raw result of conn.query into { rows, raw }
   * mysql2 already returns [rowsOrHeader, fields]
   */
  normalizeQueryResult(result) {
    // Caller does: const [first] = await conn.query(...)
    // so `result` here is already the first element.
    return { rows: Array.isArray(result) ? result : [], raw: result };
  }
};
