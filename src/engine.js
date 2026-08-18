'use strict';

/**
 * Dialect-agnostic SITAC engine.
 * Used by both the MySQL and PostgreSQL entry points.
 */

/** @type {Map<string, string[]>} */
const columnCache = new Map();

function cacheKey(dialectName, table) {
  return dialectName + ':' + table;
}

async function tableColumns(conn, dialect, table, forceRefresh = false) {
  const key = cacheKey(dialect.name, table);
  if (!forceRefresh && columnCache.has(key)) {
    return columnCache.get(key);
  }
  const names = await dialect.getColumns(conn, table);
  columnCache.set(key, names);
  return names;
}

function clearColumnCache() {
  columnCache.clear();
}

function assertCommonOpts(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('SITAC: options object is required');
  }
  if (typeof opts.table !== 'string' || !opts.table.trim()) {
    throw new TypeError('SITAC: opts.table must be a non-empty string');
  }
  if (opts.id == null || (typeof opts.id !== 'number' && typeof opts.id !== 'string')) {
    throw new TypeError('SITAC: opts.id must be a number or string');
  }
  if (opts.editorId == null) {
    throw new TypeError('SITAC: opts.editorId is required');
  }
  if (opts.children && !Array.isArray(opts.children)) {
    throw new TypeError('SITAC: opts.children must be an array');
  }
  if (opts.nullColumns && !Array.isArray(opts.nullColumns)) {
    throw new TypeError('SITAC: opts.nullColumns must be an array');
  }
}

/**
 * Build a parameter list helper that works for both ? and $n styles.
 */
function createParamBuilder(dialect) {
  const values = [];
  let idx = 0;
  return {
    add(value) {
      values.push(value);
      idx += 1;
      return dialect.placeholder(idx);
    },
    values() {
      return values;
    }
  };
}

/**
 * Normalize a raw query result into a plain rows array.
 * Handles both mysql2 ([rows, fields]) and node-postgres ({ rows }) shapes.
 */
function extractRows(result) {
  if (!result) return [];
  // node-postgres / postgres.js style
  if (result.rows && Array.isArray(result.rows)) {
    return result.rows;
  }
  // mysql2 SELECT: result is already the rows array when caller did const [rows] = ...
  // but here we receive the full return value of conn.query()
  if (Array.isArray(result)) {
    // mysql2: [rowsOrHeader, fields]
    const first = result[0];
    if (Array.isArray(first)) return first;          // SELECT
    if (first && typeof first === 'object') return []; // INSERT/UPDATE header → no rows
    return [];
  }
  return [];
}

/**
 * Archive the current state of `table` row `id`, then stamp the canonical.
 */
