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
    `
    -- Signed periodic checkpoints of the chain head (Stage 4). "seq" is the chain head this anchor
    -- covers, PRIMARY KEY so re-anchoring an unchanged head is a caught conflict, not a duplicate
    -- row -- Anchorer checks the last anchor's seq first and skips when nothing has advanced.
    -- "key_id" names which configured signing key (current or previous) produced "signature", so a
    -- key rotation never orphans older anchors -- see AnchorSigner.
    CREATE TABLE anchors (
      seq        INTEGER PRIMARY KEY,
      hash       TEXT NOT NULL,
      at         INTEGER NOT NULL,
      key_id     TEXT NOT NULL,
      signature  TEXT NOT NULL
    );
    CREATE INDEX anchors_at ON anchors (at DESC);
    `,
  ];
}
