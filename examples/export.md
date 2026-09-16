# Exporting

`GET /v1/events/export` streams every matching event oldest first, using the same filters as [querying](query.md). Nothing is buffered server-side, so a million-row export uses constant memory.

## NDJSON (default)

One JSON object per line, the same shape as `GET /v1/events/:id`.

```bash
rcurl "$AUDIT/v1/events/export?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z" -o audit-2026-09.ndjson
head -1 audit-2026-09.ndjson | jq .
```

## CSV

```bash
rcurl "$AUDIT/v1/events/export?format=csv&source=auth" -o auth.csv
```

Columns: `seq,id,at,receivedAt,source,action,outcome,actorType,actorId,actorName,targetType,targetId,targetName,ip,userAgent,requestId,meta,prevHash,hash`. `meta` is the canonical JSON string. Cells that start with `=`, `+`, `-`, `@` are prefixed with `'` so the file cannot inject formulas when opened in a spreadsheet.

## Limits

The response carries `X-Export-Max-Rows` (`EXPORT_MAX_ROWS`, default 100 000). An export stops silently at that many rows, so split large ranges by time:

```bash
for day in 01 02 03; do
  rcurl "$AUDIT/v1/events/export?from=2026-09-${day}T00:00:00Z&to=2026-09-$((day+1))T00:00:00Z" >> september.ndjson
done
```

The row count of a window is cheap to check first:

```bash
rcurl "$AUDIT/v1/events?from=…&to=…&limit=1" | jq '.nextCursor != null'
```

## Verifying an export offline

Every line carries `prevHash` and `hash`; with a contiguous `seq` range you can recompute the chain without the service. The hash input is documented in [chain verification](chain-verification.md).
