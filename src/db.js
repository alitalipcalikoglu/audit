import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite connection with schema migrations applied on open. */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [
    `
    CREATE TABLE events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      client_id    TEXT,
      source       TEXT NOT NULL,
      action       TEXT NOT NULL,
      outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
      actor_type   TEXT,
      actor_id     TEXT,
      actor_name   TEXT,
      target_type  TEXT,
      target_id    TEXT,
      target_name  TEXT,
      ip           TEXT,
      user_agent   TEXT,
      request_id   TEXT,
      meta         TEXT,
      at           INTEGER NOT NULL,
      received_at  INTEGER NOT NULL,
      prev_hash    TEXT NOT NULL,
      hash         TEXT NOT NULL,
      UNIQUE (source, client_id)
    );
    CREATE INDEX events_at        ON events (at DESC, seq DESC);
    CREATE INDEX events_action    ON events (action, at DESC);
    CREATE INDEX events_actor     ON events (actor_id, at DESC);
    CREATE INDEX events_target    ON events (target_type, target_id, at DESC);
    CREATE INDEX events_source    ON events (source, at DESC);
    CREATE INDEX events_request   ON events (request_id);
    CREATE INDEX events_received  ON events (received_at);

    -- Hash of the last purged event, so verification can start right after a retention purge.
    CREATE TABLE checkpoints (
      seq        INTEGER PRIMARY KEY,
      hash       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    `,
  ];

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  /** Database file size in bytes as SQLite sees it. */
  sizeBytes() {
    const r = /** @type {{ bytes: number }} */ (this.raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get());
    return Number(r.bytes);
  }

  close() {
    this.raw.close();
  }
}
