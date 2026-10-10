/**
 * Commit (design B9 step 4). The CLI has no live-table privileges: each
 * person loads through authz.import_load_person (migration 0033), a
 * SECURITY DEFINER function executable only by eureka_import. It refuses a
 * batch that is not approved, whose approval expired or whose rows changed
 * since approval, acts as the row's owner only for its own duration, and runs
 * the same RLS checks, guards, transition functions and audit events as the
 * API. One person per transaction: all or nothing. Without --commit the
 * function does the same work and always rolls back (dry run).
 */
import type pg from "pg";
import type { Sheet } from "./mapping.js";

export interface CommitResult {
  batchId: string;
  dryRun: boolean;
  loaded: { candidates: number; submissions: number; interviews: number; placements: number; updated: number };
  /** Each failed person: its rows ("sales 3", "interviews 7") and the database error. */
  failures: { rows: string[]; error: string }[];
  /** Clean rows not loaded because a review decision is newer than the approval or not yet analysed. */
  skippedByDecision: number;
  remainingClean: number;
}

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string; detail?: string };
  return `${e.code ? `${e.code} ` : ""}${e.message ?? String(err)}${e.detail && e.message !== "import_dry_run" ? ` (${e.detail})` : ""}`
    .replace(/\s+/g, " ").slice(0, 200);
}

export async function commitBatch(pool: pg.Pool, batchId: string, opts: { dryRun: boolean }): Promise<CommitResult> {
  const b = (await pool.query<{ status: string; purged_at: string | null }>(
    `SELECT status, purged_at FROM eureka.import_batch WHERE id = $1`, [batchId])).rows[0];
  if (!b) throw new Error(`No import batch ${batchId}`);
  if (b.purged_at) throw new Error("Batch data was purged");
  if (!opts.dryRun && b.status !== "approved") {
    throw new Error(`Batch is ${b.status}: it must be approved (an org admin who did not stage it, POST /api/v1/imports/${batchId}/approve) before --commit`);
  }
  const rows = (await pool.query<{ id: string; sheet: Sheet; row_no: number; row_key: string; person_key: string | null }>(
    `SELECT id, sheet, row_no, row_key, person_key FROM eureka.import_row
     WHERE batch_id = $1 AND state = 'clean' ORDER BY array_position(ARRAY['sales','submissions','interviews','placements'], sheet), row_no`,
    [batchId])).rows;
  // One call per person: the clean sales row, or the first row of new activity for an earlier-imported person.
  const people = new Map<string, { anchor: string; rows: typeof rows }>();
  for (const r of rows) {
    const key = r.sheet === "sales" ? r.row_key : r.person_key;
    if (!key) continue;
    const p = people.get(key) ?? { anchor: "", rows: [] };
    if (r.sheet === "sales" || (!p.anchor && key.startsWith("ledger:"))) p.anchor = r.id;
    p.rows.push(r);
    people.set(key, p);
  }

  const result: CommitResult = {
    batchId, dryRun: opts.dryRun, loaded: { candidates: 0, submissions: 0, interviews: 0, placements: 0, updated: 0 },
    failures: [], skippedByDecision: 0, remainingClean: 0,
  };
  for (const p of people.values()) {
    if (!p.anchor) continue;
    const c = await pool.connect();
    let out: { counts: CommitResult["loaded"]; skipped: string[] } | null = null;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '60s'");
      try {
        out = (await c.query<{ r: typeof out }>(`SELECT authz.import_load_person($1, $2, $3) AS r`, [batchId, p.anchor, opts.dryRun])).rows[0]!.r;
        await c.query(opts.dryRun ? "ROLLBACK" : "COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        const e = err as { message?: string; detail?: string };
        if (e.message !== "import_dry_run" || !e.detail) throw err;
        out = JSON.parse(e.detail);
      }
    } catch (err) {
      const error = errorText(err);
      result.failures.push({ rows: p.rows.map((r) => `${r.sheet} ${r.row_no}`), error });
      if (!opts.dryRun) {
        await pool.query(`UPDATE eureka.import_row SET commit_error = $2 WHERE id = ANY($1::uuid[]) AND state = 'clean'`,
          [p.rows.map((r) => r.id), error]);
      }
    } finally {
      c.release();
    }
    if (out) {
      for (const k of Object.keys(result.loaded) as (keyof CommitResult["loaded"])[]) result.loaded[k] += out.counts[k] ?? 0;
      result.skippedByDecision += out.skipped.length;
    }
  }
  if (!opts.dryRun) await pool.query(`SELECT authz.import_finish_batch($1)`, [batchId]);
  result.remainingClean = (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM eureka.import_row WHERE batch_id = $1 AND state = 'clean'`, [batchId])).rows[0]!.n;
  return result;
}
