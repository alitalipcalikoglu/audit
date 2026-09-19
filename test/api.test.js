import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { HashChain } from '../src/chain.js';
import { READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

const AUDIT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);

test('API: health, ready, auth and roles', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  assert.match(String(spec.headers['content-type']), /^text\/yaml/);
  const noKey = await app.inject({ url: '/v1/events' });
  assert.equal(noKey.statusCode, 401);
  assert.equal(noKey.headers['www-authenticate'], 'Bearer');
  assert.equal((await app.inject({ url: '/v1/events', headers: bearer('x'.repeat(40)) })).statusCode, 401);
  const writerReads = await app.inject({ url: '/v1/events', headers: bearer(WRITE_KEY) });
  assert.equal(writerReads.statusCode, 403);
  assert.equal(json(writerReads).error.code, 'FORBIDDEN');
  const readerWrites = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(READ_KEY), payload: { action: 'x.y' } });
  assert.equal(readerWrites.statusCode, 403);
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/nope', headers: bearer(RW_KEY) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/health' })).headers['cache-control'], 'no-store');
});

test('API: ingest single event, source from key, redaction, idempotency', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const body = {
    id: '6f1c7d2e-1111-4222-8333-444455556666',
    action: 'auth.login',
    outcome: 'failure',
    actor: { type: 'user', id: 'u1', name: 'Ada' },
    target: { type: 'session', id: 's1' },
    ip: '203.0.113.9',
    userAgent: 'curl/8',
    requestId: 'req-1',
    meta: { reason: 'bad_password', password: 'hunter2', nested: { api_key: 'k', ok: true } },
    at: '2026-01-02T03:04:05.000Z',
  };
  const res = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(WRITE_KEY), payload: body });
  assert.equal(res.statusCode, 201);
  const { event, duplicate } = json(res);
  assert.equal(duplicate, false);
  assert.equal(res.headers.location, `/v1/events/${event.id}`);
  assert.equal(event.source, 'worker');
  assert.equal(event.seq, 1);
  assert.equal(event.clientId, body.id);
  assert.deepEqual(event.actor, body.actor);
  assert.deepEqual(event.meta, { reason: 'bad_password', password: '[REDACTED]', nested: { api_key: '[REDACTED]', ok: true } });
  assert.equal(event.at, body.at);
  assert.equal(event.prevHash, HashChain.GENESIS);
  assert.match(event.hash, /^[0-9a-f]{64}$/);

  const again = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(WRITE_KEY), payload: body });
  assert.equal(again.statusCode, 200);
  assert.equal(json(again).duplicate, true);
  assert.equal(json(again).event.id, event.id);

  // Same client id from another source is a different event.
  const other = await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(RW_KEY), payload: body });
  assert.equal(other.statusCode, 201);
  assert.equal(json(other).event.source, 'shop');

  const get = await app.inject({ url: `/v1/events/${event.id}`, headers: bearer(READ_KEY) });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(json(get).event, event);
  assert.equal((await app.inject({ url: '/v1/events/00000000-0000-4000-8000-000000000000', headers: bearer(READ_KEY) })).statusCode, 404);
});

test('API: validation and limits', async (t) => {
  const { app } = await buildApp({ MAX_BATCH: '2', META_MAX_BYTES: '256' });
  t.after(() => app.close());
  const post = (/** @type {object} */ payload, url = '/v1/events') => app.inject({ method: 'POST', url, headers: bearer(RW_KEY), payload });
  let r = await post({ action: 'Login' });
  assert.equal(r.statusCode, 400);
  assert.equal(json(r).error.code, 'VALIDATION_FAILED');
  r = await post({ action: 'a.b', extra: 1 });
  assert.equal(r.statusCode, 400);
  r = await post({ action: 'a.b', ip: 'not-an-ip' });
  assert.equal(json(r).error.code, 'INVALID_EVENT');
  r = await post({ action: 'a.b', at: '2999-01-01T00:00:00Z' });
  assert.equal(json(r).error.code, 'TIMESTAMP_INVALID');
  r = await post({ action: 'a.b', meta: { big: 'x'.repeat(300) } });
  assert.equal(r.statusCode, 413);
  assert.equal(json(r).error.code, 'META_TOO_LARGE');
  r = await post({ events: [{ action: 'a.b' }, { action: 'a.c' }, { action: 'a.d' }] }, '/v1/events/batch');
  assert.equal(r.statusCode, 413);
  assert.equal(json(r).error.code, 'BATCH_TOO_LARGE');
  r = await app.inject({ url: '/v1/events?limit=500', headers: bearer(RW_KEY) });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ url: '/v1/events?cursor=!!!', headers: bearer(RW_KEY) });
  assert.equal(json(r).error.code, 'INVALID_CURSOR');
});

