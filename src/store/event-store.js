import { HashChain } from '../chain.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').EventRow} EventRow */
/** @typedef {import('../types.js').EventRecord} EventRecord */
/** @typedef {import('../types.js').EventFilter} EventFilter */

/** Translates an {@link EventFilter} into a SQL `WHERE` fragment plus bound parameters. */
export class FilterSql {
  /** @type {readonly [keyof EventFilter, string][]} */
  static EQUALS = [
    ['source', 'source = ?'], ['action', 'action = ?'], ['outcome', 'outcome = ?'],
    ['actorType', 'actor_type = ?'], ['actorId', 'actor_id = ?'],
    ['targetType', 'target_type = ?'], ['targetId', 'target_id = ?'],
    ['ip', 'ip = ?'], ['requestId', 'request_id = ?'],
  ];

  /**
   * @param {EventFilter} f
   * @returns {{ where: string, params: (string|number)[] }}
   */
  static build(f) {
    /** @type {string[]} */
    const clauses = [];
    /** @type {(string|number)[]} */
    const params = [];
    for (const [key, sql] of FilterSql.EQUALS) {
      const v = f[key];
      if (v !== undefined) { clauses.push(sql); params.push(/** @type {string} */ (v)); }
    }
    if (f.actionPrefix !== undefined) {
      // Range scan on the action index instead of LIKE, so a prefix such as "auth." stays indexed.
      clauses.push('action >= ? AND action < ?');
      params.push(f.actionPrefix, `${f.actionPrefix}￿`);
    }
    if (f.from !== undefined) { clauses.push('at >= ?'); params.push(f.from); }
    if (f.to !== undefined) { clauses.push('at < ?'); params.push(f.to); }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
}

/**
 * Append-only event log with a hash chain. All writes go through {@link append}, which runs in
 * one transaction so the chain head can never fork inside a process.
 */
export class EventStore {
  static COLUMNS = 'seq, id, client_id, source, action, outcome, actor_type, actor_id, actor_name, target_type, target_id, target_name, ip, user_agent, request_id, meta, at, received_at, prev_hash, hash';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = EventStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO events (id, client_id, source, action, outcome, actor_type, actor_id, actor_name, target_type, target_id, target_name, ip, user_agent, request_id, meta, at, received_at, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      head: db.prepare(`SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1`),
      lastCheckpoint: db.prepare(`SELECT seq, hash FROM checkpoints ORDER BY seq DESC LIMIT 1`),
      checkpointAt: db.prepare(`SELECT seq, hash FROM checkpoints WHERE seq = ?`),
      byClientId: db.prepare(`SELECT ${C} FROM events WHERE source = ? AND client_id = ?`),
      byId: db.prepare(`SELECT ${C} FROM events WHERE id = ?`),
      bySeq: db.prepare(`SELECT ${C} FROM events WHERE seq = ?`),
      range: db.prepare(`SELECT ${C} FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?`),
      minSeq: db.prepare(`SELECT MIN(seq) AS seq FROM events`),
      firstKeptSeq: db.prepare(`SELECT MIN(seq) AS seq FROM events WHERE received_at >= ?`),
      maxSeq: db.prepare(`SELECT MAX(seq) AS seq FROM events`),
      deleteUpTo: db.prepare(`DELETE FROM events WHERE seq <= ?`),
      insertCheckpoint: db.prepare(`INSERT OR REPLACE INTO checkpoints (seq, hash, created_at) VALUES (?, ?, ?)`),
      total: db.prepare(`SELECT COUNT(*) AS n FROM events`),
      since: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE received_at >= ?`),
      bySource: db.prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY n DESC`),
      oldest: db.prepare(`SELECT MIN(received_at) AS t FROM events`),
      statsOutcome: db.prepare(`SELECT outcome, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY outcome`),
      statsSource: db.prepare(`SELECT source, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY source ORDER BY n DESC LIMIT 10`),
      statsAction: db.prepare(`SELECT action, COUNT(*) AS n FROM events WHERE at >= ? GROUP BY action ORDER BY n DESC LIMIT 10`),
      statsActor: db.prepare(`SELECT actor_type, actor_id, actor_name, COUNT(*) AS n FROM events WHERE at >= ? AND actor_id IS NOT NULL GROUP BY actor_type, actor_id ORDER BY n DESC LIMIT 10`),
      statsFailures: db.prepare(`SELECT action, COUNT(*) AS n FROM events WHERE at >= ? AND outcome <> 'success' GROUP BY action ORDER BY n DESC LIMIT 10`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.filterCache = new Map();
  }

