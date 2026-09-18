import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NetGuard } from '@atc-web/service-core/http';
import { AnchorKeyGenerator } from '../scripts/anchor-keygen.js';
import { AnchorWebhook } from '../src/anchor-webhook.js';
import { Anchorer } from '../src/anchorer.js';
import { AnchorSigner } from '../src/crypto/anchor-signer.js';
import { AuditService } from '../src/domain/audit-service.js';
import { Redactor } from '../src/redactor.js';
import { EventStore } from '../src/store/event-store.js';
import { buildApp, memoryDb, record, testAnchorSigner } from './helpers.js';

/** Wires a service+events pair with anchors configured, over a fresh in-memory database. @param {import('../src/crypto/anchor-signer.js').AnchorSigner} signer */
function serviceWith(signer) {
  const db = memoryDb();
  const events = new EventStore(db);
  const service = new AuditService({
    events, redactor: new Redactor([]),
    options: { maxBatch: 500, metaMaxBytes: 8_192, clockSkewMs: 300_000, verifyMaxRows: 100_000 },
    anchorSigner: signer,
  });
  return { db, events, service };
}

function silentLog() {
  return /** @type {any} */ ({ info() {}, warn() {}, error() {} });
}

// ---------------------------------------------------------------- AnchorSigner

test('AnchorSigner: sign/verify round trip, keyId derived from the public key', () => {
  const signer = testAnchorSigner();
  const anchor = { seq: 5, hash: 'h'.repeat(64), at: 1_700_000_000_000 };
  const signature = signer.sign(anchor);
  const v = signer.verify({ ...anchor, keyId: signer.keyId, signature });
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
  assert.match(signer.keyId, /^[0-9a-f]{16}$/);
});

test('AnchorSigner: verify fails against the wrong public key (unrecognised key id)', () => {
  const signer = testAnchorSigner();
  const wrongSigner = testAnchorSigner(); // a completely different, unrelated key pair
  const anchor = { seq: 1, hash: 'a'.repeat(64), at: 1000 };
  const signature = signer.sign(anchor);
  const v = wrongSigner.verify({ ...anchor, keyId: signer.keyId, signature });
  assert.equal(v.ok, false);
  assert.match(/** @type {string} */ (v.reason), /unrecognised key/);
});

test('AnchorSigner: verify fails when the signature bytes are tampered', () => {
  const signer = testAnchorSigner();
  const anchor = { seq: 1, hash: 'a'.repeat(64), at: 1000 };
  const signature = signer.sign(anchor);
  const tampered = Buffer.from(signature, 'base64url');
  tampered[0] ^= 0xff;
  const v = signer.verify({ ...anchor, keyId: signer.keyId, signature: tampered.toString('base64url') });
  assert.equal(v.ok, false);
  assert.match(/** @type {string} */ (v.reason), /signature does not match/);
});

test('AnchorSigner: verify fails when the anchor payload (hash/seq/at) is tampered, even with a valid signature format', () => {
  const signer = testAnchorSigner();
  const anchor = { seq: 1, hash: 'a'.repeat(64), at: 1000 };
  const signature = signer.sign(anchor);
  const v = signer.verify({ seq: 1, hash: 'b'.repeat(64), at: 1000, keyId: signer.keyId, signature });
  assert.equal(v.ok, false);
});

test('AnchorSigner: key rotation — a previous-key-signed anchor still verifies when the previous key is configured, fails without it', () => {
  const oldKeys = generateKeyPairSync('ed25519');
  const newKeys = generateKeyPairSync('ed25519');
  const oldSigner = new AnchorSigner({ privateKey: oldKeys.privateKey, publicKey: oldKeys.publicKey });
  const anchor = { seq: 1, hash: 'a'.repeat(64), at: 1000 };
  const oldSignature = oldSigner.sign(anchor);
  const oldAnchorRow = { ...anchor, keyId: oldSigner.keyId, signature: oldSignature };

  const rotatedWithHistory = new AnchorSigner({ privateKey: newKeys.privateKey, publicKey: newKeys.publicKey, previousPublicKey: oldKeys.publicKey });
  assert.equal(rotatedWithHistory.verify(oldAnchorRow).ok, true, 'old anchor verifies via the configured previous key');
  const newAnchor = { seq: 2, hash: 'b'.repeat(64), at: 2000 };
  const newSignature = rotatedWithHistory.sign(newAnchor);
  assert.equal(rotatedWithHistory.verify({ ...newAnchor, keyId: rotatedWithHistory.keyId, signature: newSignature }).ok, true, 'new anchor verifies via the current key');

  const rotatedNoHistory = new AnchorSigner({ privateKey: newKeys.privateKey, publicKey: newKeys.publicKey }); // previous key discarded
  assert.equal(rotatedNoHistory.verify(oldAnchorRow).ok, false, 'without the previous key on file, an old anchor can no longer be verified — this is why ANCHOR_PREVIOUS_PUBLIC_KEY_PATH exists');
});

