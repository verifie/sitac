/**
 * Minimal example of wiring SITAC into an Express-style update handler.
 * This is illustrative — adapt to your router and auth layer.
 */

'use strict';

const mysql = require('mysql2/promise');
const {
  sitacSnapshotAndStamp,
  sitacRestore,
  hasMaterialChange
} = require('sitac-core');

// ---------------------------------------------------------------------------
// Setup (normally done once at application start)
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'app',
  waitForConnections: true,
  connectionLimit: 10
});

// Columns that are allowed to be written by the client
const INVOICE_ALLOWED = ['status', 'total', 'notes', 'due_date', 'currency'];
// Columns that should never trigger a version snapshot
const INVOICE_NON_MATERIAL = new Set(['updated_at', 'last_viewed_at']);

// ---------------------------------------------------------------------------
// Update path
// ---------------------------------------------------------------------------
async function updateInvoice(req, res) {
  const invoiceId = Number(req.params.id);
  const editorId = req.user.id;          // from your auth middleware
  const body = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Snapshot if the change is material
    if (hasMaterialChange(body, INVOICE_ALLOWED, INVOICE_NON_MATERIAL)) {
      const result = await sitacSnapshotAndStamp(conn, {
        table: 'invoices',
        id: invoiceId,
        editorId,
        children: [
          { table: 'invoice_items', fk: 'invoice_id', liveOnly: true }
        ],
        nullColumns: [],                 // no secrets on this table
        versionName: true
      });

      if (result.skipped) {
        // Policy decision: refuse, or continue with a plain update
        console.warn(`[SITAC] snapshot skipped for invoice ${invoiceId}: ${result.skipped}`);
      }
    }

    // 2. Perform the actual business update
    //    (only the fields you trust)
    const sets = [];
    const vals = [];
    for (const col of INVOICE_ALLOWED) {
      if (body[col] !== undefined) {
        sets.push(`\`${col}\` = ?`);
        vals.push(body[col]);
      }
    }
    if (sets.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'No updatable fields supplied' });
    }
    vals.push(invoiceId);

    await conn.query(
      `UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      vals
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Restore path
// ---------------------------------------------------------------------------
async function restoreInvoice(req, res) {
  const invoiceId = Number(req.params.id);
  const editorId = req.user.id;

  const conn = await pool.getConnection();
  try {
    const result = await sitacRestore(conn, {
      table: 'invoices',
      id: invoiceId,
      editorId,
      children: [
        { table: 'invoice_items', fk: 'invoice_id' }
      ]
    });

    if (result.skipped) {
      return res.status(409).json({ error: `Cannot restore: ${result.skipped}` });
    }

    res.json({ ok: true, evidenceSnapshotId: result.snapshotId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Restore failed' });
  } finally {
    conn.release();
  }
}

module.exports = { updateInvoice, restoreInvoice };
