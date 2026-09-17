import { HttpCaller } from '@atc-web/service-core/http';

/** @typedef {import('@atc-web/service-core/http').NetGuard} NetGuard */

/**
 * Posts a written anchor to an operator-configured external URL, best-effort. This is *a* copy
 * landing somewhere other than this service's own `DATA_DIR` — not, by itself, a trust boundary:
 * whether it means anything as independent corroboration depends entirely on who operates the
 * receiving endpoint. If the same operator controls both this service and whatever answers at
 * `ANCHOR_WEBHOOK_URL`, this provides no protection against that operator tampering with both in
 * sync — see "External anchoring" in README.md for what this does and does not guarantee.
 */
export class AnchorWebhook {
  static USER_AGENT = 'atc-audit-anchor/1.0';

  /**
   * @param {object} o
   * @param {string} o.url
   * @param {NetGuard} o.guard
   * @param {number} o.timeoutMs
   */
  constructor({ url, guard, timeoutMs }) {
    this.url = url;
    this.guard = guard;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {import('./types.js').AnchorRow} anchor
   * @returns {Promise<void>} rejects on any failure (SSRF-guard, network, non-2xx) — the caller
   *   decides what "best-effort" means (Anchorer logs and moves on, never blocks on this).
   */
  async post(anchor) {
    const target = await this.guard.resolve(this.url);
    const body = JSON.stringify({ seq: anchor.seq, hash: anchor.hash, at: new Date(anchor.at).toISOString(), keyId: anchor.key_id, signature: anchor.signature });
    await HttpCaller.send(target, 'POST', { 'content-type': 'application/json', 'user-agent': AnchorWebhook.USER_AGENT }, body, this.timeoutMs, 'anchor destination');
  }
}
