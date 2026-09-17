# Operations

## Probes

```bash
curl -s $AUDIT/health   # {"status":"ok"}
curl -s $AUDIT/ready    # {"status":"ok"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
rcurl $AUDIT/metrics
```

```
audit_events_total 1204411
audit_events_by_source{source="auth"} 900120
audit_events_by_source{source="shop-backend"} 304291
audit_events_received_last_hour 1811
audit_oldest_event_age_seconds 31535990
audit_chain_head_seq 1204411
audit_db_bytes 734003200
audit_process_uptime_seconds 86400
```

Alert ideas: `audit_events_received_last_hour == 0` during business hours (a producer stopped sending), `increase(audit_chain_head_seq)` flat, `audit_db_bytes` growth.

## Environment

Required: `AUDIT_API_KEYS`. Full list with defaults: [.env.example](../.env.example).

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload audit
```

`instances` must stay 1: the hash chain has one writer per database. `kill_timeout` is 35 s; SIGTERM stops accepting connections, finishes in-flight requests (including running exports), closes the database.

## Docker

```bash
docker build -t atc-audit .
docker run -d -p 3005:3005 -v audit-data:/data --env-file .env atc-audit
```

## Logs

JSON lines. `Authorization` is redacted. Security-relevant lines: `readiness check failed` (warn), `retention purge removed events` (info, with `deleted` and `checkpointSeq`), `maintenance failed` (error), and — when [chain anchors](chain-anchors.md) are configured — `chain anchor written` (info, with `seq`), `anchoring failed` (error), `anchor webhook push failed` (warn — the anchor itself is unaffected).

## Backups

```bash
sqlite3 data/audit.db ".backup 'audit-$(date +%F).db'"
```

Store the daily [chain head](chain-verification.md) with the backup; restoring a backup and verifying against that head proves the restored log is complete. If [chain anchors](chain-anchors.md) are configured, also back up `keys/` (the anchor signing key pair) — `stack backup` from the workspace root does both together.

## Capacity

One event is roughly 400–700 bytes on disk with typical metadata. 10 million events ≈ 5–7 GB. SQLite handles this comfortably on local SSD; keep `RETENTION_DAYS` and `EXPORT_MAX_ROWS` aligned with your disk and export cadence.
