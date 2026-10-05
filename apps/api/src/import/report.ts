/**
 * Reconciliation report (design B9 step 4): rows in and out per sheet and per
 * status label as typed in the sheet, with review, hold, rejection and skip
 * reasons. Every row lands in exactly one state, so for each sheet
 * in = clean + held + review + rejected + skipped + committed.
 */
import type pg from "pg";
import { SHEETS, type Sheet } from "./mapping.js";
import type { CommitResult } from "./commit.js";

const STATES = ["clean", "held", "review", "rejected", "skipped", "committed"] as const;
type State = (typeof STATES)[number];

export interface SheetTotals extends Record<State, number> {
  in: number;
  reasons: Record<"review" | "held" | "rejected" | "skipped", Record<string, number>>;
  /** status label as typed -> rows in, rows loaded or loadable, rows loaded */
  byStatus: Record<string, { in: number; loadable: number; committed: number }>;
  commitErrors: number;
}

export interface Reconciliation {
  batchId: string;
  status: string;
  operator: string;
  /** Batch settings fixed at stage (C1a.3). */
  source: string;
  historical: boolean;
  approvedBy: string | null;
  files: Record<string, unknown>;
  sheets: Record<Sheet, SheetTotals>;
  balanced: boolean;
}

const emptyTotals = (): SheetTotals => ({
  in: 0, clean: 0, held: 0, review: 0, rejected: 0, skipped: 0, committed: 0,
  reasons: { review: {}, held: {}, rejected: {}, skipped: {} }, byStatus: {}, commitErrors: 0,
});

export async function reconcile(pool: pg.Pool | pg.PoolClient, batchId: string): Promise<Reconciliation> {
  const b = (await pool.query<{
    status: string; files: Record<string, unknown>; operator: string; approver: string | null; source: string; historical: boolean;
  }>(
    `SELECT b.status, b.files, b.source, b.historical, o.email::text AS operator, a.email::text AS approver
     FROM eureka.import_batch b JOIN eureka.app_user o ON o.id = b.operator_id
     LEFT JOIN eureka.app_user a ON a.id = b.approved_by WHERE b.id = $1`, [batchId])).rows[0];
  if (!b) throw new Error(`No import batch ${batchId}`);
  const rows = (await pool.query<{ sheet: Sheet; state: State; reasons: string[]; status_key: string | null; commit_error: string | null }>(
    `SELECT sheet, state, reasons, status_key, commit_error FROM eureka.import_row WHERE batch_id = $1`, [batchId])).rows;
  const sheets = Object.fromEntries(SHEETS.map((s) => [s, emptyTotals()])) as Record<Sheet, SheetTotals>;
  for (const r of rows) {
    const t = sheets[r.sheet];
    t.in++;
    t[r.state]++;
    if (r.state !== "clean" && r.state !== "committed") {
      for (const reason of r.reasons) t.reasons[r.state][reason] = (t.reasons[r.state][reason] ?? 0) + 1;
    }
    const k = r.status_key ?? "(blank)";
    const st = (t.byStatus[k] ??= { in: 0, loadable: 0, committed: 0 });
    st.in++;
    if (r.state === "clean" || r.state === "committed") st.loadable++;
    if (r.state === "committed") st.committed++;
    if (r.commit_error) t.commitErrors++;
  }
  const { mapping: _m, ...files } = b.files;
  const balanced = SHEETS.every((s) => {
    const t = sheets[s];
    const meta = files[s] as { rows?: number } | undefined;
    return t.in === STATES.reduce((a, st) => a + t[st], 0) && (meta === undefined || meta.rows === t.in);
  });
  return {
    batchId, status: b.status, operator: b.operator, source: b.source, historical: b.historical, approvedBy: b.approver,
    files, sheets, balanced,
  };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

export function formatReport(r: Reconciliation, commit?: CommitResult): string {
  const lines: string[] = [];
  lines.push(`Import batch ${r.batchId}  status: ${r.status}  staged by: ${r.operator}  approved by: ${r.approvedBy ?? "-"}`);
  lines.push(`source: ${r.source}  historical: ${r.historical ? "yes" : "no"}`);
  lines.push("");
  lines.push(`${"sheet".padEnd(12)}${pad("in", 6)}${pad("clean", 7)}${pad("held", 6)}${pad("review", 8)}${pad("rejected", 10)}${pad("skipped", 9)}${pad("loaded", 8)}`);
  for (const s of SHEETS) {
    const t = r.sheets[s];
    if (t.in === 0 && r.files[s] === undefined) continue;
    lines.push(`${s.padEnd(12)}${pad(t.in, 6)}${pad(t.clean, 7)}${pad(t.held, 6)}${pad(t.review, 8)}${pad(t.rejected, 10)}${pad(t.skipped, 9)}${pad(t.committed, 8)}`);
  }
  lines.push(`Totals balance (in = clean + held + review + rejected + skipped + loaded, and match the file row counts): ${r.balanced ? "yes" : "NO"}`);
  for (const s of SHEETS) {
    const t = r.sheets[s];
    if (t.in === 0) continue;
    lines.push("");
    lines.push(`${s}: per status (as typed in the sheet)    in  loadable  loaded`);
    for (const [k, v] of Object.entries(t.byStatus).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${k.padEnd(36)}${pad(v.in, 4)}${pad(v.loadable, 10)}${pad(v.committed, 8)}`);
    }
    for (const kind of ["review", "held", "rejected", "skipped"] as const) {
      const entries = Object.entries(t.reasons[kind]);
      if (!entries.length) continue;
      lines.push(`  ${kind} reasons: ${entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    if (t.commitErrors) lines.push(`  rows with a commit error: ${t.commitErrors} (see "review")`);
  }
  if (commit) {
    lines.push("");
    lines.push(`${commit.dryRun ? "Dry run (rolled back): would load" : "Loaded"}: ${commit.loaded.candidates} candidates, `
      + `${commit.loaded.submissions} submissions, ${commit.loaded.interviews} interviews, ${commit.loaded.placements} placements`
      + `; ${commit.loaded.updated} earlier imports matched by natural key`);
    if (commit.skippedByDecision) lines.push(`  not loaded: ${commit.skippedByDecision} rows with a review decision newer than the approval`);
    for (const f of commit.failures) lines.push(`  failed: ${f.rows.join(", ")}: ${f.error}`);
    if (commit.dryRun) lines.push("Nothing was written. Approve the batch, then run commit with --commit to load.");
  }
  return lines.join("\n");
}
