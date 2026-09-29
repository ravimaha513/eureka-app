import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type pg from "pg";
import type { JobDefinition } from "../runner.js";
import { dueDailyKeys } from "../schedule.js";
import type { ExportSink } from "../sink.js";

/**
 * audit-export (design A6.4, B6): exports one closed UTC day of
 * eureka.audit_event as gzip JSON Lines to audit/YYYY/MM/DD/audit-events.jsonl.gz,
 * then appends {digest, row count, seq range} to eureka.audit_export.
 *
 * - One line per row, ordered by seq, serialized by Postgres (json_build_object)
 *   so bigint and timestamps are exact; `at` is ISO 8601 UTC with microseconds.
 * - All pages are read in one REPEATABLE READ READ ONLY transaction, so the file
 *   is a consistent snapshot; the statement timeout is the 60 s export timeout (N9).
 * - `changes` is exported as stored; AuditService redacts sensitive values
 *   (phone, DOB, personal email, rate) before they are written.
 * - The digest is SHA-256 of the gzip bytes, i.e. the object S3 stores and the
 *   value sent as x-amz-checksum-sha256.
 * - Idempotent: a day already in the ledger is skipped; the file is written
 *   before the ledger row, and the content is deterministic, so a retry after a
 *   failed ledger insert rewrites identical bytes (a new object version under
 *   Object Lock; the earlier version stays retained).
 */
export const AUDIT_EXPORT_JOB = "audit-export";
export const AUDIT_EXPORT_TIME = { hh: 3, mm: 30, timeZone: "America/New_York" } as const;
const PAGE = 5000;

export interface AuditExportResult {
  exportDate: string;
  objectKey: string;
  rowCount: number;
  byteSize: number;
  sha256Hex: string;
  skipped: boolean;
}

export function auditObjectKey(exportDate: string): string {
  const [y, m, d] = exportDate.split("-");
  return `audit/${y}/${m}/${d}/audit-events.jsonl.gz`;
}

export async function exportAuditDay(
  pool: pg.Pool, sink: ExportSink, exportDate: string, signal?: AbortSignal,
): Promise<AuditExportResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportDate)) throw new Error(`invalid export date: ${exportDate}`);
  const objectKey = auditObjectKey(exportDate);

  const done = await pool.query<{ object_key: string; row_count: number; byte_size: string; sha256_hex: string }>(
    "SELECT object_key, row_count, byte_size, sha256_hex FROM eureka.audit_export WHERE export_date = $1",
    [exportDate]);
  if (done.rows[0]) {
    const r = done.rows[0];
    return { exportDate, objectKey: r.object_key, rowCount: r.row_count, byteSize: Number(r.byte_size),
      sha256Hex: r.sha256_hex, skipped: true };
  }

  const lines: string[] = [];
  let firstSeq: string | null = null;
  let lastSeq: string | null = null;
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL statement_timeout = '60s'");
    let after = "0";
    for (;;) {
      if (signal?.aborted) throw new Error("audit export aborted (shutdown)");
      const { rows } = await c.query<{ seq: string; line: string }>(
        `SELECT seq::text AS seq, json_build_object(
                  'seq', seq,
                  'at', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'actor_id', actor_id, 'action', action, 'entity_type', entity_type,
                  'entity_id', entity_id, 'changes', changes, 'request_id', request_id,
                  'ip', host(ip))::text AS line
           FROM eureka.audit_event
           WHERE at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
             AND at <  ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
             AND seq > $2::bigint
           ORDER BY seq LIMIT $3`, [exportDate, after, PAGE]);
      for (const r of rows) lines.push(r.line);
      if (rows.length > 0) {
        firstSeq ??= rows[0]!.seq;
        lastSeq = rows[rows.length - 1]!.seq;
        after = lastSeq;
      }
      if (rows.length < PAGE) break;
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }

  const jsonl = Buffer.from(lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  const body = gzipSync(jsonl, { level: 9 });
  const digest = createHash("sha256").update(body).digest();
  const sha256Hex = digest.toString("hex");
  await sink.put(objectKey, body, digest, "application/gzip");

  await pool.query(
    `INSERT INTO eureka.audit_export (export_date, object_key, row_count, first_seq, last_seq, byte_size, sha256_hex)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [exportDate, objectKey, lines.length, firstSeq, lastSeq, body.length, sha256Hex]);

  return { exportDate, objectKey, rowCount: lines.length, byteSize: body.length, sha256Hex, skipped: false };
}

export function auditExportJob(sink: ExportSink, catchupDays: number): JobDefinition {
  const { hh, mm, timeZone } = AUDIT_EXPORT_TIME;
  return {
    name: AUDIT_EXPORT_JOB,
    dueKeys: (now) => dueDailyKeys(now, hh, mm, timeZone, catchupDays),
    async run(runKey, ctx) {
      const r = await exportAuditDay(ctx.pool, sink, runKey, ctx.signal);
      return { objectKey: r.objectKey, rowCount: r.rowCount, byteSize: r.byteSize, sha256: r.sha256Hex,
        skipped: r.skipped, sink: sink.kind };
    },
  };
}
