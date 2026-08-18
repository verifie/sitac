# sitac-core

**Stable-Identity Temporal Audit Chain**  
Reference implementation of the CSDRS-DATA-001 specification.

Production-proven copy-before-write versioning that keeps foreign keys stable forever, archives complete historical states (including child rows), and preserves deletion evidence on restore.

Designed for systems that must answer the two questions every auditor asks:

> “What did this record say on that date, and who changed it?”

Compatible with the compliance narratives required by **ISO 27001**, **SOC 2**, and **UK GDPR** (accountability & storage limitation).

---

## Official documentation

This library is the reference implementation of the controlled specifications published by SPAWN.LONDON:

| Document | Description |
|----------|-------------|
| [CSDRS-DATA-001](docs/Core_Software_Design_Requirements_Specification_CSDRS_v1.0.pdf) | Core Software Design Requirements Specification — mandatory architectural requirements for Stable-Identity Temporal Audit Chain |
| [SITAC White Paper](docs/SITAC_Stable_Identity_Temporal_Audit_Chain_White_Paper_v1.0.pdf) | Full white paper: problem statement, formal definition, normative principles, lifecycle, security, ISO 27001 alignment and conformance |

Both documents are included in the `docs/` folder of this repository.

---

## Why SITAC exists

Most application-level versioning approaches either:

- break foreign keys (new row = new id), or
- lose the fact that a record was deleted (and by whom), or
- force every consumer query to remember complicated “as-of” logic.

SITAC keeps the **canonical row identity forever**. History is stored as immutable snapshot rows linked by `originating_id`. Soft-deleted records can be restored while the original deletion stamp survives in the chain as evidence.

The library is deliberately small, dependency-light, and table-agnostic.

---

## Installation

```bash
npm install sitac-core
```

### MySQL (default)

```bash
npm install mysql2
```

```js
const { sitacSnapshotAndStamp, sitacRestore } = require('sitac-core');
// or explicitly: require('sitac-core/mysql')
```

### PostgreSQL

```bash
npm install pg
```

```js
const { sitacSnapshotAndStamp, sitacRestore } = require('sitac-core/postgres');
```

Requires **PostgreSQL 13+** (for `gen_random_uuid()`). On older versions enable the `pgcrypto` extension:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

---

## Core concepts (read once)

| Term | Meaning |
|------|---------|
| **Canonical row** | The live row. Its `id` / `uuid` never changes. All foreign keys point here. |
| **Snapshot row** | An immutable historical copy. `is_snapshot = 1`, `deleted_at` set to the moment it was superseded. |
| **originating_id** | Points from the current version to the previous snapshot, forming a chain. |
| **nullColumns** | Columns that must never appear in history (passwords, secrets, oversized blobs). |
| **Children** | Related rows (line items, steps, etc.) that are copied with the parent so a historical version is complete. |

**Required columns on every versioned table** (add via migration):

**MySQL**

```sql
originating_id  BIGINT UNSIGNED NULL,   -- link to previous snapshot
is_snapshot     TINYINT(1) NOT NULL DEFAULT 0,
deleted_at      DATETIME NULL,
deleted_by      INT UNSIGNED NULL,
-- recommended:
uuid            CHAR(36) NOT NULL,
created_at      DATETIME NOT NULL,
created_by      INT UNSIGNED NOT NULL,
version_name    VARCHAR(16) NULL          -- optional, for human-readable v1, v2…
```

**PostgreSQL**

```sql
originating_id  BIGINT NULL,             -- link to previous snapshot
is_snapshot     BOOLEAN NOT NULL DEFAULT FALSE,
deleted_at      TIMESTAMPTZ NULL,
deleted_by      INTEGER NULL,
-- recommended:
uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
created_by      INTEGER NOT NULL,
version_name    VARCHAR(16) NULL
```

---

## Quick start (MySQL)