async function sitacSnapshotAndStamp(conn, dialect, opts) {
  assertCommonOpts(opts);
  if (!conn || typeof conn.query !== 'function') {
    throw new TypeError('SITAC: a valid database connection is required as the first argument');
  }

  const {
    table,
    id,
    editorId,
    children = [],
    nullColumns = [],
    versionName = false,
    forceRefreshColumns = false
  } = opts;

  const q = dialect.quote.bind(dialect);
  const nulled = new Set(nullColumns);

  await conn.beginTransaction();
  try {
    // 1. Lock and load the live canonical
    const pb = createParamBuilder(dialect);
    const liveSql = `SELECT * FROM ${q(table)} WHERE id = ${pb.add(id)} AND ${dialect.liveCanonicalCondition()} FOR UPDATE`;
    const liveResult = await conn.query(liveSql, pb.values());
    const live = extractRows(liveResult);

    if (!live.length) {
      await conn.rollback();
      return { skipped: 'not-live-canonical' };
    }
    const src = live[0];

    // 2. Build column list and expressions for the snapshot INSERT
    const names = (await tableColumns(conn, dialect, table, forceRefreshColumns)).filter(f => f !== 'id');
    const exprs = names.map(f => {
      if (nulled.has(f)) return 'NULL';
      if (f === 'uuid') return dialect.uuidExpr();
      if (f === 'deleted_at') return dialect.nowExpr();
      if (f === 'deleted_by') return String(parseInt(String(editorId), 10) || 0);
      if (f === 'is_snapshot') return dialect.trueExpr();
      return q(f);
    });

    const pb2 = createParamBuilder(dialect);
    const returning = dialect.name === 'postgres' ? ' RETURNING id' : '';
    const insertSql = `INSERT INTO ${q(table)} (${names.map(q).join(', ')})
      SELECT ${exprs.join(', ')} FROM ${q(table)} WHERE id = ${pb2.add(id)}${returning}`;

    const insertResult = await conn.query(insertSql, pb2.values());

    // Extract insert id according to dialect
    let snapshotId;
    if (dialect.name === 'mysql') {
      // mysql2: insertResult = [ResultSetHeader, fields]
      const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
      snapshotId = dialect.extractInsertId(header);
    } else {
      // postgres: insertResult = { rows: [{ id: ... }] }
      snapshotId = dialect.extractInsertId(insertResult);
    }

    // 3. Copy children
    for (const ch of children) {
      if (!ch.table || !ch.fk) {
        throw new TypeError('SITAC: each child config must have table and fk');
      }
      const chNames = (await tableColumns(conn, dialect, ch.table, forceRefreshColumns)).filter(f => f !== 'id');
      const chExprs = chNames.map(f => {
        if (f === 'uuid') return dialect.uuidExpr();
        if (f === ch.fk) return String(snapshotId);
        return q(f);
      });
      const pbCh = createParamBuilder(dialect);
      const childSql = `INSERT INTO ${q(ch.table)} (${chNames.map(q).join(', ')})
        SELECT ${chExprs.join(', ')} FROM ${q(ch.table)}
        WHERE ${q(ch.fk)} = ${pbCh.add(id)}${ch.liveOnly ? ' AND deleted_at IS NULL' : ''}`;
      await conn.query(childSql, pbCh.values());
    }

    // 4. Stamp the canonical
    const pb3 = createParamBuilder(dialect);
    const stamps = [
      `originating_id = ${pb3.add(snapshotId)}`,
      `created_at = ${dialect.nowExpr()}`,
      `created_by = ${pb3.add(editorId)}`
    ];

    if (versionName) {
      const vNum = parseInt(String(src.version_name || 'v1').replace(/[^0-9]/g, ''), 10) || 1;
      stamps.push(`version_name = ${pb3.add(`v${vNum + 1}`)}`);
    }

    const stampSql = `UPDATE ${q(table)} SET ${stamps.join(', ')} WHERE id = ${pb3.add(id)}`;
    await conn.query(stampSql, pb3.values());

    await conn.commit();
    return { snapshotId };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Restore a soft-deleted canonical row while preserving deletion evidence.
 */
async function sitacRestore(conn, dialect, opts) {
  assertCommonOpts(opts);
  if (!conn || typeof conn.query !== 'function') {
    throw new TypeError('SITAC: a valid database connection is required as the first argument');
  }

  const {
    table,
    id,
    editorId,
    children = [],
    nullColumns = [],
    extraSet = [],
    forceRefreshColumns = false
  } = opts;

  if (extraSet && !Array.isArray(extraSet)) {
    throw new TypeError('SITAC: opts.extraSet must be an array of SQL fragments');
  }

  const q = dialect.quote.bind(dialect);
  const nulled = new Set(nullColumns);

  await conn.beginTransaction();
  try {
    const pb = createParamBuilder(dialect);
    const deadSql = `SELECT * FROM ${q(table)} WHERE id = ${pb.add(id)} AND ${dialect.deletedCanonicalCondition()} FOR UPDATE`;
    const deadResult = await conn.query(deadSql, pb.values());
    const dead = extractRows(deadResult);

    if (!dead.length) {
      await conn.rollback();
      return { skipped: 'not-deleted-canonical' };
    }

    const names = (await tableColumns(conn, dialect, table, forceRefreshColumns)).filter(f => f !== 'id');
    const exprs = names.map(f => {
      if (nulled.has(f)) return 'NULL';
      if (f === 'uuid') return dialect.uuidExpr();
      if (f === 'is_snapshot') return dialect.trueExpr();
      // VERBATIM — deleted_at / deleted_by preserved as deletion evidence
      return q(f);
    });

    const pb2 = createParamBuilder(dialect);
    const returning = dialect.name === 'postgres' ? ' RETURNING id' : '';
    const insertSql = `INSERT INTO ${q(table)} (${names.map(q).join(', ')})
      SELECT ${exprs.join(', ')} FROM ${q(table)} WHERE id = ${pb2.add(id)}${returning}`;

    const insertResult = await conn.query(insertSql, pb2.values());

    let snapshotId;
    if (dialect.name === 'mysql') {
      const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
      snapshotId = dialect.extractInsertId(header);
    } else {
      snapshotId = dialect.extractInsertId(insertResult);
    }

    for (const ch of children) {
      if (!ch.table || !ch.fk) {
        throw new TypeError('SITAC: each child config must have table and fk');
      }
      const chNames = (await tableColumns(conn, dialect, ch.table, forceRefreshColumns)).filter(f => f !== 'id');
      const chExprs = chNames.map(f => {
        if (f === 'uuid') return dialect.uuidExpr();
        if (f === ch.fk) return String(snapshotId);
        return q(f);
      });
      const pbCh = createParamBuilder(dialect);
      const childSql = `INSERT INTO ${q(ch.table)} (${chNames.map(q).join(', ')})
        SELECT ${chExprs.join(', ')} FROM ${q(ch.table)}
        WHERE ${q(ch.fk)} = ${pbCh.add(id)}${ch.liveOnly ? ' AND deleted_at IS NULL' : ''}`;
      await conn.query(childSql, pbCh.values());
    }

    const pb3 = createParamBuilder(dialect);
    const stamps = [
      'deleted_at = NULL',
      'deleted_by = NULL',
      `created_at = ${dialect.nowExpr()}`,
      `created_by = ${pb3.add(editorId)}`,
      `originating_id = ${pb3.add(snapshotId)}`,
      ...extraSet
    ];

    const stampSql = `UPDATE ${q(table)} SET ${stamps.join(', ')} WHERE id = ${pb3.add(id)}`;
    await conn.query(stampSql, pb3.values());

    await conn.commit();
    return { snapshotId };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * True when any incoming field is material.
 */
function hasMaterialChange(body, allowed, nonMaterial) {
  const nonMat = nonMaterial instanceof Set ? nonMaterial : new Set(nonMaterial || []);
  return Object.keys(body || {}).some(k => allowed.includes(k) && !nonMat.has(k));
}

module.exports = {
  sitacSnapshotAndStamp,
  sitacRestore,
  hasMaterialChange,
  clearColumnCache,
  tableColumns
};