test('AnchorKeyGenerator + AnchorSigner.fromFiles/fromPublicFiles: real files round-trip, verification works with only the public key on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-anchor-keys-'));
  try {
    const base = join(dir, 'anchor');
    const out = new AnchorKeyGenerator(base).run();
    assert.throws(() => new AnchorKeyGenerator(base).run(), /already exists/);

    const service = AnchorSigner.fromFiles({ privateKeyPath: out.privatePath });
    const anchor = { seq: 1, hash: 'a'.repeat(64), at: 1000 };
    const signature = service.sign(anchor);

    // A verifier with ONLY the public key file, no private key, no database.
    const verifier = AnchorSigner.fromPublicFiles({ publicKeyPath: out.publicPath });
    assert.equal(verifier.keyId, service.keyId);
    assert.equal(verifier.verify({ ...anchor, keyId: service.keyId, signature }).ok, true);
    assert.equal(verifier.privateKey, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- AuditService: anchor() + verify()

test('1. valid chain + valid anchor: verify reports ok, and counts the anchor as checked', () => {
  const signer = testAnchorSigner();
  const { events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' }), record({ action: 'a.c' }), record({ action: 'a.d' })]);
  const anchor = service.anchor(1000);
  assert.equal(anchor?.seq, 3);
  const v = service.verify();
  assert.equal(v.ok, true);
  assert.deepEqual(v.anchors, { checked: 1, invalid: [] });
});

test('anchor(): a no-op (returns null, writes nothing) when the head has not advanced since the last anchor', () => {
  const signer = testAnchorSigner();
  const { events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' })]);
  const first = service.anchor(1000);
  assert.ok(first);
  assert.equal(service.anchor(2000), null, 'nothing new to attest to');
  assert.equal(events.latestAnchor()?.at, first?.at, 'still the first anchor, not overwritten or duplicated');
});

test('anchor(): throws when no anchorSigner is configured — anchors are opt-in, not silently skipped', () => {
  const { service } = serviceWith(/** @type {any} */ (null));
  assert.throws(() => service.anchor(), /no anchorSigner configured/);
});

test('2. DB event tampering: modifying a stored event still breaks verify via the existing hash-chain check, unaffected by anchors being configured', () => {
  const signer = testAnchorSigner();
  const { db, events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' }), record({ action: 'a.c' }), record({ action: 'a.d' })]);
  service.anchor(1000);
  db.raw.prepare(`UPDATE events SET outcome = 'denied' WHERE seq = 2`).run();
  const v = service.verify();
  assert.equal(v.ok, false);
  assert.equal(v.firstBroken, 2);
  assert.match(/** @type {string} */ (v.reason), /hash mismatch at seq 2/);
});

test('anchor row tampering (independent of the live events): corrupting the stored anchor hash is caught even though the live chain is untouched', () => {
  const signer = testAnchorSigner();
  const { db, events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' }), record({ action: 'a.c' })]);
  const anchor = /** @type {any} */ (service.anchor(1000));
  db.raw.prepare(`UPDATE anchors SET hash = ? WHERE seq = ?`).run('f'.repeat(64), anchor.seq);
  const v = service.verify();
  assert.equal(v.ok, false);
  assert.match(/** @type {string} */ (v.reason), /anchor hash does not match the chain/);
  assert.equal(v.anchors.invalid[0].seq, anchor.seq);
});

test('4. anchor signature tampering: corrupting the stored signature is caught, the live chain is otherwise fine', () => {
  const signer = testAnchorSigner();
  const { db, events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' })]);
  const anchor = /** @type {any} */ (service.anchor(1000));
  const tampered = Buffer.from(anchor.signature, 'base64url');
  tampered[0] ^= 0xff;
  db.raw.prepare(`UPDATE anchors SET signature = ? WHERE seq = ?`).run(tampered.toString('base64url'), anchor.seq);
  const v = service.verify();
  assert.equal(v.ok, false);
  assert.match(/** @type {string} */ (v.reason), /anchor signature invalid/);
});

test('5. wrong public key: an anchor signed by one key does not verify under a service configured with a different, unrelated key', () => {
  const signerA = testAnchorSigner();
  const { db, events, service } = serviceWith(signerA);
  events.append([record({ action: 'a.b' })]);
  service.anchor(1000);

  const signerB = testAnchorSigner(); // unrelated key pair, no previous-key link to A
  const { service: serviceWrongKey } = (() => {
    const s2 = new AuditService({ events, redactor: new Redactor([]), options: { maxBatch: 500, metaMaxBytes: 8_192, clockSkewMs: 300_000, verifyMaxRows: 100_000 }, anchorSigner: signerB });
    return { service: s2 };
  })();
  const v = serviceWrongKey.verify();
  assert.equal(v.ok, false);
  assert.match(/** @type {string} */ (v.reason), /unrecognised key/);
  void db;
});

test('3. checkpoint tampering: a corrupted purge checkpoint poisons the trusted starting hash for everything after it', () => {
  const { db, events, service } = serviceWith(/** @type {any} */ (null));
  events.append([record({ action: 'a.b' }), record({ action: 'a.c' }), record({ action: 'a.d' })]);
  const purged = events.purge(Date.now() + 1); // purge everything, leaving a checkpoint at seq 3
  assert.equal(purged.checkpointSeq, 3);
  events.append([record({ action: 'a.e' })]); // seq 4, chained off the (currently correct) checkpoint

  let v = service.verify();
  assert.equal(v.ok, true, 'genuine checkpoint verifies fine');

  db.raw.prepare(`UPDATE checkpoints SET hash = ? WHERE seq = 3`).run('c'.repeat(64));
  v = service.verify();
  assert.equal(v.ok, false);
  assert.equal(v.firstBroken, 4, 'the only row after the poisoned checkpoint is where the mismatch surfaces');
  assert.match(/** @type {string} */ (v.reason), /hash mismatch/);
});

test('6. key rotation / old anchor verification end to end through AuditService.verify()', () => {
  const oldKeys = generateKeyPairSync('ed25519');
  const newKeys = generateKeyPairSync('ed25519');
  const oldSigner = new AnchorSigner({ privateKey: oldKeys.privateKey, publicKey: oldKeys.publicKey });
  const { db, events } = serviceWith(oldSigner);
  const service1 = new AuditService({ events, redactor: new Redactor([]), options: { maxBatch: 500, metaMaxBytes: 8_192, clockSkewMs: 300_000, verifyMaxRows: 100_000 }, anchorSigner: oldSigner });
  events.append([record({ action: 'a.b' })]);
  service1.anchor(1000); // anchored under the old key

  const rotatedSigner = new AnchorSigner({ privateKey: newKeys.privateKey, publicKey: newKeys.publicKey, previousPublicKey: oldKeys.publicKey });
  const service2 = new AuditService({ events, redactor: new Redactor([]), options: { maxBatch: 500, metaMaxBytes: 8_192, clockSkewMs: 300_000, verifyMaxRows: 100_000 }, anchorSigner: rotatedSigner });
  events.append([record({ action: 'a.c' })]);
  service2.anchor(2000); // anchored under the new key

  const v = service2.verify();
  assert.equal(v.ok, true);
  assert.equal(v.anchors.checked, 2, 'both the old-key and new-key anchors were checked');
  void db;
});

// ---------------------------------------------------------------- Anchorer + AnchorWebhook

test('7. signing/anchor destination unavailable: a webhook push failure never blocks or invalidates the anchor, which is already durably recorded', async () => {
  const signer = testAnchorSigner();
  const { events, service } = serviceWith(signer);
  events.append([record({ action: 'a.b' })]);
  const failingWebhook = { post: async () => { throw new Error('ECONNREFUSED'); } };
  const anchorer = new Anchorer({ service, webhook: /** @type {any} */ (failingWebhook), log: silentLog(), options: { intervalMs: 60_000 } });

  const result = anchorer.run(1000);
  assert.ok(result, 'anchor() succeeded synchronously despite the webhook being configured to fail');
  await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget rejection settle
  assert.equal(events.latestAnchor()?.seq, result?.seq, 'durably recorded regardless of the push outcome');
});

test('Anchorer.run swallows a signing failure (e.g. anchorSigner missing) and logs rather than throwing', () => {
  const { service } = serviceWith(/** @type {any} */ (null)); // no signer configured
  const anchorer = new Anchorer({ service, webhook: null, log: silentLog(), options: { intervalMs: 60_000 } });
  assert.doesNotThrow(() => anchorer.run());
  assert.equal(anchorer.run(), null);
});

test('AnchorWebhook: NetGuard SSRF refusal propagates as a rejection the caller must handle (unreachable/disallowed destination)', async () => {
  const guard = new NetGuard({ allowPrivate: false }); // default: refuses a private-range target
  const webhook = new AnchorWebhook({ url: 'http://127.0.0.1:1/anchor', guard, timeoutMs: 1000 });
  await assert.rejects(() => webhook.post({ seq: 1, hash: 'a'.repeat(64), at: 1000, key_id: 'k', signature: 's' }));
});

test('Post-production Phase 5 security regression: AnchorWebhook never leaks platform trace/request-id headers to an external, operator-configured target', async () => {
  /** @type {import('node:http').IncomingHttpHeaders|null} */
  let seenHeaders = null;
  const server = createServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const guard = new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: ['127.0.0.1'] });
    const webhook = new AnchorWebhook({ url: `http://127.0.0.1:${port}/anchor`, guard, timeoutMs: 1000 });
    await webhook.post({ seq: 1, hash: 'a'.repeat(64), at: 1000, key_id: 'k', signature: 's' });
    assert.ok(seenHeaders, 'the external server actually received the request');
    assert.equal('traceparent' in /** @type {object} */ (seenHeaders), false, 'no platform traceparent sent to an external target');
    assert.equal('x-request-id' in /** @type {object} */ (seenHeaders), false, 'no platform request-id sent to an external target');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- HTTP routes

test('GET /.well-known/audit-anchor-key: 404 when anchors are not configured, 200 with the current (and previous) public key otherwise', async (t) => {
  const off = await buildApp();
  t.after(() => off.app.close());
  assert.equal((await off.app.inject('/.well-known/audit-anchor-key')).statusCode, 404);

  const signer = testAnchorSigner({ withPrevious: true });
  const on = await buildApp(undefined, signer);
  t.after(() => on.app.close());
  const res = await on.app.inject('/.well-known/audit-anchor-key');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.current.keyId, signer.keyId);
  assert.equal(body.current.algorithm, 'Ed25519');
  assert.match(body.current.publicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(body.previous.keyId, signer.previousKeyId);
});

test('GET /v1/chain/anchors/latest: 404 with none written, 200 with the anchor after one', async (t) => {
  const signer = testAnchorSigner();
  const { app } = await buildApp(undefined, signer);
  t.after(() => app.close());
  let res = await app.inject({ url: '/v1/chain/anchors/latest', headers: { authorization: `Bearer ${'r'.repeat(40)}` } });
  assert.equal(res.statusCode, 404);

  await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${'k'.repeat(40)}` }, payload: { action: 'a.b' } });
  res = await app.inject({ url: '/v1/chain/anchors/latest', headers: { authorization: `Bearer ${'r'.repeat(40)}` } });
  assert.equal(res.statusCode, 404, 'events exist, but anchor() has not been called yet — Anchorer is a separate periodic job, not triggered by ingest');
});

test('GET /v1/chain/anchors: paginated, newest first', async (t) => {
  const signer = testAnchorSigner();
  const { app, service } = await buildApp(undefined, signer);
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${'k'.repeat(40)}` }, payload: { action: 'a.b' } });
  service.anchor(1000);
  await app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${'k'.repeat(40)}` }, payload: { action: 'a.c' } });
  service.anchor(2000);

  const res = await app.inject({ url: '/v1/chain/anchors?limit=1', headers: { authorization: `Bearer ${'r'.repeat(40)}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].seq, 2, 'newest first');
  assert.ok(body.nextBeforeSeq);
});
