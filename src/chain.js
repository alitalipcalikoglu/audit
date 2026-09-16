import { createHash } from 'node:crypto';

/** @typedef {import('./types.js').EventRecord} EventRecord */
/** @typedef {import('./types.js').EventRow} EventRow */

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, `undefined` members
 * dropped. Two structurally equal values always serialise to the same string, so the
 * serialisation can be hashed.
 */
export class Canonical {
  /**
   * @param {unknown} value
   * @returns {string}
   */
  static stringify(value) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite number cannot be canonicalised');
      if (typeof value === 'bigint') throw new TypeError('bigint cannot be canonicalised');
      return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) return `[${value.map((v) => Canonical.stringify(v)).join(',')}]`;
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${Canonical.stringify(obj[k])}`).join(',')}}`;
  }
}

/**
 * Hash chain over stored events: `hash = SHA-256(prevHash + "\n" + canonical(event fields))`.
 * A change to any stored field, a removed row or a reordered row changes every later hash,
 * so tampering is detectable by recomputing the chain from a trusted starting point.
 */
export class HashChain {
  static GENESIS = '0'.repeat(64);

  /**
   * The exact fields covered by the hash, taken from a stored row. Stored `meta` is already
   * canonical JSON, so it is included verbatim.
   * @param {EventRow} row
   */
  static payload(row) {
    return Canonical.stringify({
      id: row.id,
      clientId: row.client_id,
      source: row.source,
      action: row.action,
      outcome: row.outcome,
      actor: row.actor_id === null && row.actor_type === null ? null : { type: row.actor_type, id: row.actor_id, name: row.actor_name },
      target: row.target_id === null && row.target_type === null ? null : { type: row.target_type, id: row.target_id, name: row.target_name },
      ip: row.ip,
      userAgent: row.user_agent,
      requestId: row.request_id,
      meta: row.meta,
      at: row.at,
      receivedAt: row.received_at,
    });
  }

  /**
   * @param {string} prevHash
   * @param {EventRow} row   The row with every field except `hash` filled in.
   */
  static hash(prevHash, row) {
    return createHash('sha256').update(prevHash).update('\n').update(HashChain.payload(row)).digest('hex');
  }

  /**
   * Walk rows in `seq` order, recomputing every hash.
   * @param {Iterable<EventRow>} rows
   * @param {string} startPrevHash  Trusted hash preceding the first row.
   * @returns {{ checked: number, firstBroken: number|null, lastSeq: number|null, lastHash: string|null }}
   */
  static verify(rows, startPrevHash) {
    let prev = startPrevHash;
    let checked = 0;
    /** @type {number|null} */
    let lastSeq = null;
    for (const row of rows) {
      if (row.prev_hash !== prev || HashChain.hash(prev, row) !== row.hash) return { checked, firstBroken: row.seq, lastSeq, lastHash: prev === startPrevHash && checked === 0 ? null : prev };
      prev = row.hash;
      lastSeq = row.seq;
      checked++;
    }
    return { checked, firstBroken: null, lastSeq, lastHash: checked ? prev : null };
  }
}
