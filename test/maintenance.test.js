import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Maintenance } from '../src/maintenance.js';
import { EventStore } from '../src/store/event-store.js';
import { memoryDb, record } from './helpers.js';

const silent = /** @type {any} */ ({ info() {}, error() {} });

test('Maintenance: purges by retention and leaves the chain verifiable', () => {
  const store = new EventStore(memoryDb());
  const day = 86_400_000;
  const now = 1_700_000_000_000;
  store.append([record({ receivedAt: now - 10 * day }), record({ receivedAt: now - 8 * day }), record({ receivedAt: now - 1 * day })]);
  const m = new Maintenance({ events: store, log: silent, options: { retentionDays: 7 } });
  assert.deepEqual(m.run(now), { deleted: 2, checkpointSeq: 2 });
  assert.equal(store.count({}), 1);
  assert.equal(store.minSeq(), 3);
  assert.ok(store.trustedPrevHash(3));
  assert.deepEqual(m.run(now), { deleted: 0, checkpointSeq: null });
  m.start();
  assert.ok(m.timer);
  m.stop();
  assert.equal(m.timer, null);
});

test('Maintenance: swallows store errors', () => {
  const broken = /** @type {any} */ ({ purge() { throw new Error('boom'); } });
  let logged = false;
  const m = new Maintenance({ events: broken, log: /** @type {any} */ ({ info() {}, error() { logged = true; } }), options: { retentionDays: 1 } });
  assert.equal(m.run(), null);
  assert.ok(logged);
});
