'use strict';

/**
 * PostgreSQL dialect for sitac-core.
 * Compatible with the `pg` (node-postgres) promise API and similar drivers
 * that return { rows, rowCount, ... } from client.query().
 *
 * Notes:
 * - Uses $1, $2, ... placeholders.
 * - Uses RETURNING id so we can obtain the new primary key.
 * - gen_random_uuid() requires PostgreSQL 13+ (or the pgcrypto extension on older versions).
 * - Table/column names are quoted with double quotes to preserve case.
 * - Recommended schema uses boolean for is_snapshot; the conditions also tolerate integer 0/1.
 */

module.exports = {
  name: 'postgres',

  quote(id) {
    return '"' + String(id).replace(/"/g, '""') + '"';
  },

  placeholder(n) {
    return '$' + n;
  },

  uuidExpr() {
    return 'gen_random_uuid()';
  },

  nowExpr() {
    return 'NOW()';
  },

  trueExpr() {
    return 'TRUE';
  },

  liveCanonicalCondition() {
    // Works for boolean false/NULL and for smallint/int 0/NULL
    return 'deleted_at IS NULL AND (is_snapshot IS NOT TRUE)';
  },

  deletedCanonicalCondition() {
    return 'deleted_at IS NOT NULL AND (is_snapshot IS NOT TRUE)';
  },

  async getColumns(conn, table) {
    // Use information_schema so we do not require a specific search_path trick.
    // Assumes the table is in the current schema (or public).
    const res = await conn.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
        ORDER BY ordinal_position`,
      [table]
    );
    const rows = res.rows || res[0] || [];
    return rows.map(r => r.column_name);
  },

  /**
   * Extract the new id. We always use INSERT ... RETURNING id,
   * so the result contains rows[0].id
   */
  extractInsertId(queryResult) {
    const rows = queryResult.rows || (Array.isArray(queryResult) ? queryResult : null);
    if (rows && rows[0] && rows[0].id != null) {
      return rows[0].id;
    }
    throw new Error('SITAC (postgres): could not extract id from INSERT ... RETURNING result');
  },

  normalizeQueryResult(result) {
    // node-postgres: result = { rows, rowCount, ... }
    if (result && Array.isArray(result.rows)) {
      return { rows: result.rows, raw: result };
    }
    // Fallback if a driver already returns rows array
    if (Array.isArray(result)) {
      return { rows: result, raw: result };
    }
    return { rows: [], raw: result };
  }
};
