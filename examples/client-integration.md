# Client integration

A recording call must never slow down or fail the business request. Buffer events in memory, flush in batches, retry with idempotent ids, and drop with a log line if the audit service stays unreachable.

```js
import { randomUUID } from 'node:crypto';

/**
 * Minimal audit client: buffers events, flushes as batches, retries with backoff.
 * Every event gets a UUID so retries after a lost response never duplicate.
 */
export class AuditClient {
  static MAX_BUFFER = 5_000;

  /** @param {{ url: string, apiKey: string, flushMs?: number, batchSize?: number, log?: Console }} o */
  constructor({ url, apiKey, flushMs = 2_000, batchSize = 200, log = console }) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.batchSize = batchSize;
    this.log = log;
    /** @type {object[]} */
    this.buffer = [];
    this.timer = setInterval(() => this.flush().catch(() => {}), flushMs).unref();
    this.flushing = false;
  }

  /** @param {{ action: string, outcome?: string, actor?: object, target?: object, ip?: string, userAgent?: string, requestId?: string, meta?: object }} e */
  record(e) {
    if (this.buffer.length >= AuditClient.MAX_BUFFER) {
      this.log.warn('audit buffer full, dropping oldest event');
      this.buffer.shift();
    }
    this.buffer.push({ id: randomUUID(), at: new Date().toISOString(), ...e });
  }

  async flush() {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length) {
        const events = this.buffer.slice(0, this.batchSize);
        await this.#send(events);
        this.buffer.splice(0, events.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** @param {object[]} events */
  async #send(events) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.url}/v1/events/batch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log.error({ status: res.status, body: await res.text() }, 'audit batch rejected, dropping');
          return;
        }
      } catch (err) {
        if (attempt >= 5) throw err;
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
    }
  }

  /** Flush what is left, for graceful shutdown. */
  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
```

Usage in a Fastify service:

```js
const audit = new AuditClient({ url: process.env.AUDIT_URL, apiKey: process.env.AUDIT_API_KEY });

app.post('/orders', async (request, reply) => {
  const order = await orders.create(request.body);
  audit.record({
    action: 'order.create',
    actor: { type: 'user', id: request.user.id },
    target: { type: 'order', id: order.id },
    ip: request.ip, userAgent: request.headers['user-agent'], requestId: request.id,
    meta: { total: order.total, currency: order.currency },
  });
  return order;
});

process.on('SIGTERM', () => audit.close().finally(() => process.exit(0)));
```

## Guidelines

- Record the outcome you know: `failure` for an attempted action that failed, `denied` when authorisation refused it. Both show up in `topFailures`.
- Use the end user's `ip`/`userAgent`, not your server's. Behind a proxy set `TRUST_PROXY=true` in your own service so `request.ip` is right.
- Put identifiers in `actor`/`target`, not in `meta`; only the former are indexed.
- Keep `meta` small and free of secrets; the service redacts common keys, but it is a safety net.
- Pass your `requestId` so a single request can be reconstructed across services.
