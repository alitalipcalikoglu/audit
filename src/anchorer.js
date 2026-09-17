/**
 * Periodic job: signs and records an anchor over the current chain head (see
 * `AuditService.anchor`). Entirely optional — only constructed and started when
 * `ANCHOR_PRIVATE_KEY_PATH` is configured; the rest of this service works identically without it.
 */
export class Anchorer {
  /**
   * @param {object} deps
   * @param {import('./domain/audit-service.js').AuditService} deps.service
   * @param {import('./anchor-webhook.js').AnchorWebhook|null} deps.webhook Optional external push
   *   — best-effort, fire-and-forget; failure here never blocks or invalidates the anchor, which is
   *   already durably recorded locally before the push is even attempted.
   * @param {import('./types.js').Logger} deps.log
   * @param {{ intervalMs: number }} deps.options
   */
  constructor({ service, webhook, log, options }) {
    this.service = service;
    this.webhook = webhook;
    this.log = log;
    this.options = options;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), this.options.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {number} [now] */
  run(now = Date.now()) {
    try {
      const anchor = this.service.anchor(now);
      if (!anchor) return null;
      this.log.info({ seq: anchor.seq }, 'chain anchor written');
      this.webhook?.post(anchor).catch((err) => {
        this.log.warn({ err, seq: anchor.seq }, 'anchor webhook push failed; the anchor is still recorded and verifiable locally');
      });
      return anchor;
    } catch (err) {
      this.log.error({ err }, 'anchoring failed');
      return null;
    }
  }
}
