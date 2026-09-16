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