```js
const mysql = require('mysql2/promise');
const {
  sitacSnapshotAndStamp,
  sitacRestore,
  hasMaterialChange,
  clearColumnCache
} = require('sitac-core');

const pool = mysql.createPool({ /* your config */ });

// ------------------------------------------------------------------
// 1. Before a material update
// ------------------------------------------------------------------
async function updateInvoice(invoiceId, body, editorId) {
  const conn = await pool.getConnection();
  try {
    // Decide whether this change is material
    const allowed = ['status', 'total', 'notes', 'due_date'];
    const nonMaterial = new Set(['updated_at', 'last_viewed_at']);

    if (hasMaterialChange(body, allowed, nonMaterial)) {
      const result = await sitacSnapshotAndStamp(conn, {
        table: 'invoices',
        id: invoiceId,
        editorId,
        children: [
          { table: 'invoice_items', fk: 'invoice_id', liveOnly: true }
        ],
        nullColumns: [],           // none on this table
        versionName: true
      });

      if (result.skipped) {
        // Row was already deleted or is a snapshot — decide policy
        console.warn('SITAC skipped:', result.skipped);
      }
    }

    // Now perform the real business update
    await conn.query(
      'UPDATE invoices SET status = ?, total = ?, notes = ? WHERE id = ?',
      [body.status, body.total, body.notes, invoiceId]
    );

    await conn.commit();   // if you opened a transaction yourself
  } finally {
    conn.release();
  }
}

// ------------------------------------------------------------------
// 2. Restoring a soft-deleted record
// ------------------------------------------------------------------
async function restoreInvoice(invoiceId, editorId) {
  const conn = await pool.getConnection();
  try {
    const result = await sitacRestore(conn, {
      table: 'invoices',
      id: invoiceId,
      editorId,
      children: [
        { table: 'invoice_items', fk: 'invoice_id' }
      ],
      // extraSet: ['do_not_show = FALSE']   // optional extra stamps
    });

    if (result.skipped) {
      throw new Error(`Cannot restore: ${result.skipped}`);
    }
    return result.snapshotId;   // the snapshot that preserves the deletion evidence
  } finally {
    conn.release();
  }
}
```

---

## API

### `sitacSnapshotAndStamp(conn, opts) → Promise<Result>`

Creates an immutable snapshot of the live canonical row, then stamps the canonical with the new version metadata. Everything runs inside a single transaction with `FOR UPDATE`.

**Result**

```ts
{ snapshotId: number }          // success
| { skipped: 'not-live-canonical' }
```

### `sitacRestore(conn, opts) → Promise<Result>`

Restores a soft-deleted canonical while preserving the original deletion evidence inside a new snapshot.

**Result**

```ts
{ snapshotId: number }
| { skipped: 'not-deleted-canonical' }
```

### `hasMaterialChange(body, allowed, nonMaterial) → boolean`

Helper to decide whether an incoming payload should trigger a snapshot.

### `clearColumnCache()`

Call after any migration that adds, drops or renames columns on versioned tables.

---

## Connection contract

SITAC never opens or closes connections. You pass an already-acquired connection that implements:

```ts
interface SitacConnection {
  query(sql: string, params?: any[]): Promise<[any, any]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

This matches `mysql2` connections from `pool.getConnection()`.

---

## Security notes

- **Table and column names are interpolated** (with backticks). Only pass trusted identifiers.
- Always list credential / secret columns in `nullColumns`. History must never become a replayable secret store.
- The library performs no authentication or authorisation — that remains your responsibility.

---

## Schema migration helper (example)

```sql
-- Example migration for a table you want to bring under SITAC
ALTER TABLE invoices
  ADD COLUMN originating_id BIGINT UNSIGNED NULL AFTER id,
  ADD COLUMN is_snapshot TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN deleted_at DATETIME NULL,
  ADD COLUMN deleted_by INT UNSIGNED NULL,
  ADD COLUMN uuid CHAR(36) NOT NULL DEFAULT (UUID()),
  ADD INDEX idx_invoices_originating (originating_id),
  ADD INDEX idx_invoices_snapshot (is_snapshot),
  ADD INDEX idx_invoices_deleted (deleted_at);
```

---

## What this library deliberately does *not* do

- It does not invent a new query language or “as-of” helper. You continue to write normal SQL against the canonical rows.
- It does not force every table into full versioning. Use the Tier 1 / 2 / 3 method described in the CSDRS specification.
- It does not include UI components or auditor report generators (those are available commercially).

---

## Commercial services & support

This open-source engine is maintained by **SITAC Consultancy**.

- Implementation sprints
- Readiness audits against ISO 27001 / SOC 2 / UK GDPR
- Team training workshops
- Version-history UI kit and compliance evidence generator (paid)

Professional implementation, audit support and training services are available from the author.

---

## Licence

MIT © 2024-2026 Paul Emerton

You are free to use, modify and embed this engine in commercial products. Attribution via the copyright notice is required.
