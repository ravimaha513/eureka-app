import { createHash } from "node:crypto";
import { RESUME_MAX_BYTES, isResumeContentType } from "@eureka/shared";
import { contentMatches, resumeCleanKey, resumeQuarantineKey } from "../../platform/storage/content.js";
import { ObjectTooLargeError, type DocumentStore, type ScanVerdict } from "../document-store.js";
import { errorFields } from "../log.js";
import type { JobDefinition } from "../runner.js";

/**
 * resume-scan (design A6.5 "Uploads", B6): promotes uploaded resumes once
 * GuardDuty Malware Protection for S3 has tagged them. The worker polls the
 * scan tag of pending uploads (no EventBridge rule or queue to run: the
 * pending set is small and the tag is the source of truth).
 *
 * State machine (authz.resume_scan_finish, migration 0036), from `pending`:
 *   NO_THREATS_FOUND, size and magic bytes match -> clean (copied to clean/,
 *                                                   next version, current)
 *   NO_THREATS_FOUND, bytes do not match         -> rejected (BAD_CONTENT or
 *                                                   SIZE_MISMATCH; version deleted)
 *   THREATS_FOUND                                -> infected (version deleted)
 *   UNSUPPORTED, ACCESS_DENIED, FAILED, other    -> failed (left in quarantine/,
 *                                                   which expires after 2 days)
 *   uploaded, no result within scanTimeoutMs     -> failed (TIMEOUT)
 *   nothing uploaded by expiry + uploadGraceMs   -> expired (NOT_UPLOADED)
 * Every outcome is audited as resume.scanned (ids and codes only).
 */
export interface ResumeScanOptions {
  /** Pending rows examined per tick (at most 100). */
  batchSize: number;
  /** After the presigned POST expires, how long to wait for a slow upload to land. */
  uploadGraceMs: number;
  /** From creation, how long a scan may take before the upload is failed with TIMEOUT. */
  scanTimeoutMs: number;
}

export const DEFAULT_RESUME_SCAN_OPTIONS: ResumeScanOptions = {
  batchSize: 50,
  uploadGraceMs: 10 * 60_000,
  scanTimeoutMs: 60 * 60_000,
};

interface PendingRow { id: string; content_type: string; size_bytes: number; created_at: Date; upload_expires_at: Date }

export type ScanDecision =
  | { kind: "wait" }
  | { kind: "expire" }
  | { kind: "timeout"; versionId: string }
  | { kind: "scanned"; result: string; versionId: string };

/** Pure: what to do with a pending upload given what the store reports. */
export function decideScan(v: ScanVerdict, row: Pick<PendingRow, "created_at" | "upload_expires_at">, now: Date, o: ResumeScanOptions): ScanDecision {
  if (v.state === "missing") {
    return now.getTime() > row.upload_expires_at.getTime() + o.uploadGraceMs ? { kind: "expire" } : { kind: "wait" };
  }
  if (v.state === "pending") {
    return now.getTime() > row.created_at.getTime() + o.scanTimeoutMs ? { kind: "timeout", versionId: v.versionId } : { kind: "wait" };
  }
  return { kind: "scanned", result: v.result, versionId: v.versionId };
}

type Outcome = { status: "clean" | "infected" | "failed" | "rejected" | "expired"; result: string; sha256?: string; size?: number };

const code = (s: string) => (/^[A-Z_]{1,40}$/.test(s) ? s : "FAILED");

export function resumeScanJob(store: DocumentStore, opts: ResumeScanOptions = DEFAULT_RESUME_SCAN_OPTIONS): JobDefinition {
  const pending = async (pool: Parameters<JobDefinition["dueKeys"]>[1]["pool"], id: string | null) =>
    (await pool.query<PendingRow>(`SELECT * FROM authz.resume_scan_queue($1, $2)`, [id ? 1 : opts.batchSize, id])).rows;

  return {
    name: "resume-scan",
    // Run keys are resume ids whose outcome is known now; uploads still waiting
    // for the file or the scan are looked at again next tick.
    async dueKeys(now, { pool, log }) {
      const keys: string[] = [];
      for (const row of await pending(pool, null)) {
        try {
          const d = decideScan(await store.verdict(resumeQuarantineKey(row.id)), row, now, opts);
          if (d.kind !== "wait") keys.push(row.id);
        } catch (err) {
          log.warn("resume scan status lookup failed", { resumeId: row.id, ...errorFields(err) });
        }
      }
      return keys;
    },

    async run(id, { pool, log, signal }) {
      const row = (await pending(pool, id))[0];
      if (!row) return { skipped: "not_pending" };
      const key = resumeQuarantineKey(id);
      const d = decideScan(await store.verdict(key, signal), row, new Date(), opts);
      if (d.kind === "wait") throw new Error("scan result no longer available; retrying");

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
          body = await store.read(key, d.versionId, Math.min(row.size_bytes, RESUME_MAX_BYTES), signal);
        } catch (err) {
          if (!(err instanceof ObjectTooLargeError)) throw err;
        }
        deleteVersion = d.versionId;
        if (!body || body.length !== row.size_bytes) {
          outcome = { status: "rejected", result: "SIZE_MISMATCH" };
        } else if (!isResumeContentType(row.content_type) || !contentMatches(body, row.content_type)) {
          outcome = { status: "rejected", result: "BAD_CONTENT" };
        } else {
          const sha = createHash("sha256").update(body).digest();
          signal.throwIfAborted();
          // Idempotent: a retry after a failed database update rewrites the same bytes.
          await store.putClean(resumeCleanKey(id), body, sha, row.content_type, signal);
          outcome = { status: "clean", result: "NO_THREATS_FOUND", sha256: sha.toString("hex"), size: body.length };
        }
      }

      const c = await pool.connect();
      let recorded: string;
      try {
        await c.query("BEGIN");
        recorded = (await c.query<{ s: string }>(`SELECT authz.resume_scan_finish($1, $2, $3, $4, $5) AS s`,
          [id, outcome.status, outcome.result, outcome.sha256 ?? null, outcome.size ?? null])).rows[0]!.s;
        if (recorded !== "not_pending") {
          await c.query(`INSERT INTO eureka.audit_event (action, entity_type, entity_id, changes) VALUES ('resume.scanned', 'resume', $1, $2)`,
            [id, { status: outcome.status, result: outcome.result }]);
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
      if (recorded === "not_pending") return { skipped: "not_pending" };

      if (outcome.status === "infected") log.error("malware found in an uploaded resume", { resumeId: id, alert: true });
      if (deleteVersion) {
        // Best effort: the quarantine lifecycle rule removes leftovers after 2 days.
        await store.deleteVersion(key, deleteVersion, signal)
          .catch((err) => log.warn("quarantine delete failed", { resumeId: id, ...errorFields(err) }));
      }
      return { status: outcome.status, result: outcome.result };
    },
  };
}
