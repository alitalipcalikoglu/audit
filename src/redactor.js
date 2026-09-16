/**
 * Replaces values of sensitive keys anywhere inside event metadata. Key matching ignores
 * case, `_` and `-`, so `api_key`, `apiKey` and `API-KEY` are all caught.
 */
export class Redactor {
  static PLACEHOLDER = '[REDACTED]';
  static MAX_DEPTH = 16;

  /** @param {string[]} keys Normalised key names (lower-case, no `_`/`-`). */
  constructor(keys) {
    this.keys = new Set(keys);
  }

  /** @param {string} key */
  matches(key) {
    return this.keys.has(key.toLowerCase().replace(/[_-]/g, ''));
  }

  /**
   * Returns a redacted deep copy; the input is not mutated.
   * @template T
   * @param {T} value
   * @param {number} [depth]
   * @returns {T}
   */
  apply(value, depth = 0) {
    if (this.keys.size === 0 || value === null || typeof value !== 'object') return value;
    if (depth >= Redactor.MAX_DEPTH) return /** @type {T} */ (Redactor.PLACEHOLDER);
    if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => this.apply(v, depth + 1)));
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      out[k] = this.matches(k) ? Redactor.PLACEHOLDER : this.apply(v, depth + 1);
    }
    return /** @type {T} */ (out);
  }
}
