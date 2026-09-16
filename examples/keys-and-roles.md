# API keys and roles

`AUDIT_API_KEYS=id:secret[:role],…`

| Role | Can | Give to |
|---|---|---|
| `write` | `POST /v1/events`, `POST /v1/events/batch` | Services and backends that record events |
| `read` | `GET /v1/events*`, `/v1/chain/*`, `/v1/stats`, `/metrics` | Dashboards, exporters, compliance tooling |
| `readwrite` | Both | Local development; avoid in production |

```env
AUDIT_API_KEYS=auth:3f9a…:write,shop-backend:71cc…:write,console:b02e…:read,siem-export:e6d1…:read
```

Rules enforced at startup: ids match `[A-Za-z0-9_-]{1,64}` and are unique; secrets are at least 32 characters and unique.

## One key per source

The key id becomes `source` on every event it writes, and `source` is a filter. Give each service its own key so:

- a compromised key can be rotated without touching other services,
- events cannot be attributed to another service,
- per-key rate limiting (`RATE_LIMIT_MAX` per minute) isolates a noisy client.

## Rotation

Add the new key, deploy the caller with it, remove the old key. Both are valid in between. Events written with the old key keep `source` equal to the id, so keep the same id and only change the secret.

## Responses

| Status | Code | Meaning |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or unknown secret. `WWW-Authenticate: Bearer` is set. |
| 403 | `FORBIDDEN` | Known key, wrong role. |
| 429 | `RATE_LIMITED` | Per-key limit; message contains the wait time. |

Keys are compared in constant time against every configured secret, so timing does not reveal whether or which key matched.
