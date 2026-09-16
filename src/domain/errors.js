/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class AuditError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    EVENT_NOT_FOUND: 404,
    INVALID_EVENT: 400,
    TIMESTAMP_INVALID: 400,
    META_TOO_LARGE: 413,
    BATCH_TOO_LARGE: 413,
    INVALID_CURSOR: 400,
    RANGE_TOO_LARGE: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof AuditError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.statusCode = AuditError.STATUS[code];
    this.details = details;
  }
}
