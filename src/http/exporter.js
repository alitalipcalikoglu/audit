import { Views } from './views.js';

/** @typedef {import('../types.js').EventRow} EventRow */

/** Streams rows as NDJSON or CSV without buffering the whole result. */
export class Exporter {
  static CSV_COLUMNS = /** @type {const} */ (['seq', 'id', 'at', 'receivedAt', 'source', 'action', 'outcome', 'actorType', 'actorId', 'actorName', 'targetType', 'targetId', 'targetName', 'ip', 'userAgent', 'requestId', 'meta', 'prevHash', 'hash']);

  /** @param {'ndjson'|'csv'} format */
  static contentType(format) {
    return format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8';
  }

  /**
   * @param {Iterable<EventRow>} rows
   * @param {'ndjson'|'csv'} format
   * @returns {Generator<string>}
   */
  static *lines(rows, format) {
    if (format === 'csv') {
      yield `${Exporter.CSV_COLUMNS.join(',')}\n`;
      for (const r of rows) yield `${Exporter.csvRow(r)}\n`;
      return;
    }
    for (const r of rows) yield `${JSON.stringify(Views.event(r))}\n`;
  }

  /** @param {EventRow} r */
  static csvRow(r) {
    const iso = (/** @type {number} */ t) => new Date(Number(t)).toISOString();
    const cells = [r.seq, r.id, iso(r.at), iso(r.received_at), r.source, r.action, r.outcome, r.actor_type, r.actor_id, r.actor_name,
      r.target_type, r.target_id, r.target_name, r.ip, r.user_agent, r.request_id, r.meta, r.prev_hash, r.hash];
    return cells.map(Exporter.csvCell).join(',');
  }

  /**
   * RFC 4180 quoting. Cells starting with a formula trigger are prefixed with `'` so the file
   * opens safely in spreadsheet software.
   * @param {unknown} v
   */
  static csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
}
