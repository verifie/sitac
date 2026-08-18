'use strict';

/**
 * Basic test suite for sitac-core.
 *
 * The pure helper tests run without a database.
 * Integration tests require a MySQL instance and are skipped unless
 * SITAC_TEST_DB=1 is set and a test database is available.
 *
 * Run with:  node --test test/sitac.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  hasMaterialChange,
  clearColumnCache,
  sitacSnapshotAndStamp,
  sitacRestore
} = require('../src/index.js');

describe('hasMaterialChange', () => {
  it('returns true when a material field is present', () => {
    const body = { status: 'paid', notes: 'hello' };
    const allowed = ['status', 'total', 'notes'];
    const nonMaterial = new Set(['updated_at']);
    assert.equal(hasMaterialChange(body, allowed, nonMaterial), true);
  });

  it('returns false when only non-material fields are present', () => {
    const body = { updated_at: '2026-01-01' };
    const allowed = ['status', 'updated_at'];
    const nonMaterial = ['updated_at'];
    assert.equal(hasMaterialChange(body, allowed, nonMaterial), false);
  });

  it('returns false for empty or null body', () => {
    assert.equal(hasMaterialChange(null, ['a'], []), false);
    assert.equal(hasMaterialChange({}, ['a'], []), false);
  });

  it('accepts both Set and array for nonMaterial', () => {
    const body = { status: 'x' };
    assert.equal(hasMaterialChange(body, ['status'], new Set(['status'])), false);
    assert.equal(hasMaterialChange(body, ['status'], ['status']), false);
  });
});

describe('input validation', () => {
  const fakeConn = {
    query: async () => [[]],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {}
  };

  it('rejects missing options', async () => {
    await assert.rejects(
      () => sitacSnapshotAndStamp(fakeConn, null),
      { name: 'TypeError', message: /options object is required/ }
    );
  });

  it('rejects missing table', async () => {
    await assert.rejects(
      () => sitacSnapshotAndStamp(fakeConn, { id: 1, editorId: 1 }),
      { name: 'TypeError', message: /table must be/ }
    );
  });

  it('rejects missing connection', async () => {
    await assert.rejects(
      () => sitacSnapshotAndStamp(null, { table: 't', id: 1, editorId: 1 }),
      { name: 'TypeError', message: /valid database connection/ }
    );
  });

  it('rejects invalid children', async () => {
    await assert.rejects(
      () => sitacSnapshotAndStamp(fakeConn, {
        table: 't', id: 1, editorId: 1, children: 'not-an-array'
      }),
      { name: 'TypeError', message: /children must be an array/ }
    );
  });
});

describe('clearColumnCache', () => {
  it('can be called without error', () => {
    clearColumnCache();
  });
});

// ---------------------------------------------------------------------------
// Integration tests (opt-in)
// ---------------------------------------------------------------------------
const runIntegration = process.env.SITAC_TEST_DB === '1';

describe('integration (requires MySQL)', { skip: !runIntegration }, () => {
  // These tests are placeholders. Wire them to a real test database
  // that has the required SITAC columns on a sample table.
  it('placeholder — implement against your test schema', async () => {
    assert.ok(true, 'Add real integration tests here');
  });
});
