import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/service-core/auth';
import { AuditError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */
/** @typedef {import('../types.js').KeyRole} KeyRole */

/**
 * Bearer API-key authentication for Fastify with read/write roles. Thin wrapper over
 * service-core's `ApiKeyAuth`: keeps this service's `request.apiKeyId`/`request.apiKeyRole` split
 * decoration.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys, {
      decorate: (request, key) => { request.apiKeyId = key.id; request.apiKeyRole = /** @type {KeyRole} */ (key.role); },
    });
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * Route-level guard. Returns a `preHandler` that rejects keys lacking the capability.
   * @param {'read'|'write'} need
   */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKeyRole,
      makeError: (n) => new AuditError('FORBIDDEN', `this API key has no ${n} access`),
    });
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    return /** @type {ApiKey|undefined} */ (/** @type {any} */ (this.core.identify(secret)));
  }
}