test('API: batch, list with filters and cursor, export', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push({ id: `00000000-0000-4000-8000-00000000000${i}`, action: i < 3 ? 'auth.login' : 'order.create', outcome: i === 1 ? 'failure' : 'success', actor: { type: 'user', id: `u${i % 2}` }, at: new Date(1_700_000_000_000 + i * 1000).toISOString() });
  }
  events.push({ ...events[0] }); // duplicate inside the batch
  const batch = await app.inject({ method: 'POST', url: '/v1/events/batch', headers: bearer(RW_KEY), payload: { events } });
  assert.equal(batch.statusCode, 201);
  assert.equal(json(batch).accepted, 5);
  assert.equal(json(batch).duplicates, 1);
  assert.equal(json(batch).items[5].duplicate, true);
  assert.equal(json(batch).items[5].id, json(batch).items[0].id);

  const list = (/** @type {string} */ qs) => app.inject({ url: `/v1/events?${qs}`, headers: bearer(READ_KEY) }).then(json);
  let page = await list('limit=2');
  assert.deepEqual(page.items.map((/** @type {any} */ e) => e.seq), [5, 4]);
  assert.ok(page.nextCursor);
  page = await list(`limit=2&cursor=${page.nextCursor}`);
  assert.deepEqual(page.items.map((/** @type {any} */ e) => e.seq), [3, 2]);
  page = await list(`limit=2&cursor=${page.nextCursor}`);
  assert.deepEqual(page.items.map((/** @type {any} */ e) => e.seq), [1]);
  assert.equal(page.nextCursor, null);

  assert.equal((await list('actionPrefix=auth.')).items.length, 3);
  assert.equal((await list('action=order.create')).items.length, 2);
  assert.equal((await list('outcome=failure')).items.length, 1);
  assert.equal((await list('actorId=u1')).items.length, 2);
  assert.equal((await list('source=shop')).items.length, 5);
  assert.equal((await list('source=worker')).items.length, 0);
  assert.equal((await list(`from=${events[1].at}&to=${events[3].at}`)).items.length, 2);

  const nd = await app.inject({ url: '/v1/events/export?actionPrefix=auth.', headers: bearer(READ_KEY) });
  assert.equal(nd.statusCode, 200);
  assert.match(String(nd.headers['content-type']), /x-ndjson/);
  assert.match(String(nd.headers['content-disposition']), /attachment; filename="audit-.*\.ndjson"/);
  const lines = nd.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.seq), [1, 2, 3]);

  const csv = await app.inject({ url: '/v1/events/export?format=csv&outcome=failure', headers: bearer(READ_KEY) });
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  const rows = csv.body.trim().split('\n');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith('seq,id,at,receivedAt,source,action,outcome'));
  assert.match(rows[1], /^2,[0-9a-f-]{36},2023-11-14T22:13:21\.000Z,.*,shop,auth\.login,failure,user,u1,,/);
});

