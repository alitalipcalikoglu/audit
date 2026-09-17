import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Canonical } from '../chain.js';

/**
 * @typedef {object} Anchor
 * @property {number} seq
 * @property {string} hash
 * @property {number} at
 */

/**
 * Signs and verifies chain anchors with Ed25519 (`node:crypto`, no dependency needed — unlike
 * `auth`'s ES256/JWT, an anchor is a single detached signature, not a token format, so there is no
 * JOSE/JWK machinery to buy here). `keyId` (first 16 hex chars of the SPKI DER's SHA-256) names
 * which key produced a given anchor's signature, carried alongside it in the `anchors` table, so a
 * verifier — including one with no private key and no database, using only a published public key
 * file — knows which of the current or previous public key it should check against.
 */
export class AnchorSigner {
  /**
   * @param {object} o
   * @param {import('node:crypto').KeyObject} [o.privateKey] Required to {@link sign}; omit for a
   *   verification-only instance (see {@link fromPublicFiles}).
   * @param {import('node:crypto').KeyObject} o.publicKey Current key; {@link keyId} is derived from it.
   * @param {import('node:crypto').KeyObject|null} [o.previousPublicKey] Accepted for verifying
   *   anchors signed before a rotation; not used for new signatures.
   */
  constructor({ privateKey, publicKey, previousPublicKey = null }) {
    this.privateKey = privateKey ?? null;
    this.publicKey = publicKey;
    this.keyId = AnchorSigner.keyId(publicKey);
    this.previousPublicKey = previousPublicKey;
    this.previousKeyId = previousPublicKey ? AnchorSigner.keyId(previousPublicKey) : null;
  }

  /**
   * The exact bytes a signature covers — same canonical-JSON approach as the hash chain itself, so
   * an anchor's signature is over a value with no serialisation ambiguity.
   * @param {Anchor} anchor
   */
  static payload(anchor) {
    return Buffer.from(Canonical.stringify({ seq: anchor.seq, hash: anchor.hash, at: anchor.at }), 'utf8');
  }

  /**
   * @param {Anchor} anchor
   * @returns {string} base64url signature
   */
  sign(anchor) {
    if (!this.privateKey) throw new Error('AnchorSigner: no private key configured, cannot sign');
    return sign(null, AnchorSigner.payload(anchor), this.privateKey).toString('base64url');
  }

  /**
   * Checks the signature against whichever configured public key (current or previous) matches
   * `anchor.keyId`. Never needs the private key or a database — an external verifier can do the
   * same with just the published public key(s) and the anchor's own fields.
   * @param {Anchor & { keyId: string, signature: string }} anchor
   * @returns {{ ok: boolean, reason: string|null }}
   */
  verify(anchor) {
    const key = anchor.keyId === this.keyId ? this.publicKey
      : anchor.keyId === this.previousKeyId ? this.previousPublicKey
        : null;
    if (!key) return { ok: false, reason: `signed by an unrecognised key "${anchor.keyId}"` };
    let ok;
    try {
      ok = verify(null, AnchorSigner.payload(anchor), key, Buffer.from(anchor.signature, 'base64url'));
    } catch {
      ok = false;
    }
    return { ok, reason: ok ? null : 'signature does not match' };
  }

  /** @param {import('node:crypto').KeyObject} publicKey */
  static keyId(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
  }

  /** PEM (SPKI) of the current public key, for `.well-known/audit-anchor-key` and operator export. */
  publicKeyPem() {
    return /** @type {string} */ (this.publicKey.export({ type: 'spki', format: 'pem' }));
  }

  /** PEM of the previous public key, if configured. */
  previousPublicKeyPem() {
    return this.previousPublicKey ? /** @type {string} */ (this.previousPublicKey.export({ type: 'spki', format: 'pem' })) : null;
  }

  /**
   * Normal service operation: loads the private key and derives the current public key from it (no
   * separate public-key file needs to be read or kept in sync), plus the previous public key for
   * rotation, if configured.
   * @param {{ privateKeyPath: string, previousPublicKeyPath?: string|null }} o
   */
  static fromFiles({ privateKeyPath, previousPublicKeyPath = null }) {
    const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
    const publicKey = createPublicKey(privateKey);
    const previousPublicKey = previousPublicKeyPath ? createPublicKey(readFileSync(previousPublicKeyPath, 'utf8')) : null;
    return new AnchorSigner({ privateKey, publicKey, previousPublicKey });
  }

  /**
   * Verification-only construction: no private key file, no database — exactly the "independent of
   * the database" verification path an external auditor would use with just the published public
   * key(s) (e.g. fetched from `GET /.well-known/audit-anchor-key`, saved to a file).
   * @param {{ publicKeyPath: string, previousPublicKeyPath?: string|null }} o
   */
  static fromPublicFiles({ publicKeyPath, previousPublicKeyPath = null }) {
    const publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
    const previousPublicKey = previousPublicKeyPath ? createPublicKey(readFileSync(previousPublicKeyPath, 'utf8')) : null;
    return new AnchorSigner({ publicKey, previousPublicKey });
  }
}
