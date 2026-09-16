import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Canonical, HashChain } from '../chain.js';
import { AuditError } from './errors.js';

/** @typedef {import('../store/event-store.js').EventStore} EventStore */
/** @typedef {import('../redactor.js').Redactor} Redactor */
/** @typedef {import('../types.js').EventInput} EventInput */
/** @typedef {import('../types.js').EventRecord} EventRecord */
/** @typedef {import('../types.js').EventRow} EventRow */
/** @typedef {import('../types.js').EventFilter} EventFilter */
/** @typedef {import('../types.js').Party} Party */

/**
 * @typedef {object} ServiceOptions
 * @property {number} maxBatch
 * @property {number} metaMaxBytes
 * @property {number} clockSkewMs
 * @property {number} verifyMaxRows
 */

/** Use-cases: ingest with normalisation and redaction, query, chain verification, stats. */
export class AuditService {
  /**
   * @param {object} deps
   * @param {EventStore} deps.events
   * @param {Redactor} deps.redactor
   * @param {ServiceOptions} deps.options
   */
  constructor({ events, redactor, options }) {
    this.events = events;
    this.redactor = redactor;
    this.options = options;
  }

  /**
   * Validate, normalise and store a batch for one source. `source` is the caller's key id and
   * cannot be chosen by the caller, so no writer can forge another service's events.
   * @param {string} source
   * @param {EventInput[]} inputs
   * @param {number} [now]
   * @returns {{ row: EventRow, duplicate: boolean }[]}
   */
  ingest(source, inputs, now = Date.now()) {
    if (inputs.length > this.options.maxBatch) throw new AuditError('BATCH_TOO_LARGE', `at most ${this.options.maxBatch} events per request`, { max: this.options.maxBatch, got: inputs.length });
    const records = inputs.map((input, i) => this.#normalise(source, input, now, i));
    return this.events.append(records);
  }

  /**
   * @param {string} source
   * @param {EventInput} e
   * @param {number} now
   * @param {number} index  Position in the batch, for error details.
   * @returns {EventRecord}
   */
  #normalise(source, e, now, index) {
    let at = now;
    if (e.at !== undefined) {
      at = Date.parse(e.at);
      if (Number.isNaN(at)) throw new AuditError('TIMESTAMP_INVALID', `events[${index}].at is not a valid ISO 8601 timestamp`, { index });
      if (at > now + this.options.clockSkewMs) throw new AuditError('TIMESTAMP_INVALID', `events[${index}].at is more than ${this.options.clockSkewMs / 1000}s in the future`, { index });
    }
    if (e.ip !== undefined && !isIP(e.ip)) throw new AuditError('INVALID_EVENT', `events[${index}].ip is not an IP address`, { index });
    /** @type {string|null} */
    let meta = null;
    if (e.meta !== undefined) {
      meta = Canonical.stringify(this.redactor.apply(e.meta));
      const bytes = Buffer.byteLength(meta);
      if (bytes > this.options.metaMaxBytes) throw new AuditError('META_TOO_LARGE', `events[${index}].meta is ${bytes} bytes, limit ${this.options.metaMaxBytes}`, { index, bytes, max: this.options.metaMaxBytes });
    }
    return {
      id: randomUUID(),
      clientId: e.id ?? null,
      source,
      action: e.action,
      outcome: e.outcome ?? 'success',
      actor: AuditService.#party(e.actor),
      target: AuditService.#party(e.target),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      requestId: e.requestId ?? null,
      meta,
      at,
      receivedAt: now,
    };
  }

  /** @param {Party|undefined} p */
  static #party(p) {
    if (!p) return null;
    return p.name === undefined ? { type: p.type, id: p.id } : { type: p.type, id: p.id, name: p.name };
  }

  /** @param {string} id */
  get(id) {
    const row = this.events.byId(id);
    if (!row) throw new AuditError('EVENT_NOT_FOUND', 'event not found');
    return row;
  }

  /**
   * Newest first. Returns one extra row's worth of knowledge as `nextCursor`.
   * @param {EventFilter} filter
   * @param {{ limit: number, cursor?: string }} page
   */
  list(filter, { limit, cursor }) {
    const before = cursor ? Cursor.decode(cursor) : undefined;
    const rows = this.events.list(filter, { limit: limit + 1, before });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? Cursor.encode(last) : null };
  }

  /**
   * Recompute hashes over `[fromSeq, toSeq]` in chunks. Verification needs a trusted
   * predecessor: the previous row, a purge checkpoint, or genesis.
   * @param {{ fromSeq?: number, toSeq?: number }} range
   */
  verify({ fromSeq, toSeq } = {}) {
    const head = this.events.head();
    const min = this.events.minSeq();
    if (min === null) return { ok: true, checked: 0, fromSeq: null, toSeq: null, firstBroken: null, head };
    const from = fromSeq ?? min;
    const to = toSeq ?? head.seq;
    if (to < from) throw new AuditError('RANGE_TOO_LARGE', 'toSeq must be >= fromSeq');
    if (to - from + 1 > this.options.verifyMaxRows) throw new AuditError('RANGE_TOO_LARGE', `verify at most ${this.options.verifyMaxRows} events per request`, { max: this.options.verifyMaxRows });
    const startPrev = this.events.trustedPrevHash(from);
    if (startPrev === null) return { ok: false, checked: 0, fromSeq: from, toSeq: to, firstBroken: from, head, reason: `no trusted predecessor for seq ${from}` };
    let prev = startPrev;
    let checked = 0;
    let expectedSeq = from;
    for (let cursor = from; cursor <= to;) {
      const rows = this.events.range(cursor, to, 1_000);
      if (rows.length === 0) break;
      for (const row of rows) {
        // A gap in seq means a row was deleted; the hash check below would also catch it, but report it precisely.
        if (row.seq !== expectedSeq) return { ok: false, checked, fromSeq: from, toSeq: to, firstBroken: expectedSeq, head, reason: `seq ${expectedSeq} is missing` };
        expectedSeq++;
      }
      const r = HashChain.verify(rows, prev);
      checked += r.checked;
      if (r.firstBroken !== null) return { ok: false, checked, fromSeq: from, toSeq: to, firstBroken: r.firstBroken, head, reason: `hash mismatch at seq ${r.firstBroken}` };
      prev = /** @type {string} */ (r.lastHash);
      cursor = /** @type {number} */ (r.lastSeq) + 1;
    }
    if (expectedSeq <= to) return { ok: false, checked, fromSeq: from, toSeq: to, firstBroken: expectedSeq, head, reason: `seq ${expectedSeq} is missing` };
    return { ok: true, checked, fromSeq: from, toSeq: to, firstBroken: null, head };
  }

  /**
   * @param {number} hours
   * @param {number} [now]
   */
  stats(hours, now = Date.now()) {
    const since = now - hours * 3_600_000;
    return { windowHours: hours, since, total: this.events.count({ from: since }), ...this.events.stats(since) };
  }
}

/** Opaque keyset cursor: `at:seq` in base64url. */
export class Cursor {
  /** @param {EventRow} row */
  static encode(row) {
    return Buffer.from(`${row.at}:${row.seq}`).toString('base64url');
  }

  /** @param {string} cursor */
  static decode(cursor) {
    const m = /^(\d{1,16}):(\d{1,16})$/.exec(Buffer.from(cursor, 'base64url').toString());
    if (!m) throw new AuditError('INVALID_CURSOR', 'cursor is not valid');
    return { at: Number(m[1]), seq: Number(m[2]) };
  }
}
