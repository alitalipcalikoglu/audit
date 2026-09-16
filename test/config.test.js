import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults and key roles', () => {
  const c = Config.fromEnv(testEnv());
  assert.equal(c.port, 0);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.retentionDays, 365);
  assert.equal(c.maxBatch, 500);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['shop', 'readwrite'], ['console', 'read'], ['worker', 'write']]);
  assert.deepEqual(c.redactKeys, Config.DEFAULT_REDACT_KEYS);
  assert.ok(Object.isFrozen(c));
});

test('Config: redact keys normalised, "-" disables', () => {
  assert.deepEqual(Config.fromEnv(testEnv({ REDACT_KEYS: 'Api_Key, card-number,pin' })).redactKeys, ['apikey', 'cardnumber', 'pin']);
  assert.deepEqual(Config.fromEnv(testEnv({ REDACT_KEYS: '-' })).redactKeys, []);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ AUDIT_API_KEYS: '' }, /AUDIT_API_KEYS is required/);
  bad({ AUDIT_API_KEYS: 'shop:short' }, /at least 32/);
  bad({ AUDIT_API_KEYS: `shop:${'a'.repeat(40)}:admin` }, /must be read, write or readwrite/);
  bad({ AUDIT_API_KEYS: `shop:${'a'.repeat(40)},shop:${'b'.repeat(40)}` }, /ids must be unique/);
  bad({ AUDIT_API_KEYS: `a:${'a'.repeat(40)},b:${'a'.repeat(40)}` }, /secrets must be unique/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
  bad({ PORT: 'abc' }, /must be an integer/);
  bad({ MAX_BATCH: '0' }, /must be >= 1/);
  bad({ TRUST_PROXY: 'yes' }, /true or false/);
});
