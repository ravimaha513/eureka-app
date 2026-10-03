import { createHash } from "node:crypto";
import { ObjectTooLargeError, type DocumentStore, type ScanVerdict } from "../document-store.js";
import { errorFields } from "../log.js";
import type { JobDefinition } from "../runner.js";

/**
 * The scan-and-promote pipeline shared by resumes (resume-scan, migration
 * 0036) and paperwork documents (document-scan, migration 0043); design A6.5
 * "Uploads", B6. The worker polls the GuardDuty Malware Protection scan tag of
 * pending uploads (no EventBridge rule or queue: the pending set is small and
 * the tag is the source of truth).
 *
 * State machine (the kind's *_scan_finish definer function), from `pending`:
 *   NO_THREATS_FOUND, size and content match -> clean (copied create-only to
 *                                               the promoted key)
 *   NO_THREATS_FOUND, bytes do not match     -> rejected (BAD_CONTENT,
 *                                               ACTIVE_CONTENT or SIZE_MISMATCH;
 *                                               version deleted)
 *   THREATS_FOUND                            -> infected (version deleted)
 *   UNSUPPORTED, ACCESS_DENIED, FAILED, other -> failed (left in quarantine/,
 *                                               which expires after 2 days)
 *   uploaded, no result within scanTimeoutMs -> failed (TIMEOUT)
 *   nothing uploaded by expiry + uploadGraceMs -> expired (NOT_UPLOADED)
 * Every outcome is audited (ids and codes only).
 */
export interface ScanOptions {
  /** Pending rows examined per tick (at most 100). */
  batchSize: number;
  /** After the presigned POST expires, how long to wait for a slow upload to land. */
  uploadGraceMs: number;
  /** From creation, how long a scan may take before the upload is failed with TIMEOUT. */
  scanTimeoutMs: number;
  /** More object versions than this under one quarantine key logs an alert (replayed presigned POST). */
  maxVersionsPerKey: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  batchSize: 50,
  uploadGraceMs: 10 * 60_000,
  scanTimeoutMs: 60 * 60_000,
  maxVersionsPerKey: 3,
};

export interface PendingUpload { id: string; content_type: string; size_bytes: number; created_at: Date; upload_expires_at: Date }

export type ScanDecision =
  | { kind: "wait" }
  | { kind: "expire" }
  | { kind: "timeout"; versionId: string }
  | { kind: "scanned"; result: string; versionId: string };

/** Pure: what to do with a pending upload given what the store reports. */
export function decideScan(v: ScanVerdict, row: Pick<PendingUpload, "created_at" | "upload_expires_at">, now: Date, o: ScanOptions): ScanDecision {
  if (v.state === "missing") {
    return now.getTime() > row.upload_expires_at.getTime() + o.uploadGraceMs ? { kind: "expire" } : { kind: "wait" };
  }
  if (v.state === "pending") {
    return now.getTime() > row.created_at.getTime() + o.scanTimeoutMs ? { kind: "timeout", versionId: v.versionId } : { kind: "wait" };
  }
  return { kind: "scanned", result: v.result, versionId: v.versionId };
}

/** What differs between kinds of upload; everything else is the shared pipeline. */
export interface ScanKind<Row extends PendingUpload> {
  /** Job name (also the job_run key space). */
  job: string;
  /** Log field holding the row id, and the noun in alert messages ("resume", "document"). */
  idField: string;
  noun: string;
  /** `SELECT * FROM authz.x_scan_queue($1 limit, $2 id)`. */
  queueSql: string;
  /** `SELECT authz.x_scan_finish($1 id, $2 status, $3 result, $4 sha256, $5 size) AS s`. */
  finishSql: string;
  /** Audit row of the outcome (worker, no actor). */
  audit: { action: string; entityType: string };
  maxBytes: number;
  quarantineKey(row: Pick<Row, "id">): string;
  promotedKey(row: Row): string;
  /** KMS key for the promoted object (restricted files); undefined: the bucket default. */
  kmsKeyId?(row: Row): string | undefined;
  /** Type, magic bytes and active content; null when the file may be promoted. */
  inspect(contentType: string, body: Buffer): string | null;
}

type Outcome = { status: "clean" | "infected" | "failed" | "rejected" | "expired"; result: string; sha256?: string; size?: number };

const code = (s: string) => (/^[A-Z_]{1,40}$/.test(s) ? s : "FAILED");

