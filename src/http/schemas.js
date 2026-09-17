/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static uuid = { type: 'string', format: 'uuid' };
  /** Dotted, lower-case: `auth.login`, `order.item.remove`. */
  static action = { type: 'string', pattern: '^[a-z0-9]+(\\.[a-z0-9_-]+){1,5}$', maxLength: 120 };
  static outcome = { type: 'string', enum: ['success', 'failure', 'denied'] };
  static kind = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' };
  static shortId = { type: 'string', minLength: 1, maxLength: 128 };
  static party = {
    type: 'object', additionalProperties: false, required: ['type', 'id'],
    properties: { type: Schemas.kind, id: Schemas.shortId, name: { type: 'string', minLength: 1, maxLength: 200 } },
  };

  static event = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      id: Schemas.uuid,
      action: Schemas.action,
      outcome: Schemas.outcome,
      actor: Schemas.party,
      target: Schemas.party,
      ip: { type: 'string', minLength: 2, maxLength: 45 },
      userAgent: { type: 'string', maxLength: 512 },
      requestId: Schemas.shortId,
      meta: { type: 'object' },
      at: { type: 'string', format: 'date-time' },
    },
  };

  static batch = {
    type: 'object', additionalProperties: false, required: ['events'],
    properties: { events: { type: 'array', minItems: 1, maxItems: 5_000, items: Schemas.event } },
  };

  static idParams = { type: 'object', properties: { id: Schemas.uuid }, required: ['id'] };

  static filter = {
    source: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    action: Schemas.action,
    actionPrefix: { type: 'string', pattern: '^[a-z0-9]+(\\.[a-z0-9_-]*){0,5}$', maxLength: 120 },
    outcome: Schemas.outcome,
    actorType: Schemas.kind,
    actorId: Schemas.shortId,
    targetType: Schemas.kind,
    targetId: Schemas.shortId,
    ip: { type: 'string', minLength: 2, maxLength: 45 },
    requestId: Schemas.shortId,
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  };

  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: { ...Schemas.filter, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: { type: 'string', maxLength: 128 } },
  };

  static exportQuery = {
    type: 'object', additionalProperties: false,
    properties: { ...Schemas.filter, format: { type: 'string', enum: ['ndjson', 'csv'] } },
  };

  static verifyQuery = {
    type: 'object', additionalProperties: false,
    properties: { fromSeq: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, toSeq: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
  };

  static statsQuery = {
    type: 'object', additionalProperties: false,
    properties: { hours: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|[1-6][0-9][0-9]|7[01][0-9]|720)$' } },
  };

  static anchorsQuery = {
    type: 'object', additionalProperties: false,
    properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, beforeSeq: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
  };
}
