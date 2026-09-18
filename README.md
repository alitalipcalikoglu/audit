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
- **Hash chain.** `hash = SHA-256(prevHash + "\n" + canonical JSON of the event)`. Editing, removing or reordering a stored event breaks every later hash; `GET /v1/chain/verify` recomputes and reports the first broken position.
- **Signed anchors (optional).** With `ANCHOR_PRIVATE_KEY_PATH` set, a periodic job signs the current chain head (Ed25519) and records it in `anchors`; `verify()` checks any anchor in range against both the recomputed hash and its signature. See "Chain anchors" below.
- **Idempotent writes.** An optional client `id` (UUID) makes retries safe: the same `id` from the same source returns the stored event instead of a duplicate.
- **Redaction.** Values under keys like `password`, `token`, `authorization`, `cardNumber` are replaced with `[REDACTED]` inside `meta` before hashing and storage (`REDACT_KEYS`).
- **Retention without gaps.** `RETENTION_DAYS` purges only a prefix of the sequence and keeps a checkpoint hash, so the remaining chain still verifies.

## Boundaries

**Purpose:** durable, tamper-evident log of the platform's write and security events.

**Responsibilities:** event ingestion; hash-chain integrity; periodic signed anchors; filtered export; anchor key rotation.

**Non-responsibilities:** audit ≠ primary business datastore — no service in this workspace reads its own state back out of audit; it is a write-optimized, append-only sink, not a query/reporting store for business data. It does not decide whether an action was allowed, only records that it happened.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database answers, cached 10 s); service identity (version, API version, capabilities, schema version, service-core version). |
| POST | `/v1/events` | write | Record one event. `201`, or `200` with `duplicate: true`. |
| POST | `/v1/events/batch` | write | `{ events: [...] }`, up to `MAX_BATCH`, one transaction. |
| GET | `/v1/events` | read | Newest first; filters `source`, `action`, `actionPrefix`, `outcome`, `actorType`, `actorId`, `targetType`, `targetId`, `ip`, `requestId`, `from`, `to`; `limit` ≤ 200, `cursor`. |
| GET | `/v1/events/:id` | read | One event. |
| GET | `/v1/events/export` | read | Same filters, oldest first, streamed as `format=ndjson` (default) or `csv`, capped by `EXPORT_MAX_ROWS`. |
| GET | `/v1/chain/head` | read | `{ seq, hash }` of the newest event. |
| GET | `/v1/chain/verify` | read | Recompute the chain over `fromSeq..toSeq` (default all, ≤ `VERIFY_MAX_ROWS`); also checks any anchor in range, if anchors are configured. |
| GET | `/v1/chain/anchors` | read | Anchors, newest first (`limit` ≤ 200, `beforeSeq`). |
| GET | `/v1/chain/anchors/latest` | read | Most recent anchor; `404` if none written yet. |
| GET | `/.well-known/audit-anchor-key` | none | Current (and previous, during rotation) Ed25519 public key, PEM — verify an anchor with no database and no private key. `404` when anchors are not configured. |
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

## Chain anchors

