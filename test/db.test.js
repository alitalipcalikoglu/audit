import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from '../src/db.js';

test('Stage 4 migration v1 -> v2: an existing database gains the anchors table on upgrade, with its v1 events intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-db-v1v2-'));
  const path = join(dir, 'audit.db');
  try {
    class V1Only extends Database {
      static MIGRATIONS = [Database.MIGRATIONS[0]];
    }
    const v1 = new V1Only(path);
    assert.equal(v1.schemaVersion, 1);
    v1.prepare(`INSERT INTO events (id, client_id, source, action, outcome, at, received_at, prev_hash, hash)
      VALUES ('e1', null, 'shop', 'a.b', 'success', 0, 0, ?, 'h1')`).run('0'.repeat(64));
    v1.close();

    const v2 = new Database(path); // this checkout's real MIGRATIONS: v1 events/checkpoints + v2 anchors
    assert.equal(v2.schemaVersion, 2);
    assert.equal(/** @type {any} */ (v2.prepare("SELECT COUNT(*) n FROM events").get()).n, 1, 'v1 event survived the upgrade');
    assert.equal(/** @type {any} */ (v2.prepare("SELECT COUNT(*) n FROM anchors").get()).n, 0, 'anchors table exists, empty (no historical anchor retrofitted)');
    v2.prepare(`INSERT INTO anchors (seq, hash, at, key_id, signature) VALUES (1, 'h1', 1000, 'kid1', 'sig1')`).run();
    assert.equal(/** @type {any} */ (v2.prepare("SELECT COUNT(*) n FROM anchors").get()).n, 1, 'usable immediately after the upgrade');
    v2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