  /** Current chain head: the last stored event, else the last checkpoint, else genesis. */
  head() {
    const row = /** @type {{ seq: number, hash: string }|undefined} */ (this.stmt.head.get());
    if (row) return { seq: Number(row.seq), hash: row.hash };
    const cp = /** @type {{ seq: number, hash: string }|undefined} */ (this.stmt.lastCheckpoint.get());
    return cp ? { seq: Number(cp.seq), hash: cp.hash } : { seq: 0, hash: HashChain.GENESIS };
  }

  /**
   * Store records in order inside one transaction. A record whose `clientId` was already
   * seen for the same source is not stored again; the existing row is returned instead.
   * @param {EventRecord[]} records
   * @returns {{ row: EventRow, duplicate: boolean }[]}
   */
  append(records) {
    return this.db.transaction(() => {
      let { hash: prev } = this.head();
      return records.map((r) => {
        if (r.clientId !== null) {
          const existing = /** @type {EventRow|undefined} */ (this.stmt.byClientId.get(r.source, r.clientId));
          if (existing) return { row: existing, duplicate: true };
        }
        const row = /** @type {EventRow} */ ({
          seq: 0, id: r.id, client_id: r.clientId, source: r.source, action: r.action, outcome: r.outcome,
          actor_type: r.actor?.type ?? null, actor_id: r.actor?.id ?? null, actor_name: r.actor?.name ?? null,
          target_type: r.target?.type ?? null, target_id: r.target?.id ?? null, target_name: r.target?.name ?? null,
          ip: r.ip, user_agent: r.userAgent, request_id: r.requestId, meta: r.meta, at: r.at, received_at: r.receivedAt,
          prev_hash: prev, hash: '',
        });
        row.hash = HashChain.hash(prev, row);
        const res = this.stmt.insert.run(row.id, row.client_id, row.source, row.action, row.outcome, row.actor_type, row.actor_id, row.actor_name,
          row.target_type, row.target_id, row.target_name, row.ip, row.user_agent, row.request_id, row.meta, row.at, row.received_at, row.prev_hash, row.hash);
        row.seq = Number(res.lastInsertRowid);
        prev = row.hash;
        return { row, duplicate: false };
      });
    });
  }

  /** @param {string} id */
  byId(id) {
    return /** @type {EventRow|undefined} */ (this.stmt.byId.get(id));
  }

  /** @param {number} seq */
  bySeq(seq) {
    return /** @type {EventRow|undefined} */ (this.stmt.bySeq.get(seq));
  }

  /**
   * Rows `fromSeq..toSeq` inclusive in chain order, at most `limit`.
   * @param {number} fromSeq
   * @param {number} toSeq
   * @param {number} limit
   * @returns {EventRow[]}
   */
  range(fromSeq, toSeq, limit) {
    return /** @type {EventRow[]} */ (this.stmt.range.all(fromSeq, toSeq, limit));
  }

  /**
   * Trusted hash preceding `seq`: the previous row's hash, or a checkpoint left by a purge,
   * or genesis for the very first event. `null` when the predecessor is gone and no
   * checkpoint covers it (the chain cannot be verified from that point).
   * @param {number} seq
   * @returns {string|null}
   */
  trustedPrevHash(seq) {
    if (seq === 1) return HashChain.GENESIS;
    const prevRow = this.bySeq(seq - 1);
    if (prevRow) return prevRow.hash;
    const cp = /** @type {{ seq: number, hash: string }|undefined} */ (this.stmt.checkpointAt.get(seq - 1));
    return cp ? cp.hash : null;
  }

  /** Smallest stored seq, or null when empty. */
  minSeq() {
    const r = /** @type {{ seq: number|null }} */ (this.stmt.minSeq.get());
    return r.seq === null ? null : Number(r.seq);
  }

  /** Largest stored seq, or null when empty. */
  maxSeq() {
    const r = /** @type {{ seq: number|null }} */ (this.stmt.maxSeq.get());
    return r.seq === null ? null : Number(r.seq);
  }

  /**
   * Newest first by event time, keyset pagination on (at, seq).
   * @param {EventFilter} filter
   * @param {{ limit: number, before?: { at: number, seq: number } }} page
   * @returns {EventRow[]}
   */
  list(filter, { limit, before }) {
    const { where, params } = FilterSql.build(filter);
    const cursor = before ? `${where ? `${where} AND` : 'WHERE'} (at < ? OR (at = ? AND seq < ?))` : where;
    const stmt = this.#cached(`SELECT ${EventStore.COLUMNS} FROM events ${cursor} ORDER BY at DESC, seq DESC LIMIT ?`);
    return /** @type {EventRow[]} */ (stmt.all(...params, ...(before ? [before.at, before.at, before.seq] : []), limit));
  }

