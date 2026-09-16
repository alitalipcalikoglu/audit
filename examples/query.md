# Querying events

`GET /v1/events` returns newest first (by `at`, then `seq`), 50 per page by default, at most 200.

```bash
rcurl "$AUDIT/v1/events?limit=2"
```

```json
{
  "items": [ { "id": "…", "seq": 903, "action": "order.create", "...": "…" }, { "id": "…", "seq": 902, "...": "…" } ],
  "nextCursor": "MTc1ODAxMjM0NTY3ODo5MDI"
}
```

Pass `nextCursor` back as `cursor` for the next page; `null` means the end. Cursors are opaque and stable while you paginate even if new events arrive.

```bash
rcurl "$AUDIT/v1/events?limit=2&cursor=MTc1ODAxMjM0NTY3ODo5MDI"
```

## Filters

All filters combine with AND.

| Parameter | Matches |
|---|---|
| `source` | Key id that wrote the event: `source=auth` |
| `action` | Exact: `action=auth.login` |
| `actionPrefix` | Everything under a namespace: `actionPrefix=auth.` (indexed range scan, not a LIKE) |
| `outcome` | `success`, `failure`, `denied` |
| `actorType`, `actorId` | Who did it |
| `targetType`, `targetId` | What was affected |
| `ip` | Exact address |
| `requestId` | Join with your logs |
| `from`, `to` | ISO 8601 on `at`; `from` inclusive, `to` exclusive |

Everything a user did today:

```bash
rcurl "$AUDIT/v1/events?actorType=user&actorId=u7&from=$(date -u +%Y-%m-%dT00:00:00Z)"
```

Every failed or denied login in the last hour:

```bash
rcurl "$AUDIT/v1/events?action=auth.login&outcome=failure&from=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"
rcurl "$AUDIT/v1/events?action=auth.login&outcome=denied&from=…"
```

History of one object across services:

```bash
rcurl "$AUDIT/v1/events?targetType=user&targetId=usr_1001"
```

Everything that happened inside one request:

```bash
rcurl "$AUDIT/v1/events?requestId=0f6a4a2e-…"
```

## One event

```bash
rcurl $AUDIT/v1/events/5a0c…
```

`404 EVENT_NOT_FOUND` when the id is unknown or the event was purged by retention.

## Not available

- Free-text search inside `meta`. Put the values you need to filter on into `actor`, `target`, `action` or `requestId`; export to your analytics store for ad-hoc questions.
- Sorting other than newest first. Use `from`/`to` windows to walk forward.
