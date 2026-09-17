import { Config } from './config.js';
import { Lifecycle } from '@atc-web/service-core/lifecycle';
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
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
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
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
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
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => this.maintenance?.stop(),
        () => this.app?.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, head: this.events.head(), sources: config.apiKeys.map((k) => `${k.id}:${k.role}`) }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.maintenance.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

}
