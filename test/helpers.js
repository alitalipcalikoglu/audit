import { generateKeyPairSync } from 'node:crypto';
import { readServiceVersion } from '@atc-web/service-core/fastify';
import { AnchorSigner } from '../src/crypto/anchor-signer.js';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    AUDIT_API_KEYS: `shop:${RW_KEY},console:${READ_KEY}:read,worker:${WRITE_KEY}:write`,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

export function memoryDb() {
  return new Database(':memory:');
}

/**
 * A fresh in-memory Ed25519 signer, no files touched — for tests that don't specifically exercise
 * `AnchorSigner.fromFiles`/`fromPublicFiles`.
 * @param {{ withPrevious?: boolean }} [o]
 */
export function testAnchorSigner({ withPrevious = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const previous = withPrevious ? generateKeyPairSync('ed25519') : null;
  return new AnchorSigner({ privateKey, publicKey, previousPublicKey: previous?.publicKey ?? null });
}

/**
 * @param {Partial<import('../src/types.js').EventRecord>} [o]
 * @returns {import('../src/types.js').EventRecord}
 */
export function record(o = {}) {
  const now = o.receivedAt ?? Date.now();
  return {
    id: o.id ?? crypto.randomUUID(),
    clientId: o.clientId ?? null,
    source: o.source ?? 'shop',
    action: o.action ?? 'order.create',
    outcome: o.outcome ?? 'success',
    actor: o.actor === undefined ? { type: 'user', id: 'u1' } : o.actor,
    target: o.target === undefined ? { type: 'order', id: 'o1' } : o.target,
    ip: o.ip ?? null,
    userAgent: o.userAgent ?? null,
    requestId: o.requestId ?? null,
    meta: o.meta ?? null,
    at: o.at ?? now,
    receivedAt: now,
  };
}

/**
 * Fully wired Fastify app over an in-memory database.
 * @param {Record<string, string>} [overrides]
 * @param {import('../src/crypto/anchor-signer.js').AnchorSigner|null} [anchorSigner]
 */
export async function buildApp(overrides, anchorSigner = null) {
  const { AuditService } = await import('../src/domain/audit-service.js');
  const { AuditApi } = await import('../src/http/audit-api.js');
  const { Redactor } = await import('../src/redactor.js');
  const { EventStore } = await import('../src/store/event-store.js');
  const config = testConfig(overrides);
  const db = memoryDb();
  const events = new EventStore(db);
  const service = new AuditService({
    events, redactor: new Redactor(config.redactKeys),
    options: { maxBatch: config.maxBatch, metaMaxBytes: config.metaMaxBytes, clockSkewMs: config.clockSkewSec * 1000, verifyMaxRows: config.verifyMaxRows },
    anchorSigner,
  });
  const app = await new AuditApi({ config, service, events, db, anchorSigner, version: readServiceVersion(import.meta.url) }).build();
  await app.ready();
  return { app, db, events, service, config };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
