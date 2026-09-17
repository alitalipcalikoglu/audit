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
  assert.equal(c.anchorPrivateKeyPath, null, 'anchors are off by default — additive, not required');
  assert.equal(c.anchorPreviousPublicKeyPath, null);
  assert.equal(c.anchorIntervalMin, 60);
  assert.equal(c.anchorWebhookUrl, null);
  assert.deepEqual(c.outboundTarget, { allowHttp: false, allowPrivate: false, allowedHosts: [] });
  assert.ok(Object.isFrozen(c));
});

test('Config: anchors', () => {
  const withKey = Config.fromEnv(testEnv({ ANCHOR_PRIVATE_KEY_PATH: './keys/anchor-private.pem' }));
  assert.equal(withKey.anchorPrivateKeyPath, './keys/anchor-private.pem');
  const withRotation = Config.fromEnv(testEnv({ ANCHOR_PRIVATE_KEY_PATH: './keys/anchor-private.pem', ANCHOR_PREVIOUS_PUBLIC_KEY_PATH: './keys/anchor-2026-public.pem' }));
  assert.equal(withRotation.anchorPreviousPublicKeyPath, './keys/anchor-2026-public.pem');
  assert.throws(
    () => Config.fromEnv(testEnv({ ANCHOR_WEBHOOK_URL: 'https://collector.example.com/anchors' })),
    (/** @type {any} */ e) => e instanceof ConfigError && /requires ANCHOR_PRIVATE_KEY_PATH/.test(e.message),
    'ANCHOR_WEBHOOK_URL alone, with anchors otherwise off, is refused rather than silently ignored',
  );
  const withWebhook = Config.fromEnv(testEnv({ ANCHOR_PRIVATE_KEY_PATH: './keys/anchor-private.pem', ANCHOR_WEBHOOK_URL: 'https://collector.example.com/anchors' }));
  assert.equal(withWebhook.anchorWebhookUrl, 'https://collector.example.com/anchors');
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
