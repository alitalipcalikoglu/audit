import { Database as CoreDatabase } from '@atc-web/service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
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
}