Optional, off by default (`ANCHOR_PRIVATE_KEY_PATH` unset). A periodic job (`ANCHOR_INTERVAL_MIN`,
default 60) signs the current chain head — `{ seq, hash, at }`, Ed25519 (`node:crypto`, no
dependency) — and records it in `anchors`. `GET /v1/chain/verify` then also checks every anchor in
its range against the hash it just recomputed for that seq (catches a tampered or forged anchor row
even if it doesn't check any live events itself) and the signature (catches a forged/corrupted
signature or one from a key this service doesn't recognise). Skips writing when the head hasn't
advanced since the last anchor — nothing new to attest to.

**Generate a key pair:** `npm run anchor-keygen -- keys/anchor` (writes `keys/anchor-private.pem`,
mode `0600`, and `keys/anchor-public.pem`; refuses to overwrite). Point `ANCHOR_PRIVATE_KEY_PATH` at
the private key; the service derives its own public key from it — the public file is for you to
publish, this service never reads it back.

**Verifying independently of this service:** `GET /.well-known/audit-anchor-key` returns the current
public key (and the previous one, during a rotation) as PEM, with each one's `keyId`. Given that,
an anchor's own fields (`seq`, `hash`, `at`, `keyId`, `signature`), and `node:crypto`'s `verify(null,
canonicalPayload, publicKey, signature)`, an external verifier needs neither this service's database
nor its private key — `AnchorSigner.fromPublicFiles` in this repo is exactly that, usable standalone.

**Key rotation:** generate a new pair under a new name, point `ANCHOR_PRIVATE_KEY_PATH` at it and
`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` at the old public key, restart. New anchors sign with the new key;
old anchors keep verifying against the previous key as long as that file stays configured. Remove
`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` once you no longer need to verify anchors from before the rotation
— removing it earlier makes every anchor signed under the old key unverifiable by this service (its
`GET /v1/chain/verify` reports "unrecognised key"), though the signatures themselves remain valid
against the old public key file if you kept a copy.

**External anchoring — what `ANCHOR_WEBHOOK_URL` does and does not give you.** Setting it makes
`Anchorer` also `POST` each anchor to that URL, best-effort (a failure is logged, never blocks or
invalidates the anchor, which is already durably written to this service's own database first). This
is genuinely *a copy landing somewhere outside this service's own `DATA_DIR`* — not the SQLite file,
not a second file in the same directory, which is not an external trust boundary at all (anyone who
can tamper with the database can tamper with a second local file the same way, in the same
transaction, undetected). What it is **not**, automatically, is independent corroboration: if the
same operator (or the same compromised credentials) controls both this service and whatever answers
at `ANCHOR_WEBHOOK_URL`, an attacker who can rewrite the chain here can rewrite the copy there too,
in sync, and the anchor "confirms" a rewritten history just as confidently as a real one. Genuine
external trust needs a receiving system operated independently of whoever operates this service —
a separate team, a separate credential boundary, ideally a separate organisation (a public
transparency log, a customer's own system, a third-party attestation service). This codebase does
not provide, and does not claim to provide, such a destination; `ANCHOR_WEBHOOK_URL` is the
mechanism to reach one you already trust, not a source of trust by itself. There is no built-in
"external" destination and none is faked here.

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
| `AnchorSigner` | `src/crypto/anchor-signer.js` | Ed25519 sign/verify for chain anchors, key rotation |
| `Anchorer` | `src/anchorer.js` | Periodic job: sign and record an anchor over the current head |
| `AnchorWebhook` | `src/anchor-webhook.js` | Optional best-effort external push of each anchor |
| `AnchorKeyGenerator` | `scripts/anchor-keygen.js` | Anchor signing key pair |

## Out of scope by design

- Alerting and forwarding (webhooks on `denied` events, SIEM push): consume `/v1/events` or `/v1/events/export` from your alerting tool, or schedule exports.
- Full-text search inside `meta`: index the identifiers you filter on as `actor`/`target`/`requestId`; run ad-hoc analysis on exports.
- Multi-writer or clustered storage: one process per SQLite file keeps the chain linear. Run one instance per environment.

## Audit events

This service is the sink, not a producer — see "Model" above for the event shape and "API" for how
callers record events (`POST /v1/events`, `POST /v1/events/batch`). It does not run an `AuditClient`
against itself; there is nowhere else to forward to. Every other service in the workspace
authenticates with a `write`-role key from `AUDIT_API_KEYS` and posts its own write and security
events here.

## Scaling model

**B — single-node stateful.** One process owns the SQLite chain. The append path (`BEGIN IMMEDIATE`
around reading the current head and inserting) is what keeps the chain from forking within that
process; running two processes against the same file is not the deployment model this is built or
tested for.

## Observability

Accepts an inbound `X-Request-Id` unconditionally (an internal service, reached only from other
services) and logs it via Fastify's default request logging. Also parses an inbound `traceparent`,
trusted only when `TRUST_PROXY=true` — the caller's trace-id is continued with a fresh span-id for
this hop, both logged as `traceId`/`spanId` via `@atc-web/service-core`'s `registerRequestContext`.
The one outbound call this service can make — `ANCHOR_WEBHOOK_URL`, when configured — does not
carry a trace header either, since it posts a signed anchor record to an external, operator-configured
target, not a request being proxied (proven by a security-regression test — see
[OBSERVABILITY.md](../stack/docs/OBSERVABILITY.md)).
`/metrics` is entirely database-derived — nothing here resets on restart.

## Backup / restore

Back up the database file; the whole point of the chain is that a restore from an incomplete
backup is detectable (`GET /v1/chain/verify` will report a gap) rather than silently wrong. Use
`stack backup`/`stack restore` from the workspace root (see `stack/docs/UPGRADE.md`) to do this
consistently alongside the rest of the stack — when anchors are configured (`ANCHOR_PRIVATE_KEY_PATH`
set), `stack backup` includes the anchor signing key pair (and the previous public key, during a
rotation) in the same snapshot as the database, resolved from the real configured path, the same way
`auth` backs up its JWT keys (see `stack/docs/BACKUP.md`, "Anchor key backup semantics" — the exact
path is not assumed to be `keys/`, and a path pointing outside this service's own folder is
deliberately excluded rather than followed). On every start, before applying a pending migration to
an existing database, the service itself also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>`
(directory overridable with `DB_BACKUP_DIR`) — a manual last resort if `stack restore` is unavailable.
Losing the private key entirely (outside a `stack backup`/`stack restore` round-trip — e.g. it was
never backed up, or anchoring was only enabled after the fact) means no *new* anchor can ever be
signed under that `keyId` again (generate a fresh pair and treat it as a rotation), though every
anchor already written and verified stays valid. **A `stack backup` snapshot with anchoring
configured contains real private key material — see `stack/docs/BACKUP.md`'s security note before
treating it as an ordinary data export.**

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it. A restore rewinds the chain — always re-run `/v1/chain/verify`
afterward; if it rewinds past the most recent anchor(s), those anchors now describe a head that no
longer exists — `verify()` only ever checks anchors inside the range you ask it to check, so this is
visible (the anchor simply won't be in range after a rewind to before it), not silently wrong.

See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
