# audit

Central audit log for a set of services: every service pushes "who did what to which object" events over HTTP, the log stores them append-only behind a tamper-evident hash chain, and offers filtered queries, streaming export, verification, statistics and retention.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set AUDIT_API_KEYS
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-audit .
docker run -p 3005:3005 -v audit-data:/data --env-file .env atc-audit
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **An event** is `action` (`auth.login`, `order.create`), `outcome` (`success`/`failure`/`denied`), `actor` and `target` (`{ type, id, name? }`), `ip`, `userAgent`, `requestId`, free-form `meta`, and `at`. The service adds `source`, `seq`, `receivedAt`, `prevHash`, `hash`.
- **Source is the key.** Callers authenticate with `Authorization: Bearer <secret>` from `AUDIT_API_KEYS`; the key's id is recorded as `source`. A caller cannot write events under another service's name.
- **Roles.** Keys are `write` (producers), `read` (dashboards, exporters) or `readwrite`.
- **Hash chain.** `hash = SHA-256(prevHash + "\n" + canonical JSON of the event)`. Editing, removing or reordering a stored event breaks every later hash; `GET /v1/chain/verify` recomputes and reports the first broken position. Anchor `GET /v1/chain/head` externally to detect a full rewrite.
- **Idempotent writes.** An optional client `id` (UUID) makes retries safe: the same `id` from the same source returns the stored event instead of a duplicate.
- **Redaction.** Values under keys like `password`, `token`, `authorization`, `cardNumber` are replaced with `[REDACTED]` inside `meta` before hashing and storage (`REDACT_KEYS`).
- **Retention without gaps.** `RETENTION_DAYS` purges only a prefix of the sequence and keeps a checkpoint hash, so the remaining chain still verifies.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready` | none | Liveness; readiness (database answers, cached 10 s). |
| POST | `/v1/events` | write | Record one event. `201`, or `200` with `duplicate: true`. |
| POST | `/v1/events/batch` | write | `{ events: [...] }`, up to `MAX_BATCH`, one transaction. |
| GET | `/v1/events` | read | Newest first; filters `source`, `action`, `actionPrefix`, `outcome`, `actorType`, `actorId`, `targetType`, `targetId`, `ip`, `requestId`, `from`, `to`; `limit` ≤ 200, `cursor`. |
| GET | `/v1/events/:id` | read | One event. |
| GET | `/v1/events/export` | read | Same filters, oldest first, streamed as `format=ndjson` (default) or `csv`, capped by `EXPORT_MAX_ROWS`. |
| GET | `/v1/chain/head` | read | `{ seq, hash }` of the newest event. |
| GET | `/v1/chain/verify` | read | Recompute the chain over `fromSeq..toSeq` (default all, ≤ `VERIFY_MAX_ROWS`). |
| GET | `/v1/stats` | read | Window aggregates for `hours` (default 24): outcomes, sources, top actions, actors, failures. |
| GET | `/metrics` | read | Prometheus text: totals, per source, last hour, oldest age, head seq, database size, uptime. |

Error codes: `VALIDATION_FAILED`, `INVALID_EVENT`, `TIMESTAMP_INVALID`, `META_TOO_LARGE`, `BATCH_TOO_LARGE`, `EVENT_NOT_FOUND`, `INVALID_CURSOR`, `RANGE_TOO_LARGE`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`.

### Recording from a service

```js
await fetch(`${process.env.AUDIT_URL}/v1/events`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.AUDIT_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    id: crypto.randomUUID(),
    action: 'user.disable',
    actor: { type: 'admin', id: adminId },
    target: { type: 'user', id: userId },
    ip: request.ip, requestId: request.id,
    meta: { reason },
  }),
});
```

A buffered, batching client with retries is in [examples/client-integration.md](examples/client-integration.md).

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example). Required: `AUDIT_API_KEYS` (`id:secret[:role]`, comma separated, secrets ≥ 32 chars).

## Security notes

- API keys compared in constant time; per-key rate limit; read/write separation; bodies capped at `BODY_LIMIT`; unknown fields rejected; `Cache-Control: no-store` on every response.
- `source` is derived from the key, never from the body. Client timestamps may not be more than `CLOCK_SKEW_SEC` in the future; `receivedAt` is always the server clock.
- Hash chain over all stored fields with canonical JSON; verification detects modification, deletion and reordering. The chain has a single writer (one process per database).
- CSV export neutralises formula injection; exports and lists run under the read role only.
- Redaction is a safety net for accidental secrets in `meta`, not a substitute for not sending them.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment, key roles, redaction list |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `Canonical`, `HashChain` | `src/chain.js` | Deterministic JSON and chain hashing/verification |
| `Redactor` | `src/redactor.js` | Sensitive-key replacement in metadata |
| `EventStore`, `FilterSql` | `src/store/event-store.js` | Append, query, iterate, purge with checkpoints, aggregates |
| `AuditService`, `Cursor` | `src/domain/audit-service.js` | Normalisation, ingest, listing, verification, stats |
| `AuditError` | `src/domain/errors.js` | Error codes and HTTP statuses |
| `AuditApi`, `ApiKeyAuth`, `Schemas`, `Views`, `Exporter` | `src/http/` | Fastify routes, roles, shapes, streaming export |
| `Maintenance` | `src/maintenance.js` | Hourly retention purge |

## Out of scope by design

- Alerting and forwarding (webhooks on `denied` events, SIEM push): consume `/v1/events` or `/v1/events/export` from your alerting tool, or schedule exports.
- Full-text search inside `meta`: index the identifiers you filter on as `actor`/`target`/`requestId`; run ad-hoc analysis on exports.
- Multi-writer or clustered storage: one process per SQLite file keeps the chain linear. Run one instance per environment.
- Digital signatures over the chain: the hash chain plus an externally anchored head covers tampering; signing keys would need their own management.

## License

MIT, see [LICENSE](LICENSE).
