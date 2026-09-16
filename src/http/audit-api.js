import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Exporter } from './exporter.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../domain/audit-service.js').AuditService} AuditService */
/** @typedef {import('../types.js').EventInput} EventInput */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */

/**
 * HTTP surface. Callers are services and application backends holding an API key; the key's id
 * becomes the `source` of every event it writes.
 */
export class AuditApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {AuditService} deps.service
   * @param {import('../store/event-store.js').EventStore} deps.events
   * @param {import('../db.js').Database} deps.db
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, service, events, db, logger }) {
    this.config = config;
    this.service = service;
    this.events = events;
    this.db = db;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.readyCache = { at: 0, ok: false, error: '' };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    app.decorateRequest('apiKeyId', '');
    app.decorateRequest('apiKeyRole', 'read');
    app.setErrorHandler(this.#errorHandler);
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    this.#registerPublic(app);
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err instanceof AuditError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {FastifyInstance} app */
  #registerPublic(app) {
    app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
    app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
      const ready = this.#readiness();
      if (!ready.ok) {
        app.log.warn({ error: ready.error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', error: ready.error });
      }
      return { status: 'ok' };
    });
  }

  #readiness() {
    const now = Date.now();
    if (now - this.readyCache.at > AuditApi.READY_CACHE_MS) {
      try {
        this.db.ping();
        this.readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        this.readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.readyCache;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKeyId,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };

    // ---- ingest
    api.post('/events', { ...write, schema: { body: Schemas.event } }, async (request, reply) => {
      const [out] = s.ingest(request.apiKeyId, [/** @type {EventInput} */ (request.body)]);
      reply.header('location', `/v1/events/${out.row.id}`);
      return reply.code(out.duplicate ? 200 : 201).send({ event: Views.event(out.row), duplicate: out.duplicate });
    });

    api.post('/events/batch', { ...write, schema: { body: Schemas.batch } }, async (request, reply) => {
      const { events } = /** @type {{ events: EventInput[] }} */ (request.body);
      const out = s.ingest(request.apiKeyId, events);
      return reply.code(201).send({
        accepted: out.filter((o) => !o.duplicate).length,
        duplicates: out.filter((o) => o.duplicate).length,
        items: out.map((o) => ({ id: o.row.id, seq: Number(o.row.seq), clientId: o.row.client_id, duplicate: o.duplicate })),
      });
    });

    // ---- query
    api.get('/events', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      const { items, nextCursor } = s.list(Views.filter(q), { limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor });
      return { items: items.map(Views.event), nextCursor };
    });

    api.get('/events/export', { ...read, schema: { querystring: Schemas.exportQuery } }, async (request, reply) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      const format = /** @type {'ndjson'|'csv'} */ (q.format ?? 'ndjson');
      const rows = this.events.iterate(Views.filter(q), this.config.exportMaxRows);
      reply.type(Exporter.contentType(format));
      reply.header('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.${format}"`);
      reply.header('x-export-max-rows', String(this.config.exportMaxRows));
      return reply.send(Readable.from(Exporter.lines(rows, format)));
    });

    api.get('/events/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => ({
      event: Views.event(s.get(/** @type {{ id: string }} */ (request.params).id)),
    }));

    // ---- chain
    api.get('/chain/head', read, async () => this.events.head());

    api.get('/chain/verify', { ...read, schema: { querystring: Schemas.verifyQuery } }, async (request) => {
      const q = /** @type {{ fromSeq?: string, toSeq?: string }} */ (request.query);
      return s.verify({ fromSeq: q.fromSeq ? Number(q.fromSeq) : undefined, toSeq: q.toSeq ? Number(q.toSeq) : undefined });
    });

    // ---- stats
    api.get('/stats', { ...read, schema: { querystring: Schemas.statsQuery } }, async (request) => {
      const q = /** @type {{ hours?: string }} */ (request.query);
      const st = s.stats(q.hours ? Number(q.hours) : 24);
      return { ...st, since: new Date(st.since).toISOString() };
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const c = this.events.counts();
      const head = this.events.head();
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP audit_events_total Stored events.',
        '# TYPE audit_events_total gauge',
        `audit_events_total ${c.total}`,
        '# HELP audit_events_by_source Stored events per source.',
        '# TYPE audit_events_by_source gauge',
        ...c.bySource.map((r) => `audit_events_by_source{source="${r.source}"} ${r.n}`),
        '# HELP audit_events_received_last_hour Events received in the last hour.',
        '# TYPE audit_events_received_last_hour gauge',
        `audit_events_received_last_hour ${c.lastHour}`,
        '# HELP audit_oldest_event_age_seconds Age of the oldest stored event.',
        '# TYPE audit_oldest_event_age_seconds gauge',
        `audit_oldest_event_age_seconds ${c.oldestAgeSec}`,
        '# HELP audit_chain_head_seq Sequence number at the head of the hash chain.',
        '# TYPE audit_chain_head_seq gauge',
        `audit_chain_head_seq ${head.seq}`,
        '# HELP audit_db_bytes Database size.',
        '# TYPE audit_db_bytes gauge',
        `audit_db_bytes ${this.db.sizeBytes()}`,
        '# HELP audit_process_uptime_seconds Process uptime.',
        '# TYPE audit_process_uptime_seconds gauge',
        `audit_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
