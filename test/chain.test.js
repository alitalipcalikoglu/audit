import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canonical, HashChain } from '../src/chain.js';
import { Redactor } from '../src/redactor.js';
import { EventStore } from '../src/store/event-store.js';
import { memoryDb, record } from './helpers.js';

test('Canonical: key order independent, undefined dropped, nested', () => {
  assert.equal(Canonical.stringify({ b: 1, a: [3, { d: null, c: 'x' }], z: undefined }), '{"a":[3,{"c":"x","d":null}],"b":1}');
  assert.equal(Canonical.stringify({ a: 1, b: 2 }), Canonical.stringify({ b: 2, a: 1 }));
  assert.throws(() => Canonical.stringify({ n: Infinity }), /non-finite/);
});

test('Redactor: matches normalised keys deeply, leaves input untouched', () => {
  const r = new Redactor(['password', 'apikey']);
  const input = { user: 'a', password: 'p', nested: [{ api_key: 'k', ok: 1 }, { 'API-KEY': 'x' }] };
  const out = r.apply(input);
  assert.deepEqual(out, { user: 'a', password: '[REDACTED]', nested: [{ api_key: '[REDACTED]', ok: 1 }, { 'API-KEY': '[REDACTED]' }] });
  assert.equal(input.password, 'p');
  assert.equal(new Redactor([]).apply(input), input);
});

test('HashChain: append links rows, verify passes, tamper detected', () => {
  const db = memoryDb();
  const store = new EventStore(db);
  assert.deepEqual(store.head(), { seq: 0, hash: HashChain.GENESIS });
  const out = store.append([record({ action: 'a.one' }), record({ action: 'a.two', meta: '{"k":1}' }), record({ action: 'a.three' })]);
  assert.equal(out.length, 3);
  assert.equal(out[0].row.prev_hash, HashChain.GENESIS);
  assert.equal(out[1].row.prev_hash, out[0].row.hash);
  assert.equal(out[2].row.prev_hash, out[1].row.hash);
  assert.deepEqual(store.head(), { seq: 3, hash: out[2].row.hash });

  const ok = HashChain.verify(store.range(1, 3, 10), HashChain.GENESIS);
  assert.deepEqual(ok, { checked: 3, firstBroken: null, lastSeq: 3, lastHash: out[2].row.hash });

  db.raw.prepare(`UPDATE events SET action = 'a.tampered' WHERE seq = 2`).run();
  const bad = HashChain.verify(store.range(1, 3, 10), HashChain.GENESIS);
  assert.equal(bad.checked, 1);
  assert.equal(bad.firstBroken, 2);

  db.raw.prepare(`DELETE FROM events WHERE seq = 2`).run();
  const gap = HashChain.verify(store.range(1, 3, 10), HashChain.GENESIS);
  assert.equal(gap.firstBroken, 3);
});

test('EventStore: idempotent client ids per source', () => {
  const store = new EventStore(memoryDb());
  const a = store.append([record({ clientId: 'c1', source: 'shop' })]);
  const b = store.append([record({ clientId: 'c1', source: 'shop' }), record({ clientId: 'c1', source: 'other' })]);
  assert.equal(a[0].duplicate, false);
  assert.equal(b[0].duplicate, true);
  assert.equal(b[0].row.id, a[0].row.id);
  assert.equal(b[1].duplicate, false);
  assert.equal(store.count({}), 2);
});

