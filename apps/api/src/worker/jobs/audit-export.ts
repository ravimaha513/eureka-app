import { createHash } from "node:crypto";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import type pg from "pg";
import type { Logger } from "../log.js";
import type { JobDefinition } from "../runner.js";
import { addDays, daysBetween, latestDueDailyKey, utcDateKey } from "../schedule.js";
import type { ExportSink, PutResult } from "../sink.js";

/**
 * audit-export (design A6.4, B6): exports one closed UTC day of
 * eureka.audit_event as gzip JSON Lines to audit/YYYY/MM/DD/audit-events.jsonl.gz,
 * then appends {digest, row count, seq range} to eureka.audit_export.
 *
 * - One line per row, ordered by (at, seq) and paged on the (at, seq) index
 *   (migration 0020), serialized by Postgres (json_build_object) so bigint and
 *   timestamps are exact; `at` is ISO 8601 UTC with microseconds. The ledger's
 *   first_seq/last_seq are the smallest and largest seq in the file.
 * - All pages are read in one REPEATABLE READ READ ONLY transaction, so the file
 *   is a consistent snapshot; the statement timeout is the 60 s export timeout (N9).
 * - Rows are streamed through gzip and SHA-256 as they arrive: only the
 *   compressed bytes are held in memory, and the uncompressed size is capped
 *   (maxBytes) with an explicit error.
 * - `changes` is exported as stored; AuditService redacts sensitive values
 *   (phone, DOB, personal email, rate) before they are written.
 * - The digest is SHA-256 of the gzip bytes, i.e. the object S3 stores and the
 *   value sent as x-amz-checksum-sha256.
 * - Idempotent: a day already in the ledger is skipped; the file is written
 *   create-only before the ledger row, and the content is deterministic, so a
 *   retry after a failed ledger insert finds an identical object ("existed")
 *   and only inserts the ledger row (no second Object Lock version).
 */
export const AUDIT_EXPORT_JOB = "audit-export";
export const AUDIT_EXPORT_TIME = { hh: 3, mm: 30, timeZone: "America/New_York" } as const;
/** Uncompressed size limit of one day's file (single-part PutObject, held compressed in memory). */
export const AUDIT_EXPORT_MAX_BYTES = 1024 * 1024 * 1024;
const PAGE = 5000;
const ALERT_EVERY_MS = 3600_000;

export interface AuditExportResult {
  exportDate: string;
  objectKey: string;
  rowCount: number;
  byteSize: number;
  sha256Hex: string;
  skipped: boolean;
  /** How the object got there; absent when skipped. */
  put?: PutResult;
}

export interface ExportOptions {
  signal?: AbortSignal;
  /** Called after every page (liveness heartbeat). */
  heartbeat?: () => void;
  /** Uncompressed byte cap; default AUDIT_EXPORT_MAX_BYTES. */
  maxBytes?: number;
}

export function auditObjectKey(exportDate: string): string {
  const [y, m, d] = exportDate.split("-");
  return `audit/${y}/${m}/${d}/audit-events.jsonl.gz`;
}

