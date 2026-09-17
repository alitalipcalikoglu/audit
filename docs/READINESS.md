# audit readiness contract

## Purpose

Central, tamper-evident, append-only log for every other service's write and security events: a
sequential SHA-256 hash chain over canonical JSON, filtered/paginated queries, streaming NDJSON/CSV
export, and retention with a checkpoint so a pruned chain stays independently verifiable.

## Dependencies

None. Every other service calls *this* one; audit calls nothing.

## Persistence

SQLite (`DB_PATH`, default `./data/audit.db`): `events` (append-only, `UNIQUE(source, client_id)`
for idempotent ingest, indexed for every filter field) and `checkpoints` (one row per retention
purge, holding the hash of the last row deleted). Same migration mechanism as every service
(`user_version`, one transaction per migration, WAL, `synchronous=NORMAL`).

## Health endpoint

`GET /health`: static `{"status":"ok"}`.

## Readiness endpoint

`GET /ready`: `db.ping()`, cached 10 s. No side effects.

## Graceful shutdown

SIGTERM/SIGINT → stop the hourly maintenance timer → `app.close()` (an in-flight export finishes
streaming) → close the database → exit. Force-exit at 30 s; PM2 `kill_timeout` 35 000 ms.

## Resource limits

`BODY_LIMIT` (default 1 048 576 bytes), `MAX_BATCH` (default 500 events per `/v1/events/batch`
call), `META_MAX_BYTES` (default 8192, per event's `meta` field after canonicalisation),
`EXPORT_MAX_ROWS`/`VERIFY_MAX_ROWS` (default 100 000, caps one export or one chain-verify call).
`max_memory_restart`: 300M.

## Timeouts

None of its own — audit makes no outbound calls, so there is nothing to time out on its side beyond
the standard per-request handling.

## Retry policy

Not applicable: audit is a pure receiver with no outbound calls or background jobs that retry.
Callers forwarding events to it (every other service's `net/audit-client.js`) own their own retry.

## Idempotency

`POST /v1/events` and `/v1/events/batch` are idempotent per `(source, client_id)`: a duplicate
`id` from the same caller is accepted without creating a second row (checked inside the same
`BEGIN IMMEDIATE` transaction as the insert, backed by the `UNIQUE` constraint as a second line of
defence). There is no idempotency key on read/export/verify endpoints because they have no side
effects to repeat.

## Backup

The entire chain is the thing to protect — losing it loses the audit history it exists to keep, and
a restore from an incomplete backup is detectably incomplete (chain verification will report a gap)
rather than silently wrong, which is a useful property but not a substitute for backing it up.

## Restore

Restore the database file and restart; run `GET /v1/chain/verify` afterward to confirm the restored
chain is intact from its genesis or its most recent checkpoint.

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
parse or log `traceparent`; not applicable since it makes no outbound calls to forward one on.

## Security model

Keys `id:secret[:role]`, roles `read`/`write`/`readwrite`, compared in constant time against every
configured key. `source` (who an event is attributed to) is always the calling key's own id — never
taken from the request body — so a caller cannot forge another service's identity. Known-sensitive
`meta` keys are redacted before hashing (`src/redactor.js`), so a leaked secret in a caller's event
payload does not end up in the immutable log either. No rotation beyond listing a second key id
alongside the old one and removing the old one later (the same pattern every service's plain
`id:secret` key list supports).

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
