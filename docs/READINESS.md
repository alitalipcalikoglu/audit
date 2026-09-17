# audit readiness contract

## Purpose

Central, tamper-evident, append-only log for every other service's write and security events: a
sequential SHA-256 hash chain over canonical JSON, filtered/paginated queries, streaming NDJSON/CSV
export, and retention with a checkpoint so a pruned chain stays independently verifiable.

## Dependencies

None required. Every other service calls *this* one; audit's only optional outbound call is
`ANCHOR_WEBHOOK_URL` (best-effort external push of a signed anchor — see "Chain anchors" in
README.md), which is off unless explicitly configured and never gates any request this service
serves.

## Persistence

SQLite (`DB_PATH`, default `./data/audit.db`): `events` (append-only, `UNIQUE(source, client_id)`
for idempotent ingest, indexed for every filter field), `checkpoints` (one row per retention purge,
holding the hash of the last row deleted), and `anchors` (Stage 4, schema v2 — one row per signed
periodic checkpoint of the chain head: `seq PRIMARY KEY`, `hash`, `at`, `key_id`, `signature`; empty
unless `ANCHOR_PRIVATE_KEY_PATH` is set). Same migration mechanism as every service (`user_version`,
one transaction per migration, WAL, `synchronous=NORMAL`) — the v1→v2 migration that adds `anchors`
is this service's first real schema migration since the Stage 3 mechanism was built.

## Health endpoint

`GET /health`: static `{"status":"ok"}`.

## Readiness endpoint

`GET /ready`: `db.ping()`, cached 10 s. No side effects.

## Graceful shutdown

SIGTERM/SIGINT → stop the hourly maintenance timer → stop the anchor timer, if anchors are
configured (an anchor mid-flight is not interrupted — it is synchronous DB work — only the *next*
scheduled tick is what "stop" prevents) → `app.close()` (an in-flight export finishes streaming) →
close the database → exit. Force-exit at 30 s; PM2 `kill_timeout` 35 000 ms.

## Resource limits

