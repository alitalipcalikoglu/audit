# audit examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `AUDIT_API_KEYS`; callers are services and application backends, never browsers. Base URL below is `http://localhost:3005`.

| Example | Shows |
|---|---|
| [Recording an event](ingest.md) | Fields, what the service adds, how `source` is derived, metadata redaction |
| [Batches and idempotency](batch-and-idempotency.md) | Sending many events at once, safe retries with client ids |
| [Querying events](query.md) | Every filter, prefix search on actions, cursor pagination |
| [Exporting](export.md) | Streaming NDJSON and CSV for compliance and offline analysis |
| [Chain verification](chain-verification.md) | What the hash chain proves, verifying it, anchoring the head externally, checkpoints after purges |
| [Dashboard statistics](stats.md) | Window aggregates: outcomes, sources, top actions, actors, failures |
| [API keys and roles](keys-and-roles.md) | Read, write and readwrite keys; one key per source |
| [Retention](retention.md) | How old events are removed without breaking verification |
| [Client integration](client-integration.md) | A small Node.js client with buffering, batching and retry |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, backups |

Set up once for the examples:

```bash
export AUDIT=http://localhost:3005
export WRITE_KEY=<a write or readwrite secret from AUDIT_API_KEYS>
export READ_KEY=<a read or readwrite secret from AUDIT_API_KEYS>
alias wcurl='curl -s -H "Authorization: Bearer $WRITE_KEY" -H "Content-Type: application/json"'
alias rcurl='curl -s -H "Authorization: Bearer $READ_KEY"'
```
