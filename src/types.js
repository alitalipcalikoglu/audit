/**
 * Shared JSDoc typedefs for the audit service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id      Also the `source` recorded on every event written with this key.
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {number} retentionDays
 * @property {number} maxBatch
 * @property {number} metaMaxBytes
 * @property {string[]} redactKeys       Lower-case, normalised (no `_` or `-`).
 * @property {number} clockSkewSec       How far in the future a client `at` may be.
 * @property {number} exportMaxRows
 * @property {number} verifyMaxRows
 */

/** @typedef {import('./config.js').Config} Config */

/** @typedef {'success'|'failure'|'denied'} Outcome */

/**
 * @typedef {object} Party
 * @property {string} type
 * @property {string} id
 * @property {string} [name]
 */

/**
 * One event as accepted from a caller (after JSON-schema validation).
 * @typedef {object} EventInput
 * @property {string} [id]           Caller-side id for idempotency, unique per source.
 * @property {string} action
 * @property {Outcome} [outcome]
 * @property {Party} [actor]
 * @property {Party} [target]
 * @property {string} [ip]
 * @property {string} [userAgent]
 * @property {string} [requestId]
 * @property {Record<string, unknown>} [meta]
 * @property {string} [at]           ISO 8601; defaults to the time of receipt.
 */

/**
 * Normalised event ready to be hashed and stored.
 * @typedef {object} EventRecord
 * @property {string} id
 * @property {string|null} clientId
 * @property {string} source
 * @property {string} action
 * @property {Outcome} outcome
 * @property {Party|null} actor
 * @property {Party|null} target
 * @property {string|null} ip
 * @property {string|null} userAgent
 * @property {string|null} requestId
 * @property {string|null} meta      Canonical JSON.
 * @property {number} at
 * @property {number} receivedAt
 */

/**
 * @typedef {object} EventRow
 * @property {number} seq
 * @property {string} id
 * @property {string|null} client_id
 * @property {string} source
 * @property {string} action
 * @property {Outcome} outcome
 * @property {string|null} actor_type
 * @property {string|null} actor_id
 * @property {string|null} actor_name
 * @property {string|null} target_type
 * @property {string|null} target_id
 * @property {string|null} target_name
 * @property {string|null} ip
 * @property {string|null} user_agent
 * @property {string|null} request_id
 * @property {string|null} meta
 * @property {number} at
 * @property {number} received_at
 * @property {string} prev_hash
 * @property {string} hash
 */

/**
 * Query filter; every field optional, all combined with AND.
 * @typedef {object} EventFilter
 * @property {string} [source]
 * @property {string} [action]
 * @property {string} [actionPrefix]
 * @property {Outcome} [outcome]
 * @property {string} [actorType]
 * @property {string} [actorId]
 * @property {string} [targetType]
 * @property {string} [targetId]
 * @property {string} [ip]
 * @property {string} [requestId]
 * @property {number} [from]        Inclusive lower bound on `at` (ms).
 * @property {number} [to]          Exclusive upper bound on `at` (ms).
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
