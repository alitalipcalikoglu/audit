# Dashboard statistics

`GET /v1/stats?hours=24` aggregates events whose `at` falls in the last N hours (1–720, default 24). Designed for one dashboard call.

```bash
rcurl "$AUDIT/v1/stats?hours=24"
```

```json
{
  "windowHours": 24,
  "since": "2026-09-15T10:00:00.000Z",
  "total": 18422,
  "byOutcome": { "success": 17990, "failure": 401, "denied": 31 },
  "bySource": [ { "source": "auth", "count": 9100 }, { "source": "shop-backend", "count": 9322 } ],
  "topActions": [ { "action": "auth.login", "count": 6200 }, { "action": "auth.refresh", "count": 2800 }, "…" ],
  "topActors": [ { "type": "user", "id": "u7", "name": null, "count": 340 }, "…" ],
  "topFailures": [ { "action": "auth.login", "count": 380 }, { "action": "payment.capture", "count": 21 } ]
}
```

- `topActors` counts events with an actor; a service actor that produces most events will appear here, which is usually what you want to notice.
- `topFailures` covers both `failure` and `denied`.
- Lists are capped at 10 entries.

For time series, scrape `/metrics` instead (see [operations](operations.md)); for anything else, [export](export.md).