export async function exportAuditDay(
  pool: pg.Pool, sink: ExportSink, exportDate: string, opts: ExportOptions = {},
): Promise<AuditExportResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportDate)) throw new Error(`invalid export date: ${exportDate}`);
  const { signal, heartbeat, maxBytes = AUDIT_EXPORT_MAX_BYTES } = opts;
  const objectKey = auditObjectKey(exportDate);

  const done = await pool.query<{ object_key: string; row_count: number; byte_size: string; sha256_hex: string }>(
    "SELECT object_key, row_count, byte_size, sha256_hex FROM eureka.audit_export WHERE export_date = $1",
    [exportDate]);
  if (done.rows[0]) {
    const r = done.rows[0];
    return { exportDate, objectKey: r.object_key, rowCount: r.row_count, byteSize: Number(r.byte_size),
      sha256Hex: r.sha256_hex, skipped: true };
  }

  const gz = createGzip({ level: 9 });
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let byteSize = 0;
  gz.on("data", (b: Buffer) => { chunks.push(b); hash.update(b); byteSize += b.length; });
  // Surfaced through once(gz, ...) below; the listener keeps it from being unhandled.
  gz.on("error", () => undefined);
  let rowCount = 0;
  let rawBytes = 0;
  let minSeq: bigint | null = null;
  let maxSeq: bigint | null = null;

  const c = await pool.connect();
  // A checked-out client that loses its connection emits 'error'; without a
  // listener that would crash the process. Remember it and discard the client.
  let clientError: Error | null = null;
  const onClientError = (err: Error) => { clientError = err; };
  c.on("error", onClientError);
  let discard = false;
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL statement_timeout = '60s'");
    let afterAt = `${exportDate}T00:00:00.000000Z`;
    let afterSeq = "0";
    for (;;) {
      if (signal?.aborted) throw new Error("audit export aborted");
      const { rows } = await c.query<{ seq: string; at_key: string; line: string }>(
        `SELECT seq::text AS seq,
                to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_key,
                json_build_object(
                  'seq', seq,
                  'at', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'actor_id', actor_id, 'action', action, 'entity_type', entity_type,
                  'entity_id', entity_id, 'changes', changes, 'request_id', request_id,
                  'ip', host(ip))::text AS line
           FROM eureka.audit_event
           WHERE at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
             AND at <  ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
             AND (at, seq) > ($2::timestamptz, $3::bigint)
           ORDER BY at, seq LIMIT $4`, [exportDate, afterAt, afterSeq, PAGE]);
      for (const r of rows) {
        const line = `${r.line}\n`;
        rawBytes += Buffer.byteLength(line);
        if (rawBytes > maxBytes) {
          throw new Error(`audit export of ${exportDate} exceeds ${maxBytes} bytes uncompressed; ` +
            "raise AUDIT_EXPORT_MAX_BYTES or split the day");
        }
        const seq = BigInt(r.seq);
        if (minSeq === null || seq < minSeq) minSeq = seq;
        if (maxSeq === null || seq > maxSeq) maxSeq = seq;
        rowCount++;
        if (!gz.write(line)) await once(gz, "drain");
      }
      heartbeat?.();
      if (rows.length < PAGE) break;
      afterAt = rows[rows.length - 1]!.at_key;
      afterSeq = rows[rows.length - 1]!.seq;
    }
    await c.query("COMMIT");
  } catch (err) {
    gz.destroy();
    discard = clientError !== null;
    if (!discard) await c.query("ROLLBACK").catch(() => { discard = true; });
    throw err;
  } finally {
    c.off("error", onClientError);
    c.release(discard ? (clientError ?? true) : undefined);
  }

  const ended = once(gz, "end");
  gz.end();
  await ended;
  const body = Buffer.concat(chunks, byteSize);
  chunks.length = 0;
  const digest = hash.digest();
  const sha256Hex = digest.toString("hex");
  const put = await sink.put(objectKey, body, digest, "application/gzip", signal);

  await pool.query(
    `INSERT INTO eureka.audit_export (export_date, object_key, row_count, first_seq, last_seq, byte_size, sha256_hex)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [exportDate, objectKey, rowCount, minSeq?.toString() ?? null, maxSeq?.toString() ?? null, byteSize, sha256Hex]);

  return { exportDate, objectKey, rowCount, byteSize, sha256Hex, skipped: false, put };
}

/**
 * Days to export at `now`, oldest first, at most `maxPerTick`: every UTC day
 * from the first exported day (or, with an empty ledger, the first audit
 * event's day) up to the latest due day that has no ledger row. Driven by the
 * ledger, not a fixed look-back, so no day is ever skipped after downtime and a
 * day that keeps failing is retried even once later days have been exported.
 */
export async function dueAuditDays(
  pool: pg.Pool, now: Date, maxPerTick: number,
): Promise<{ days: string[]; lastExported: string | null; firstDay: string; lastDue: string }> {
  const { hh, mm, timeZone } = AUDIT_EXPORT_TIME;
  const lastDue = latestDueDailyKey(now, hh, mm, timeZone);
  const b = await pool.query<{ last_exported: string | null; first_day: string }>(
    `SELECT (SELECT max(export_date) FROM eureka.audit_export)::text AS last_exported,
            LEAST($1::date, COALESCE(
              (SELECT min(export_date) FROM eureka.audit_export),
              (SELECT (min(at) AT TIME ZONE 'UTC')::date FROM eureka.audit_event),
              $1::date))::text AS first_day`, [lastDue]);
  const { last_exported: lastExported, first_day: firstDay } = b.rows[0]!;
  const d = await pool.query<{ day: string }>(
    `SELECT g::date::text AS day
       FROM generate_series($1::date, $2::date, interval '1 day') AS g
      WHERE NOT EXISTS (SELECT 1 FROM eureka.audit_export e WHERE e.export_date = g::date)
      ORDER BY g LIMIT $3`, [firstDay, lastDue, maxPerTick]);
  return { days: d.rows.map((r) => r.day), lastExported, firstDay, lastDue };
}

export function auditExportJob(sink: ExportSink, maxDaysPerTick: number): JobDefinition {
  let lastAlertAt = 0;
  const alertIfBehind = (log: Logger, now: Date, lastExported: string | null, firstDay: string) => {
    const yesterday = addDays(utcDateKey(now), -1);
    const behind = lastExported === null ? daysBetween(firstDay, yesterday) : daysBetween(lastExported, yesterday);
    if (behind <= 1 || now.getTime() - lastAlertAt < ALERT_EVERY_MS) return;
    lastAlertAt = now.getTime();
    log.error("audit export is behind", { job: AUDIT_EXPORT_JOB, alert: true, lastExported, yesterday, daysBehind: behind });
  };
  return {
    name: AUDIT_EXPORT_JOB,
    async dueKeys(now, ctx) {
      const due = await dueAuditDays(ctx.pool, now, maxDaysPerTick);
      alertIfBehind(ctx.log, now, due.lastExported, due.firstDay);
      return due.days;
    },
    async run(runKey, ctx) {
      const r = await exportAuditDay(ctx.pool, sink, runKey, { signal: ctx.signal, heartbeat: ctx.heartbeat });
      return { objectKey: r.objectKey, rowCount: r.rowCount, byteSize: r.byteSize, sha256: r.sha256Hex,
        skipped: r.skipped, put: r.put ?? null, sink: sink.kind };
    },
  };
}
