# Retention

`RETENTION_DAYS` (default 365) bounds how long events are kept, measured on `receivedAt` (server time), not `at`. An hourly job, also run at startup, deletes what is older.

## Why it cannot break the chain

Naively deleting rows by age would leave gaps and make [verification](chain-verification.md) fail. The purge instead:

1. finds the first event received inside the retention window: its `seq` is `K`;
2. deletes every event with `seq < K` (always a prefix of the chain, because `seq` increases with `receivedAt`);
3. stores a checkpoint `{ seq: K-1, hash }` with the hash of the last deleted event.

Verification of `seq >= K` uses the checkpoint as trusted predecessor. Any number of purges leaves a chain that verifies from its oldest kept event to the head.

Consequence: an event with an old `at` that arrived recently (a backfill) is kept as long as the events around it, because retention follows `receivedAt`.

## Observing it

Log line when something was removed:

```json
{"level":30,"component":"maintenance","deleted":18422,"checkpointSeq":120311,"msg":"retention purge removed events"}
```

Metric: `audit_oldest_event_age_seconds` should stay near `RETENTION_DAYS × 86400`.

## Keeping data longer than the service

Export before it expires; the export carries the hashes:

```bash
rcurl "$AUDIT/v1/events/export?to=$(date -u -v-300d +%Y-%m-%dT00:00:00Z)" | gzip > cold/audit-until-$(date +%F).ndjson.gz
```

## Changing the window

Lowering `RETENTION_DAYS` and restarting purges immediately on the first maintenance run. Raising it only affects future purges; deleted events are gone.