  /**
   * Stream matching rows oldest first without loading them all; stops after `maxRows`. Prepares
   * its own statement rather than going through {@link #cached}: `StatementSync#iterate()`
   * shares one cursor per statement object, so two concurrent exports with the same filter would
   * otherwise reset each other's iterator mid-stream (one caller's `.next()` rewinds the other's).
   * A fresh statement per call keeps each export's cursor independent.
   * @param {EventFilter} filter
   * @param {number} maxRows
   * @returns {IterableIterator<EventRow>}
   */
  iterate(filter, maxRows) {
    const { where, params } = FilterSql.build(filter);
    const stmt = this.db.prepare(`SELECT ${EventStore.COLUMNS} FROM events ${where} ORDER BY at ASC, seq ASC LIMIT ?`);
    return /** @type {IterableIterator<EventRow>} */ (stmt.iterate(...params, maxRows));
  }

  /**
   * @param {EventFilter} filter
   * @returns {number}
   */
  count(filter) {
    const { where, params } = FilterSql.build(filter);
    const stmt = this.#cached(`SELECT COUNT(*) AS n FROM events ${where}`);
    return Number(/** @type {{ n: number }} */ (stmt.get(...params)).n);
  }

  /**
   * Delete every event received before `cutoff`, keeping the chain verifiable: only a prefix
   * of the sequence is removed and the hash of the last removed row is kept as a checkpoint.
   * @param {number} cutoff  Epoch ms.
   * @param {number} [now]
   * @returns {{ deleted: number, checkpointSeq: number|null }}
   */
  purge(cutoff, now = Date.now()) {
    return this.db.transaction(() => {
      const firstKept = /** @type {{ seq: number|null }} */ (this.stmt.firstKeptSeq.get(cutoff)).seq;
      const lastSeq = firstKept === null ? this.maxSeq() : Number(firstKept) - 1;
      if (lastSeq === null || lastSeq < 1) return { deleted: 0, checkpointSeq: null };
      const last = this.bySeq(lastSeq);
      if (!last) return { deleted: 0, checkpointSeq: null };
      const deleted = Number(this.stmt.deleteUpTo.run(lastSeq).changes);
      if (deleted === 0) return { deleted: 0, checkpointSeq: null };
      this.stmt.insertCheckpoint.run(lastSeq, last.hash, now);
      return { deleted, checkpointSeq: lastSeq };
    });
  }

  /** Numbers for /metrics. */
  counts(now = Date.now()) {
    const oldest = /** @type {{ t: number|null }} */ (this.stmt.oldest.get()).t;
    return {
      total: Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n),
      lastHour: Number(/** @type {{ n: number }} */ (this.stmt.since.get(now - 3_600_000)).n),
      bySource: /** @type {{ source: string, n: number }[]} */ (this.stmt.bySource.all()).map((r) => ({ source: r.source, n: Number(r.n) })),
      oldestAgeSec: oldest === null ? 0 : Math.max(0, Math.floor((now - Number(oldest)) / 1000)),
    };
  }

  /**
   * Aggregates over events with `at >= since`, for dashboards.
   * @param {number} since Epoch ms.
   */
  stats(since) {
    const n = (/** @type {any} */ r) => Number(r.n);
    return {
      byOutcome: Object.fromEntries(/** @type {{ outcome: string, n: number }[]} */ (this.stmt.statsOutcome.all(since)).map((r) => [r.outcome, n(r)])),
      bySource: /** @type {{ source: string, n: number }[]} */ (this.stmt.statsSource.all(since)).map((r) => ({ source: r.source, count: n(r) })),
      topActions: /** @type {{ action: string, n: number }[]} */ (this.stmt.statsAction.all(since)).map((r) => ({ action: r.action, count: n(r) })),
      topActors: /** @type {{ actor_type: string, actor_id: string, actor_name: string|null, n: number }[]} */ (this.stmt.statsActor.all(since)).map((r) => ({ type: r.actor_type, id: r.actor_id, name: r.actor_name, count: n(r) })),
      topFailures: /** @type {{ action: string, n: number }[]} */ (this.stmt.statsFailures.all(since)).map((r) => ({ action: r.action, count: n(r) })),
    };
  }

  /** @param {string} sql */
  #cached(sql) {
    let stmt = this.filterCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.filterCache.set(sql, stmt);
    }
    return stmt;
  }
}