test('API: chain head, verify, tamper detection', async (t) => {
  const { app, db } = await buildApp();
  t.after(() => app.close());
  const empty = await app.inject({ url: '/v1/chain/verify', headers: bearer(READ_KEY) });
  assert.deepEqual(json(empty), { ok: true, checked: 0, fromSeq: null, toSeq: null, firstBroken: null, head: { seq: 0, hash: HashChain.GENESIS }, anchors: { checked: 0, invalid: [] } });
  await app.inject({ method: 'POST', url: '/v1/events/batch', headers: bearer(RW_KEY), payload: { events: [{ action: 'a.b' }, { action: 'a.c' }, { action: 'a.d' }] } });
  const head = json(await app.inject({ url: '/v1/chain/head', headers: bearer(READ_KEY) }));
  assert.equal(head.seq, 3);
  let v = json(await app.inject({ url: '/v1/chain/verify', headers: bearer(READ_KEY) }));
  assert.equal(v.ok, true);
  assert.equal(v.checked, 3);
  assert.equal(v.head.hash, head.hash);
  v = json(await app.inject({ url: '/v1/chain/verify?fromSeq=2&toSeq=3', headers: bearer(READ_KEY) }));
  assert.deepEqual([v.ok, v.checked, v.fromSeq, v.toSeq], [true, 2, 2, 3]);
  assert.equal((await app.inject({ url: '/v1/chain/verify?fromSeq=3&toSeq=2', headers: bearer(READ_KEY) })).statusCode, 400);

  db.raw.prepare(`UPDATE events SET outcome = 'denied' WHERE seq = 2`).run();
  v = json(await app.inject({ url: '/v1/chain/verify', headers: bearer(READ_KEY) }));
  assert.equal(v.ok, false);
  assert.equal(v.firstBroken, 2);
  assert.match(v.reason, /hash mismatch at seq 2/);
  db.raw.prepare(`DELETE FROM events WHERE seq = 2`).run();
  v = json(await app.inject({ url: '/v1/chain/verify', headers: bearer(READ_KEY) }));
  assert.equal(v.ok, false);
  assert.equal(v.firstBroken, 2);
  assert.match(v.reason, /seq 2 is missing/);
});

test('API: stats and metrics', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/events/batch', headers: bearer(RW_KEY), payload: { events: [{ action: 'a.b' }, { action: 'a.b', outcome: 'denied' }, { action: 'a.c', actor: { type: 'user', id: 'u1' } }] } });
  await app.inject({ method: 'POST', url: '/v1/events', headers: bearer(WRITE_KEY), payload: { action: 'w.x' } });
  const st = json(await app.inject({ url: '/v1/stats?hours=1', headers: bearer(READ_KEY) }));
  assert.equal(st.windowHours, 1);
  assert.equal(st.total, 4);
  assert.deepEqual(st.byOutcome, { denied: 1, success: 3 });
  assert.deepEqual(st.bySource, [{ source: 'shop', count: 3 }, { source: 'worker', count: 1 }]);
  assert.equal(st.topActions[0].action, 'a.b');
  assert.deepEqual(st.topFailures, [{ action: 'a.b', count: 1 }]);
  assert.match(st.since, /^\d{4}-/);
  const m = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.equal(m.statusCode, 200);
  assert.match(m.body, /audit_events_total 4/);
  assert.match(m.body, /audit_events_by_source\{source="shop"\} 3/);
  assert.match(m.body, /audit_chain_head_seq 4/);
  assert.match(m.body, /audit_db_bytes \d+/);
});

test('API: info', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.equal(info.service, 'audit');
  assert.equal(info.version, AUDIT_VERSION);
  assert.equal(info.apiVersion, 'v1');
  assert.deepEqual(info.capabilities, ['chain-verification', 'anchors', 'export']);
  assert.equal(typeof info.schemaVersion, 'number');
  assert.equal(typeof info.serviceCore, 'string');
});

test('API: rate limit per key', async (t) => {
  const { app } = await buildApp({ RATE_LIMIT_MAX: '2' });
  t.after(() => app.close());
  await app.inject({ url: '/v1/chain/head', headers: bearer(READ_KEY) });
  await app.inject({ url: '/v1/chain/head', headers: bearer(READ_KEY) });
  const limited = await app.inject({ url: '/v1/chain/head', headers: bearer(READ_KEY) });
  assert.equal(limited.statusCode, 429);
  assert.equal(json(limited).error.code, 'RATE_LIMITED');
  assert.equal((await app.inject({ url: '/v1/chain/head', headers: bearer(RW_KEY) })).statusCode, 200);
});
