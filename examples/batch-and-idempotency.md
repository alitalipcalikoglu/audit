# Batches and idempotency

## Batch

Up to `MAX_BATCH` (default 500) events in one request, stored in order inside one transaction. Either the whole batch is stored or nothing is.

```bash
wcurl -X POST $AUDIT/v1/events/batch -d '{
  "events": [
    { "id": "0b1f6c9a-9a2f-4d4a-8f0e-1c4d2e3f4a51", "action": "cart.add",    "actor": { "type": "user", "id": "u7" }, "target": { "type": "product", "id": "p1" } },
    { "id": "0b1f6c9a-9a2f-4d4a-8f0e-1c4d2e3f4a52", "action": "cart.remove", "actor": { "type": "user", "id": "u7" }, "target": { "type": "product", "id": "p1" } },
    { "id": "0b1f6c9a-9a2f-4d4a-8f0e-1c4d2e3f4a53", "action": "order.create","actor": { "type": "user", "id": "u7" }, "target": { "type": "order", "id": "o9" } }
  ]
}'
```

```json
{
  "accepted": 3,
  "duplicates": 0,
  "items": [
    { "id": "…", "seq": 901, "clientId": "0b1f6c9a-…51", "duplicate": false },
    { "id": "…", "seq": 902, "clientId": "0b1f6c9a-…52", "duplicate": false },
    { "id": "…", "seq": 903, "clientId": "0b1f6c9a-…53", "duplicate": false }
  ]
}
```

One invalid event fails the whole request with `VALIDATION_FAILED` and the index in the path (`/events/1/action`), so nothing is half-written.

## Idempotency

Networks fail after the server committed but before the client read the response. Give every event a client-generated UUID in `id`; a retry with the same `id` from the same source returns the already stored event instead of a second copy.

```bash
wcurl -X POST $AUDIT/v1/events -d '{"id":"7e2d3c1b-0000-4000-8000-000000000001","action":"payment.capture","target":{"type":"payment","id":"pay_1"}}'
# 201 {"event":{...,"seq":904},"duplicate":false}
wcurl -X POST $AUDIT/v1/events -d '{"id":"7e2d3c1b-0000-4000-8000-000000000001","action":"payment.capture","target":{"type":"payment","id":"pay_1"}}'
# 200 {"event":{...,"seq":904},"duplicate":true}
```

Rules:

- Uniqueness is per source: two services may use the same `id` without colliding.
- The content of a duplicate is not compared; the first write wins. Never reuse an id for a different event.
- Duplicates inside one batch are reported per item (`duplicate: true`) and the batch still succeeds.
- Events without `id` are never deduplicated.

## Sizing

`BODY_LIMIT` (default 1 MiB) caps the request. A 500-event batch with rich `meta` may need 2–4 MiB; raise `BODY_LIMIT` or send smaller batches. Rate limit is `RATE_LIMIT_MAX` requests per key per minute, independent of batch size, so batching also spends less of the limit.