test('EventStore: filters, prefix range and keyset paging', () => {
  const store = new EventStore(memoryDb());
  const t0 = 1_700_000_000_000;
  store.append([
    record({ action: 'auth.login', at: t0 + 1, actor: { type: 'user', id: 'u1' }, outcome: 'failure' }),
    record({ action: 'auth.login', at: t0 + 2, actor: { type: 'user', id: 'u2' } }),
    record({ action: 'auth.logout', at: t0 + 2, actor: { type: 'user', id: 'u1' } }),
    record({ action: 'authz.deny', at: t0 + 3, outcome: 'denied', actor: { type: 'service', id: 's1' } }),
    record({ action: 'order.create', at: t0 + 4, source: 'shop', actor: null, target: { type: 'order', id: 'o9' } }),
  ]);
  assert.equal(store.count({ actionPrefix: 'auth.' }), 3);
  assert.equal(store.count({ action: 'auth.login' }), 2);
  assert.equal(store.count({ actorId: 'u1' }), 2);
  assert.equal(store.count({ outcome: 'denied' }), 1);
  assert.equal(store.count({ targetType: 'order', targetId: 'o9' }), 1);
  assert.equal(store.count({ from: t0 + 2, to: t0 + 4 }), 3);

  const page1 = store.list({}, { limit: 2 });
  assert.deepEqual(page1.map((r) => r.action), ['order.create', 'authz.deny']);
  const last = page1[1];
  const page2 = store.list({}, { limit: 2, before: { at: last.at, seq: last.seq } });
  assert.deepEqual(page2.map((r) => r.action), ['auth.logout', 'auth.login']);
  const page3 = store.list({}, { limit: 2, before: { at: page2[1].at, seq: page2[1].seq } });
  assert.deepEqual(page3.map((r) => r.action), ['auth.login']);
  assert.deepEqual([...store.iterate({ actionPrefix: 'auth.' }, 2)].map((r) => r.action), ['auth.login', 'auth.login']);
});

test('EventStore: purge keeps a verifiable chain via checkpoint', () => {
  const store = new EventStore(memoryDb());
  const t0 = 1_700_000_000_000;
  const rows = store.append([record({ receivedAt: t0 }), record({ receivedAt: t0 + 1 }), record({ receivedAt: t0 + 100 }), record({ receivedAt: t0 + 101 })]);
  assert.deepEqual(store.purge(t0 + 50, t0 + 200), { deleted: 2, checkpointSeq: 2 });
  assert.equal(store.minSeq(), 3);
  assert.equal(store.trustedPrevHash(3), rows[1].row.hash);
  assert.equal(store.trustedPrevHash(4), rows[2].row.hash);
  const v = HashChain.verify(store.range(3, 4, 10), /** @type {string} */ (store.trustedPrevHash(3)));
  assert.deepEqual(v, { checked: 2, firstBroken: null, lastSeq: 4, lastHash: rows[3].row.hash });
  assert.deepEqual(store.purge(t0 + 50, t0 + 200), { deleted: 0, checkpointSeq: null });
  // Everything purged: head falls back to the checkpoint and new events continue the chain.
  assert.deepEqual(store.purge(t0 + 1_000, t0 + 2_000), { deleted: 2, checkpointSeq: 4 });
  assert.deepEqual(store.head(), { seq: 4, hash: rows[3].row.hash });
  const next = store.append([record()]);
  assert.equal(next[0].row.prev_hash, rows[3].row.hash);
  assert.equal(next[0].row.seq, 5);
  assert.equal(store.trustedPrevHash(5), rows[3].row.hash);
  assert.equal(store.trustedPrevHash(7), null);
});

test('EventStore: stats and counts', () => {
  const store = new EventStore(memoryDb());
  const now = Date.now();
  store.append([record({ at: now - 10, outcome: 'failure', action: 'x.a' }), record({ at: now - 5, action: 'x.a' }), record({ at: now - 1, action: 'x.b', source: 'other', actor: null })]);
  const s = store.stats(now - 3_600_000);
  assert.deepEqual(s.byOutcome, { failure: 1, success: 2 });
  assert.deepEqual(s.topActions, [{ action: 'x.a', count: 2 }, { action: 'x.b', count: 1 }]);
  assert.deepEqual(s.topFailures, [{ action: 'x.a', count: 1 }]);
  assert.equal(s.topActors[0].id, 'u1');
  const c = store.counts(now);
  assert.equal(c.total, 3);
  assert.equal(c.lastHour, 3);
  assert.deepEqual(c.bySource, [{ source: 'shop', n: 2 }, { source: 'other', n: 1 }]);
});