export function scanJob<Row extends PendingUpload>(kind: ScanKind<Row>, store: DocumentStore, opts: ScanOptions): JobDefinition {
  const pending = async (pool: Parameters<JobDefinition["dueKeys"]>[1]["pool"], id: string | null) =>
    (await pool.query<Row>(kind.queueSql, [id ? 1 : opts.batchSize, id])).rows;

  return {
    name: kind.job,
    // Run keys are ids whose outcome is known now; uploads still waiting for
    // the file or the scan are looked at again next tick.
    async dueKeys(now, { pool, log }) {
      const keys: string[] = [];
      for (const row of await pending(pool, null)) {
        try {
          const d = decideScan(await store.verdict(kind.quarantineKey(row)), row, now, opts);
          if (d.kind !== "wait") keys.push(row.id);
        } catch (err) {
          log.warn(`${kind.noun} scan status lookup failed`, { [kind.idField]: row.id, ...errorFields(err) });
        }
      }
      return keys;
    },

    async run(id, { pool, log, signal }) {
      const row = (await pending(pool, id))[0];
      if (!row) return { skipped: "not_pending" };
      const key = kind.quarantineKey(row);
      const verdict = await store.verdict(key, signal);
      const d = decideScan(verdict, row, new Date(), opts);
      if (d.kind === "wait") throw new Error("scan result no longer available; retrying");
      // The presigned POST can be replayed until it expires; many versions under one key means someone is trying.
      if (verdict.state !== "missing" && (verdict.versions ?? 1) > opts.maxVersionsPerKey) {
        log.error("many uploads to one quarantine key", { [kind.idField]: id, versions: verdict.versions, alert: true });
      }

      let outcome: Outcome;
      let deleteVersion: string | null = null;
      if (d.kind === "expire") outcome = { status: "expired", result: "NOT_UPLOADED" };
      else if (d.kind === "timeout") outcome = { status: "failed", result: "TIMEOUT" };
      else if (d.result === "THREATS_FOUND") {
        outcome = { status: "infected", result: "THREATS_FOUND" };
        deleteVersion = d.versionId;
      } else if (d.result !== "NO_THREATS_FOUND") {
        outcome = { status: "failed", result: code(d.result) };
      } else {
        // Clean scan: check the exact scanned version before it becomes available.
        let body: Buffer | null = null;
        try {
          body = await store.read(key, d.versionId, Math.min(row.size_bytes, kind.maxBytes), signal);
        } catch (err) {
          if (!(err instanceof ObjectTooLargeError)) throw err;
        }
        deleteVersion = d.versionId;
        const problem = body && body.length === row.size_bytes ? kind.inspect(row.content_type, body) : "SIZE_MISMATCH";
        if (problem || !body) {
          outcome = { status: "rejected", result: problem ?? "SIZE_MISMATCH" };
        } else {
          const sha = createHash("sha256").update(body).digest();
          signal.throwIfAborted();
          // Create-only: a retry after a failed database update finds the same
          // bytes (checksum compared); different bytes under the key fail the run.
          await store.putClean(kind.promotedKey(row), body, sha, row.content_type, signal, { kmsKeyId: kind.kmsKeyId?.(row) });
          outcome = { status: "clean", result: "NO_THREATS_FOUND", sha256: sha.toString("hex"), size: body.length };
        }
      }

      const c = await pool.connect();
      let recorded: string;
      try {
        await c.query("BEGIN");
        recorded = (await c.query<{ s: string }>(kind.finishSql,
          [id, outcome.status, outcome.result, outcome.sha256 ?? null, outcome.size ?? null])).rows[0]!.s;
        if (recorded !== "not_pending") {
          await c.query(`INSERT INTO eureka.audit_event (action, entity_type, entity_id, changes) VALUES ($1, $2, $3, $4)`,
            [kind.audit.action, kind.audit.entityType, id, { status: outcome.status, result: outcome.result }]);
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
      if (recorded === "not_pending") return { skipped: "not_pending" };

      if (outcome.status === "infected") log.error(`malware found in an uploaded ${kind.noun}`, { [kind.idField]: id, alert: true });
      if (deleteVersion) {
        // Best effort: the quarantine lifecycle rule removes leftovers after 2 days.
        await store.deleteVersion(key, deleteVersion, signal)
          .catch((err) => log.warn("quarantine delete failed", { [kind.idField]: id, ...errorFields(err) }));
      }
      return { status: outcome.status, result: outcome.result };
    },
  };
}
