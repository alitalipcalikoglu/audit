# Chain verification

## What the chain proves

Every stored event gets `hash = SHA-256(prevHash + "\n" + canonical(event))`, where `prevHash` is the previous event's hash (or 64 zeros for the first). `canonical(event)` is the sorted-key JSON of: `id, clientId, source, action, outcome, actor, target, ip, userAgent, requestId, meta (canonical string), at, receivedAt`.

If anyone edits a stored row, deletes one, or inserts one in the middle, every later hash no longer matches. Recomputing the chain from a trusted point detects this.

What it does **not** prove by itself: that the service itself, or someone with write access to the database file *and* the ability to rewrite all later hashes, is honest. Signed periodic anchors close most of that gap — see [chain anchors](chain-anchors.md).

## Head

```bash
rcurl $AUDIT/v1/chain/head
```

```json
{ "seq": 903, "hash": "9c1f…" }
```

## Verify

```bash
rcurl $AUDIT/v1/chain/verify
```

```json
{ "ok": true, "checked": 903, "fromSeq": 1, "toSeq": 903, "firstBroken": null, "head": { "seq": 903, "hash": "9c1f…" } }
```

A range, for large logs (at most `VERIFY_MAX_ROWS` per call, default 100 000):

```bash
rcurl "$AUDIT/v1/chain/verify?fromSeq=800001&toSeq=900000"
```

On tampering:

```json
{ "ok": false, "checked": 411, "fromSeq": 1, "toSeq": 903, "firstBroken": 412, "reason": "hash mismatch at seq 412", "head": { "...": "…" } }
```

`reason` is either `hash mismatch at seq N` (a row was changed, or an earlier row removed and the gap closed) or `seq N is missing` (a row was deleted).

## Checkpoints after retention

Retention deletes only a prefix of the sequence and records the hash of the last removed event as a checkpoint (see [retention](retention.md)). Verification of the remaining events starts from that checkpoint, so `verify` stays `ok` after purges. `fromSeq` below the oldest kept event is answered with `firstBroken` equal to the first stored `seq` and `reason: "no trusted predecessor"` only when no checkpoint covers it, which cannot happen through the service's own purge.

## Recomputing offline (Node.js)

```js
import { createHash } from 'node:crypto';

const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;

export function hashOf(prevHash, e) {
  const payload = canonical({
    id: e.id, clientId: e.clientId, source: e.source, action: e.action, outcome: e.outcome,
    actor: e.actor, target: e.target, ip: e.ip, userAgent: e.userAgent, requestId: e.requestId,
    meta: e.meta === null ? null : canonical(e.meta),
    at: Date.parse(e.at), receivedAt: Date.parse(e.receivedAt),
  });
  return createHash('sha256').update(prevHash).update('\n').update(payload).digest('hex');
}
```

Feed an NDJSON export line by line: `hashOf(prev, e) === e.hash` and `e.prevHash === prev` must hold for every row. Note that `actor`/`target` in the export omit `name` when it is null, which matches the stored payload.
