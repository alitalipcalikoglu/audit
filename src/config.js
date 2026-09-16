/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

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
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) throw new ConfigError(`AUDIT_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret[:role]`);
      const [id, secret, role = 'readwrite'] = parts;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`AUDIT_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`AUDIT_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      if (role !== 'read' && role !== 'write' && role !== 'readwrite') throw new ConfigError(`AUDIT_API_KEYS role for "${id}" must be read, write or readwrite`);
      return { id, secret, role: /** @type {KeyRole} */ (role) };
    });
    if (keys.length === 0) throw new ConfigError('AUDIT_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('AUDIT_API_KEYS ids must be unique');
    if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError('AUDIT_API_KEYS secrets must be unique');
    return keys;
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

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
