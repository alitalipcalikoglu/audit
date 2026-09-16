import { Config } from './config.js';
import { Database } from './db.js';
import { AuditService } from './domain/audit-service.js';
import { AuditApi } from './http/audit-api.js';
import { Maintenance } from './maintenance.js';
import { Redactor } from './redactor.js';
import { EventStore } from './store/event-store.js';

/**
 * Composition root: wires configuration, storage, domain, HTTP and maintenance, and owns the
 * process lifecycle.
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.db = new Database(config.dbPath);
    this.events = new EventStore(this.db);
    this.service = new AuditService({
      events: this.events,
      redactor: new Redactor(config.redactKeys),
      options: { maxBatch: config.maxBatch, metaMaxBytes: config.metaMaxBytes, clockSkewMs: config.clockSkewSec * 1000, verifyMaxRows: config.verifyMaxRows },
    });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Maintenance|null} */
    this.maintenance = null;
    this.shuttingDown = false;
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const api = new AuditApi({ config, service: this.service, events: this.events, db: this.db });
    const app = await api.build();
    this.app = app;
    this.maintenance = new Maintenance({ events: this.events, log: app.log.child({ component: 'maintenance' }), options: { retentionDays: config.retentionDays } });
    this.#installSignalHandlers(app.log);
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, head: this.events.head(), sources: config.apiKeys.map((k) => `${k.id}:${k.role}`) }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.maintenance.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 30_000).unref();
    try {
      this.maintenance?.stop();
      await this.app?.close();
      this.db.close();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
