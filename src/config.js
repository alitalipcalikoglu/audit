import { ConfigError, EnvReader, parseApiKeys } from '@atc-web/service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static DEFAULT_REDACT_KEYS = ['password', 'passwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'apikey', 'privatekey', 'otp', 'totp', 'cardnumber', 'pan', 'cvv', 'iban', 'ssn'];

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.retentionDays = v.retentionDays;
    this.maxBatch = v.maxBatch;
    this.metaMaxBytes = v.metaMaxBytes;
    this.redactKeys = v.redactKeys;
    this.clockSkewSec = v.clockSkewSec;
    this.exportMaxRows = v.exportMaxRows;
    this.verifyMaxRows = v.verifyMaxRows;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    return new Config({
      port: r.integer('PORT', 3005, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      bodyLimit: r.integer('BODY_LIMIT', 1_048_576, { min: 4_096, max: 16_777_216 }),
      dbPath: r.optional('DB_PATH') || './data/audit.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('AUDIT_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 1_200, { min: 1 }),
      retentionDays: r.integer('RETENTION_DAYS', 365, { min: 1 }),
      maxBatch: r.integer('MAX_BATCH', 500, { min: 1, max: 5_000 }),
      metaMaxBytes: r.integer('META_MAX_BYTES', 8_192, { min: 256, max: 1_048_576 }),
      redactKeys: Config.#parseRedactKeys(r.optional('REDACT_KEYS')),
      clockSkewSec: r.integer('CLOCK_SKEW_SEC', 300, { min: 0, max: 86_400 }),
      exportMaxRows: r.integer('EXPORT_MAX_ROWS', 100_000, { min: 100 }),
      verifyMaxRows: r.integer('VERIFY_MAX_ROWS', 100_000, { min: 100 }),
    });
  }

  /**
   * Parse `id:secret[:role],id2:secret2[:role]`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'AUDIT_API_KEYS', { roles: ['read', 'write', 'readwrite'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }

  /**
   * Comma-separated key names; `-` disables redaction entirely. Names are normalised like
   * the redactor normalises meta keys, so `api_key`, `apiKey` and `API-KEY` all match.
   * @param {string} raw
   */
  static #parseRedactKeys(raw) {
    if (raw === '') return Config.DEFAULT_REDACT_KEYS;
    if (raw === '-') return [];
    const keys = raw.split(',').map((s) => s.trim().toLowerCase().replace(/[_-]/g, '')).filter(Boolean);
    if (keys.length === 0) throw new ConfigError('REDACT_KEYS must list at least one key, or be "-" to disable redaction');
    return [...new Set(keys)];
  }
}
