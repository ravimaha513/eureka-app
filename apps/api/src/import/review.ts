/**
 * Review queue and sign-off. A reviewer resolves rows in review; every
 * decision withdraws an existing approval (database trigger) and the batch
 * is re-analysed. Sign-off is authz.import_approve_batch, run as the
 * approving org admin through the API role.
 */
import type pg from "pg";
import { approvable } from "./analyze.js";
import type { Sheet } from "./mapping.js";
import { recompute, userIdByEmail, withTx } from "./stage.js";
import { reconcile } from "./report.js";

export interface ReviewItem {
  id: string;
  sheet: Sheet;
  rowNo: number;
  state: "review" | "held";
  reasons: string[];
  /** Sales row this row belongs to or is suggested for (matches, name-only suggestions, duplicates). */
  salesRow: number | null;
  approvable: boolean;
  commitError: string | null;
}

/** Rows in review (and on hold), without personal data: reviewers work from the sheet row numbers. */
export async function listReview(pool: pg.Pool, batchId: string): Promise<ReviewItem[]> {
  const rows = (await pool.query<{
    id: string; sheet: Sheet; row_no: number; state: "review" | "held"; reasons: string[]; commit_error: string | null; suggested: number | null;
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

export type ReviewAction =
  | { action: "approve" }
  | { action: "reject" }
  /** This row is the person on that sales row (interviews/placements), or a duplicate of it (sales). */
  | { action: "link"; salesRowNo: number };

export async function decide(
  pool: pg.Pool, batchId: string, sheet: Sheet, rowNo: number, a: ReviewAction, reviewerEmail: string,
): Promise<void> {
  await withTx(pool, async (c) => {
    const reviewer = await userIdByEmail(c, reviewerEmail);
    const row = (await c.query<{ row_key: string; state: string; reasons: string[] }>(
      `SELECT row_key, state, reasons FROM eureka.import_row WHERE batch_id = $1 AND sheet = $2 AND row_no = $3`,
      [batchId, sheet, rowNo])).rows[0];
    if (!row) throw new Error(`No ${sheet} row ${rowNo} in batch ${batchId}`);
    if (row.state === "committed") throw new Error("Row is already loaded");
    let linkKey: string | null = null;
    if (a.action === "approve") {
      if (row.state !== "review" || !row.reasons.some(approvable)) {
        throw new Error(`Nothing a reviewer can approve on this row (${row.reasons.join(", ") || row.state}); fix the sheet or the mapping and stage again`);
      }
    }
    if (a.action === "link") {
      const target = (await c.query<{ row_key: string }>(
        `SELECT row_key FROM eureka.import_row WHERE batch_id = $1 AND sheet = 'sales' AND row_no = $2`,
        [batchId, a.salesRowNo])).rows[0];
      if (!target) throw new Error(`No sales row ${a.salesRowNo} in batch ${batchId}`);
      if (sheet === "sales" && a.salesRowNo === rowNo) throw new Error("A row cannot be linked to itself");
      linkKey = target.row_key;
    }
    await c.query(
      `INSERT INTO eureka.import_decision (sheet, row_key, action, link_row_key, decided_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (sheet, row_key) DO UPDATE SET action = EXCLUDED.action, link_row_key = EXCLUDED.link_row_key,
         decided_by = EXCLUDED.decided_by`,
      [sheet, row.row_key, a.action, linkKey, reviewer]);
  });
  await recompute(pool, batchId);
}

/**
 * Sign-off (design B9 step 4) by an active org admin who did not stage the
 * batch. Runs as eureka_app for that user; the database function checks
 * access:manage and the second-person rule. Audited with counts only.
 */
export async function approveBatch(pool: pg.Pool, batchId: string, approverEmail: string): Promise<void> {
  const totals = await reconcile(pool, batchId);
  const counts = Object.fromEntries(Object.entries(totals.sheets).map(([sheet, t]) => [sheet, {
    in: t.in, clean: t.clean, review: t.review, held: t.held, rejected: t.rejected, skipped: t.skipped, committed: t.committed,
  }]));
  await withTx(pool, async (c) => {
    const approver = await userIdByEmail(c, approverEmail);
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query(`SELECT set_config('eureka.user_id', $1, true)`, [approver]);
    await c.query(`SELECT authz.import_approve_batch($1)`, [batchId]);
    await c.query(
      `INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes) VALUES ($1,'import.batch_approved','import_batch',$2,$3)`,
      [approver, batchId, { counts }]);
  });
}

/** Clears the stored sheet cells of a batch once it is loaded (counts and the ledger stay). */
export async function purgeBatch(pool: pg.Pool, batchId: string): Promise<number> {
  return withTx(pool, async (c) => {
    const b = (await c.query<{ status: string }>(`SELECT status FROM eureka.import_batch WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
    if (!b) throw new Error(`No import batch ${batchId}`);
    if (b.status !== "committed") throw new Error("Only a committed batch can be purged");
    const r = await c.query(`UPDATE eureka.import_row SET raw = NULL, norm = NULL WHERE batch_id = $1`, [batchId]);
    await c.query(`UPDATE eureka.import_batch SET purged_at = now() WHERE id = $1`, [batchId]);
    return r.rowCount ?? 0;
  });
}