`BODY_LIMIT` (default 1 048 576 bytes), `MAX_BATCH` (default 500 events per `/v1/events/batch`
call), `META_MAX_BYTES` (default 8192, per event's `meta` field after canonicalisation),
`EXPORT_MAX_ROWS`/`VERIFY_MAX_ROWS` (default 100 000, caps one export or one chain-verify call).
`max_memory_restart`: 300M.

## Timeouts

None of its own on the receiving side. The one outbound call this service can make —
`ANCHOR_WEBHOOK_URL`, if configured — times out at `ANCHOR_WEBHOOK_TIMEOUT_MS` (default 5000),
service-core's standard `HttpCaller` behaviour.

## Retry policy

Not applicable to ingest: audit is a pure receiver; callers forwarding events to it (every other
service's `net/audit-client.js`) own their own retry. The anchor webhook push is not retried within
one `Anchorer` tick either — a failure is logged and the next scheduled anchor (`ANCHOR_INTERVAL_MIN`
later, or sooner if the head advances again) is the next attempt; the anchor itself is never lost
regardless, since it's already durably recorded before the push is even attempted.

## Idempotency

`POST /v1/events` and `/v1/events/batch` are idempotent per `(source, client_id)`: a duplicate
`id` from the same caller is accepted without creating a second row (checked inside the same
`BEGIN IMMEDIATE` transaction as the insert, backed by the `UNIQUE` constraint as a second line of
defence). There is no idempotency key on read/export/verify endpoints because they have no side
effects to repeat.

## Backup

The entire chain is the thing to protect — losing it loses the audit history it exists to keep, and
a restore from an incomplete backup is detectably incomplete (chain verification will report a gap)
rather than silently wrong, which is a useful property but not a substitute for backing it up. If
anchors are configured, `keys/` (the Ed25519 signing key pair, and the previous public key during a
rotation) is backed up alongside the database — see README.md's "Chain anchors".

## Restore

Restore the database file and restart; run `GET /v1/chain/verify` afterward to confirm the restored
chain is intact from its genesis or its most recent checkpoint. If a restore rewinds past the most
recent anchor(s), those simply fall outside any range `verify()` is asked to check going forward —
visible by their absence, not a false pass.

## Metrics

`GET /metrics`: every number (`audit_events_total`, `audit_events_by_source`,
`audit_events_received_last_hour`, `audit_oldest_event_age_seconds`, plus chain head/db-size
gauges) is computed from the database at request time — none are process-local counters, so a
restart does not reset anything `/metrics` reports.

## Logging

Fastify's default request logging (`requestIdHeader: 'x-request-id'`, so it already logs whichever
id the caller — gateway, console, or a peer service — sent). Redacts `authorization`. See
[OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md) for the target vocabulary this does not yet
fully emit (`service`, `version`, `traceId`).

## Tracing

Accepts an inbound `X-Request-Id` unconditionally (internal service, reached only from other
services on a private network — see OBSERVABILITY.md's trust-boundary discussion). Does not yet
parse or log `traceparent`; the anchor webhook push (when configured) does not carry one either — it
posts a signed anchor record, not a request being proxied on behalf of an inbound caller.

## Security model

Keys `id:secret[:role]`, roles `read`/`write`/`readwrite`, compared in constant time against every
configured key. `source` (who an event is attributed to) is always the calling key's own id — never
taken from the request body — so a caller cannot forge another service's identity. Known-sensitive
`meta` keys are redacted before hashing (`src/redactor.js`), so a leaked secret in a caller's event
payload does not end up in the immutable log either. No rotation beyond listing a second key id
alongside the old one and removing the old one later (the same pattern every service's plain
`id:secret` key list supports).

**Chain anchors (Stage 4):** Ed25519 (`node:crypto`), private key never stored in the database
(`ANCHOR_PRIVATE_KEY_PATH`, PEM file, mode 0600). `keyId` (first 16 hex chars of the SHA-256 of the
public key's SPKI DER) travels with every anchor, so verification — including from a completely
external tool with only a published public key, see `AnchorSigner.fromPublicFiles` — never needs to
guess which key signed it. `verify()` checks an anchor's signature *and* its stored hash against the
hash it independently recomputes for that same seq from the live chain, so a tampered anchor row is
caught even when the live events around it are untouched, and a tampered live event is still caught
by the pre-existing hash-chain check regardless of whether anchors are configured at all — the two
checks are independent, neither weakens the other. What anchoring does **not** protect against: an
attacker with write access to the database *and* the anchor private key can rewrite history and
re-sign it consistently — the private key is protection against a party who can alter the database
but not the key file (a narrower, still real, threat model: e.g. a backup restored from a compromised
host, a SQL-injection-only compromise, a misconfigured read path that became writable). Anchoring is
detection of unauthorized tampering by a party without the signing key, not prevention of a fully
compromised host, and not (by itself) proof to a third party unless that third party received the
anchor through a channel `ANCHOR_WEBHOOK_URL` and this operator do not both control — see README.md's
"External anchoring" for exactly what that option does and does not give you.

## Scaling model

**B — single-node stateful.** One process owns the SQLite file. The append path (`BEGIN IMMEDIATE`
around reading the current chain head and inserting) is what makes the chain correct *within* one
process; SQLite's own file locking would serialise a second process on the same file rather than
letting the chain fork, but running two processes against one file is not the deployment model this
service is built or tested for, and doubles the maintenance/purge work for no benefit.

## Single-node / multi-node guarantees

One process per database file. The hash chain's integrity guarantee (`prev_hash` linkage, checked
by `/v1/chain/verify`) does not by itself prove single-writer discipline was followed — it proves
tamper-evidence of whatever sequence of appends actually happened, whether from one process or,
unsupported, from several racing each other.

## Known failure modes

- Concurrent `GET /v1/events/export` requests: fixed as of Stage 0 (`src/store/event-store.js`,
  `iterate()`) — each export now prepares its own SQL statement instead of sharing a cached one, so
  two simultaneous exports no longer reset each other's cursor mid-stream.
- Disk full during an insert: the transaction fails, `ROLLBACK`s, the caller sees a 5xx; the chain
  is not left in a half-written state (SQLite's own transaction guarantee).
- A caller sending events with a clock far ahead of audit's own: rejected past `CLOCK_SKEW_SEC`
  (default 300 s) tolerance, not silently accepted with a future timestamp.
- Retention purge (`Maintenance`, hourly) deletes only a `seq` prefix and records a checkpoint —
  `/v1/chain/verify` from before that checkpoint correctly reports "no trusted predecessor" rather
  than false-passing; verifying from at or after the checkpoint still works.
- `ANCHOR_WEBHOOK_URL` destination unreachable, refused by the SSRF guard, or timing out: the anchor
  is unaffected — it was already written and signed locally before the push was attempted. `Anchorer`
  logs a warning and moves on; the next scheduled tick (or the next real head advance) is the next
  attempt. Nothing about ingest, query, verification or any other endpoint is affected.
- `ANCHOR_PRIVATE_KEY_PATH` set but the file is missing/unreadable/not a valid key: fails at startup
  (`AnchorSigner.fromFiles` throws before `Lifecycle.install`), the same fail-fast treatment as a bad
  `TLS_CERT_PATH` — never starts silently without anchors when they were supposed to be on.
- A verifier configured with the wrong public key, or missing `ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` after
  a rotation: `verify()` reports the affected anchor(s) as invalid ("unrecognised key") rather than
  silently skipping them or reporting `ok: true` — see "Chain anchors" in README.md.
