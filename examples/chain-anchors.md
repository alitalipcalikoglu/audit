# Chain anchors

Signed periodic checkpoints of the chain head. Off by default; needs `ANCHOR_PRIVATE_KEY_PATH`.
Read [chain verification](chain-verification.md) first — anchors are an additional check layered
on top of the hash chain, not a replacement for it.

## Generate a key pair

```bash
npm run anchor-keygen -- keys/anchor
```

Writes `keys/anchor-private.pem` (mode `0600`) and `keys/anchor-public.pem`. Refuses to overwrite —
generate under a new name for rotation (below). Point the service at the private key:

```bash
ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem
ANCHOR_INTERVAL_MIN=60   # default; how often a new anchor is written, if the head has advanced
```

The service derives its own public key from the private key file — it never reads
`keys/anchor-public.pem` back. That file is for you to publish or hand to a verifier.

## What gets written

Once enabled, an anchor is written on start and then every `ANCHOR_INTERVAL_MIN`, skipped when the
chain head hasn't advanced since the last one:

```bash
rcurl $AUDIT/v1/chain/anchors/latest
```

```json
{ "anchor": { "seq": 903, "hash": "9c1f…", "at": "2026-09-17T12:00:00.000Z", "keyId": "e39ec45b5c0ca2a4", "signature": "MEUCIQ…" } }
```

```bash
rcurl "$AUDIT/v1/chain/anchors?limit=20"
```

```json
{ "items": [ { "seq": 903, "...": "…" }, { "seq": 840, "...": "…" } ], "nextBeforeSeq": 840 }
```

## Verification checks anchors automatically

`GET /v1/chain/verify` already checks every anchor whose `seq` falls inside the range you ask it to
verify — both that the anchor's own `hash` matches the hash independently recomputed for that `seq`,
and that its `signature` is valid:

```bash
rcurl "$AUDIT/v1/chain/verify?fromSeq=1&toSeq=903"
```

```json
{ "ok": true, "checked": 903, "...": "…", "anchors": { "checked": 3, "invalid": [] } }
```

A tampered anchor row (someone edited `anchors.hash` or `anchors.signature` directly, without also
managing to rewrite the live chain consistently) surfaces here even when the events themselves check
out:

```json
{ "ok": false, "firstBroken": 840, "reason": "seq 840: anchor hash does not match the chain at that seq", "anchors": { "checked": 3, "invalid": [{ "seq": 840, "reason": "anchor hash does not match the chain at that seq" }] } }
```

## Verifying independently — no database, no private key

```bash
curl -s $AUDIT/.well-known/audit-anchor-key
```

```json
{ "current": { "keyId": "e39ec45b5c0ca2a4", "algorithm": "Ed25519", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }, "previous": null }
```

Save that public key to a file, then check any anchor you were given (from `GET /v1/chain/anchors`,
or from wherever `ANCHOR_WEBHOOK_URL` delivered a copy) against it — this service's own
`AnchorSigner.fromPublicFiles` is exactly this, usable standalone:

```js
import { AnchorSigner } from './crypto/anchor-signer.js'; // or reimplement: node:crypto verify(null, canonicalPayload, publicKey, signature)

const verifier = AnchorSigner.fromPublicFiles({ publicKeyPath: './anchor-public.pem' });
const result = verifier.verify({ seq: 903, hash: '9c1f…', at: Date.parse('2026-09-17T12:00:00.000Z'), keyId: 'e39ec45b5c0ca2a4', signature: 'MEUCIQ…' });
// { ok: true, reason: null }
```

## Key rotation

```bash
npm run anchor-keygen -- keys/anchor-2027
```

```bash
ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-2027-private.pem
ANCHOR_PREVIOUS_PUBLIC_KEY_PATH=./keys/anchor-public.pem   # the old public key
```

Restart. New anchors sign with the new key; anchors signed before the rotation still verify, because
`verify()` and `.well-known/audit-anchor-key` both check `keyId` against either the current or the
previous key. Keep `ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` configured for as long as you might need to
verify pre-rotation anchors — dropping it makes the service itself report them "signed by an
unrecognised key" (still cryptographically valid against the old public key file, if you kept one,
just no longer checked by this running instance).

## Pushing anchors externally (optional, read this before relying on it)

```bash
ANCHOR_WEBHOOK_URL=https://your-collector.example.com/anchors
```

Each anchor is `POST`ed there too, best-effort — a failure is logged, never blocks or invalidates
the anchor (already written locally first). **This is not automatically an independent trust
boundary.** If you and whoever operates that URL are the same party, an attacker who compromises
this host can rewrite history and the pushed copy in sync — the push "confirms" nothing an attacker
with that level of access couldn't also fake. It is worth doing when the receiving system is
genuinely operated independently (a separate team, a customer's own system, a public log); it is not
a substitute for that independence, and none is invented or assumed here.

## Backup

Back up `keys/` (the anchor signing key pair, and the previous public key during a rotation)
alongside the database — `stack backup` from the workspace root does this for you. Losing the
private key means no *new* anchor can be signed under that `keyId` again; generate a fresh pair and
treat it as a rotation. Every anchor already written and verified stays valid regardless.
