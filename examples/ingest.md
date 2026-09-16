# Recording an event

An event answers: who did what to which object, when, from where, and did it succeed.

```bash
wcurl -X POST $AUDIT/v1/events -d '{
  "action": "user.disable",
  "outcome": "success",
  "actor":  { "type": "admin", "id": "adm_42", "name": "Ada" },
  "target": { "type": "user",  "id": "usr_1001" },
  "ip": "203.0.113.9",
  "userAgent": "Mozilla/5.0",
  "requestId": "0f6a4a2e-…",
  "meta": { "reason": "chargeback", "previousStatus": "active" },
  "at": "2026-09-16T10:15:00.000Z"
}'
```

```json
{
  "event": {
    "id": "5a0c…", "seq": 812, "clientId": null,
    "source": "shop-backend",
    "action": "user.disable", "outcome": "success",
    "actor": { "type": "admin", "id": "adm_42", "name": "Ada" },
    "target": { "type": "user", "id": "usr_1001" },
    "ip": "203.0.113.9", "userAgent": "Mozilla/5.0", "requestId": "0f6a4a2e-…",
    "meta": { "previousStatus": "active", "reason": "chargeback" },
    "at": "2026-09-16T10:15:00.000Z", "receivedAt": "2026-09-16T10:15:00.212Z",
    "prevHash": "…", "hash": "…"
  },
  "duplicate": false
}
```

`201 Created` with a `Location` header. Only `action` is required.

## Field rules

| Field | Rule |
|---|---|
| `action` | Lower-case dotted path, 2–6 segments: `auth.login`, `order.item.remove`. Use `<object>.<verb>`; keep the vocabulary small and stable, dashboards group by it. |
| `outcome` | `success` (default), `failure` (tried and failed), `denied` (not allowed to try). |
| `actor` / `target` | `{ type, id, name? }`. `type` is a short lower-case kind (`user`, `admin`, `service`, `system`, `order`). `id` up to 128 chars. |
| `ip` | Must be a valid IPv4/IPv6 address; forward the end user's address from your own request, not your server's. |
| `userAgent` | Up to 512 chars, truncate on your side. |
| `requestId` | Your request or trace id; lets you join audit events with application logs. |
| `meta` | Any JSON object, stored as canonical JSON, at most `META_MAX_BYTES` (8 KiB) after redaction. |
| `at` | ISO 8601. When the action happened. Omit to use the time of receipt. Up to `CLOCK_SKEW_SEC` in the future is tolerated; further is rejected with `TIMESTAMP_INVALID`. |
| `id` | Optional UUID for idempotency, see [batches and idempotency](batch-and-idempotency.md). |

## What the service adds

- `source`: the id of the API key used. The caller cannot set or spoof it.
- `seq`: position in the hash chain (gapless, ascending).
- `receivedAt`: server clock. Use it for retention questions; use `at` for "when did it happen".
- `prevHash`, `hash`: chain links, see [chain verification](chain-verification.md).

## Redaction

Values under keys such as `password`, `token`, `secret`, `authorization`, `cookie`, `apiKey`, `cardNumber`, `cvv`, `iban`, `ssn` are replaced with `"[REDACTED]"` anywhere inside `meta`, before hashing and storage. Matching ignores case, `_` and `-`.

```bash
wcurl -X POST $AUDIT/v1/events -d '{"action":"auth.login","outcome":"failure","meta":{"email":"a@b.c","password":"hunter2","headers":{"Authorization":"Bearer x"}}}'
```

→ `"meta": { "email": "a@b.c", "headers": { "Authorization": "[REDACTED]" }, "password": "[REDACTED]" }`

Configure the list with `REDACT_KEYS`. This is a safety net; do not send secrets in the first place.

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Shape or pattern violated; `details` lists the paths. Unknown fields are rejected. |
| 400 | `INVALID_EVENT` | `ip` is not an IP address. |
| 400 | `TIMESTAMP_INVALID` | `at` unparsable or too far in the future. |
| 413 | `META_TOO_LARGE` | `meta` exceeds `META_MAX_BYTES` after canonicalisation. |
| 403 | `FORBIDDEN` | The key is read-only. |
