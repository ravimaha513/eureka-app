/**
 * Review queue (read side) and purge for the CLI. Decisions and sign-off are
 * authenticated API calls (apps/api/src/modules/imports): the CLI cannot
 * record who reviewed or approved anything.
 */
import type pg from "pg";
import { approvable } from "./analyze.js";
import type { Sheet } from "./mapping.js";
import { withTx } from "./stage.js";

export interface ReviewItem {
  id: string;
  sheet: Sheet;
  rowNo: number;
  state: "review" | "held" | "clean";
  reasons: string[];
  /** Sales row this row belongs to or is suggested for (matches, name-only suggestions, duplicates). */
  salesRow: number | null;
  approvable: boolean;
  commitError: string | null;
}

/** Rows in review (and on hold), without personal data: reviewers work from the sheet row numbers. */
export async function listReview(pool: pg.Pool, batchId: string): Promise<ReviewItem[]> {
  const rows = (await pool.query<{
    id: string; sheet: Sheet; row_no: number; state: ReviewItem["state"]; reasons: string[]; commit_error: string | null; suggested: number | null;
  }>(
    `SELECT r.id, r.sheet, r.row_no, r.state, r.reasons, r.commit_error,
            (SELECT s.row_no FROM eureka.import_row s WHERE s.batch_id = r.batch_id AND s.sheet = 'sales'
               AND s.row_key = r.person_key AND s.id <> r.id ORDER BY s.row_no LIMIT 1) AS suggested
     FROM eureka.import_row r
     WHERE r.batch_id = $1 AND (r.state IN ('review', 'held') OR r.commit_error IS NOT NULL)
     ORDER BY array_position(ARRAY['sales','interviews','placements'], r.sheet), r.row_no`, [batchId])).rows;
  return rows.map((r) => ({
    id: r.id, sheet: r.sheet, rowNo: r.row_no, state: r.state, reasons: r.reasons, salesRow: r.suggested,
    approvable: r.state === "review" && r.reasons.length > 0 && r.reasons.every(approvable), commitError: r.commit_error,
  }));
}

/** Clears the stored cells of one batch, whatever its status (counts and the ledger stay). */
export async function purgeBatch(pool: pg.Pool, batchId: string): Promise<number> {
  return withTx(pool, async (c) => {
    const b = (await c.query<{ purged_at: string | null }>(`SELECT purged_at FROM eureka.import_batch WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
    if (!b) throw new Error(`No import batch ${batchId}`);
    const r = await c.query(`UPDATE eureka.import_row SET raw = NULL, norm = NULL WHERE batch_id = $1 AND (raw IS NOT NULL OR norm IS NOT NULL)`, [batchId]);
    if (!b.purged_at) await c.query(`UPDATE eureka.import_batch SET purged_at = now() WHERE id = $1`, [batchId]);
    return r.rowCount ?? 0;
  });
}

/** Purges every batch older than import_config.purge_days (run on a schedule during the migration). */
export async function purgeExpired(pool: pg.Pool): Promise<{ batches: number; rows: number }> {
  const ids = (await pool.query<{ id: string }>(
    `SELECT b.id FROM eureka.import_batch b, eureka.import_config c
     WHERE b.purged_at IS NULL AND b.created_at < now() - make_interval(days => c.purge_days)`)).rows.map((r) => r.id);
  let rows = 0;
  for (const id of ids) rows += await purgeBatch(pool, id);
  return { batches: ids.length, rows };
}
