/** @typedef {import('../types.js').EventRow} EventRow */
/** @typedef {import('../types.js').EventFilter} EventFilter */
/** @typedef {import('../types.js').AnchorRow} AnchorRow */

/** Response shapes and query-to-filter mapping. */
export class Views {
  /** @param {AnchorRow} a */
  static anchor(a) {
    return { seq: Number(a.seq), hash: a.hash, at: new Date(Number(a.at)).toISOString(), keyId: a.key_id, signature: a.signature };
  }

  /** @param {EventRow} r */
  static event(r) {
    return {
      id: r.id,
      seq: Number(r.seq),
      clientId: r.client_id,
      source: r.source,
      action: r.action,
      outcome: r.outcome,
      actor: r.actor_id === null && r.actor_type === null ? null : { type: r.actor_type, id: r.actor_id, ...(r.actor_name === null ? {} : { name: r.actor_name }) },
      target: r.target_id === null && r.target_type === null ? null : { type: r.target_type, id: r.target_id, ...(r.target_name === null ? {} : { name: r.target_name }) },
      ip: r.ip,
      userAgent: r.user_agent,
      requestId: r.request_id,
      meta: r.meta === null ? null : JSON.parse(r.meta),
      at: new Date(Number(r.at)).toISOString(),
      receivedAt: new Date(Number(r.received_at)).toISOString(),
      prevHash: r.prev_hash,
      hash: r.hash,
    };
  }

  /**
   * Query string (already schema-validated) to store filter; timestamps become epoch ms.
   * @param {Record<string, string|undefined>} q
   * @returns {EventFilter}
   */
  static filter(q) {
    /** @type {EventFilter} */
    const f = {};
    for (const k of /** @type {const} */ (['source', 'action', 'actionPrefix', 'actorType', 'actorId', 'targetType', 'targetId', 'ip', 'requestId'])) {
      if (q[k] !== undefined) f[k] = q[k];
    }
    if (q.outcome !== undefined) f.outcome = /** @type {EventFilter['outcome']} */ (q.outcome);
    if (q.from !== undefined) f.from = Date.parse(q.from);
    if (q.to !== undefined) f.to = Date.parse(q.to);
    return f;
  }
}
