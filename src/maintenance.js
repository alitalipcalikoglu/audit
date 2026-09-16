/**
 * Periodic retention job: removes events received longer ago than the retention window,
 * leaving a chain checkpoint. Runs once at start and then hourly.
 */
export class Maintenance {
  static INTERVAL_MS = 3_600_000;

  /**
   * @param {object} deps
   * @param {import('./store/event-store.js').EventStore} deps.events
   * @param {import('./types.js').Logger} deps.log
   * @param {{ retentionDays: number }} deps.options
   */
  constructor({ events, log, options }) {
    this.events = events;
    this.log = log;
    this.options = options;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), Maintenance.INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {number} [now] */
  run(now = Date.now()) {
    try {
      const result = this.events.purge(now - this.options.retentionDays * 86_400_000, now);
      if (result.deleted) this.log.info(result, 'retention purge removed events');
      return result;
    } catch (err) {
      this.log.error({ err }, 'maintenance failed');
      return null;
    }
  }
}
