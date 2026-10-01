/**
 * Staging and analysis (design B9 steps 1-3). Runs as eureka_import and
 * writes only import_* rows of a batch that is still staged: nothing here
 * touches live tables. A new batch needs a one-time ticket created by a
 * signed-in org admin (POST /api/v1/imports/tickets); that admin is the
 * batch's operator. Staging the same files and mapping again re-analyses the
 * open batch.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type pg from "pg";
import { parseCsv } from "./csv.js";
import { parseMapping, SHEETS, type MappingConfig, type Sheet } from "./mapping.js";
import {
  normalizeRow, redactCells, resolveBatch, rowKeyOf, sha256, todayIso, type Decision, type Hmac, type Ledger,
  type RawRow, type Refs, type StagedRow,
} from "./analyze.js";

/** Columns each sheet must have (the rest are optional). */
const REQUIRED: Record<Sheet, string[]> = {
  sales: ["technology", "location", "owner", "status"],
  interviews: ["client", "jobTitle", "date", "startTime", "callStatus"],
  placements: ["client", "jobTitle", "placementType", "workMode", "tentativeStart", "status"],
};

export interface StageFiles { sales?: string; interviews?: string; placements?: string }

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function loadRefs(c: pg.PoolClient): Promise<Refs> {
  const map = async (table: string) => new Map(
    (await c.query<{ id: string; name: string }>(`SELECT id, name FROM eureka.${table}`)).rows
      .map((r) => [r.name.trim().toLowerCase(), r.id] as const));
  const users = new Map((await c.query<{ id: string; email: string; status: string }>(
    `SELECT id, email::text AS email, status FROM eureka.app_user`)).rows
    .map((u) => [u.email.toLowerCase(), { id: u.id, active: u.status === "active" }] as const));
  return {
    technologies: await map("technology"), locations: await map("location"), clients: await map("client"),
    vendors: await map("vendor"), partners: await map("implementation_partner"), users,
  };
}

async function loadLedger(c: pg.PoolClient): Promise<Ledger> {
  const links = new Map((await c.query<{ k: string; entity_id: string }>(
    `SELECT sheet || ':' || row_key AS k, entity_id FROM eureka.import_link`)).rows.map((r) => [r.k, r.entity_id] as const));
  const identities = new Map((await c.query<{ identity_hash: string; candidate_id: string; owner_id: string }>(
    `SELECT identity_hash, candidate_id, owner_id FROM eureka.import_identity`)).rows
    .map((r) => [r.identity_hash, { candidateId: r.candidate_id, ownerId: r.owner_id }] as const));
  return { links, identities };
}

async function loadDecisions(c: pg.PoolClient): Promise<Map<string, Decision>> {
  return new Map((await c.query<{ sheet: string; row_key: string; action: Decision["action"]; link_row_key: string | null; approved_reasons: string[] | null }>(
    `SELECT sheet, row_key, action, link_row_key, approved_reasons FROM eureka.import_decision`)).rows
    .map((d) => [`${d.sheet}:${d.row_key}`, { action: d.action, linkRowKey: d.link_row_key, approvedReasons: d.approved_reasons }] as const));
}

const toRecord = (r: StagedRow) => ({
  sheet: r.sheet, row_no: r.rowNo, row_key: r.rowKey, raw: r.raw, norm: r.norm, status_key: r.statusKey,
  person_key: r.personKey, state: r.state, reasons: r.reasons,
});

export interface StageResult { batchId: string; created: boolean }

/**
 * Stages CSV exports. An open batch with the same files and mapping is
 * re-analysed; otherwise `ticket` (from the API) opens a new batch.
 */
export async function stage(
  pool: pg.Pool, files: StageFiles, mappingText: string, opts: { ticket?: string; hmac: Hmac },
): Promise<StageResult> {
  const cfg = parseMapping(JSON.parse(mappingText));
  const given = SHEETS.filter((s) => files[s]);
  if (given.length === 0) throw new Error("Give at least one of --sales, --interviews, --placements");
  const texts = Object.fromEntries(given.map((s) => [s, readFileSync(files[s]!, "utf8")])) as Partial<Record<Sheet, string>>;
  const raws: RawRow[] = [];
  const meta: Record<string, unknown> = {};
  const today = todayIso();
  for (const sheet of SHEETS) {
    const text = texts[sheet];
    if (text === undefined) continue;
    const table = parseCsv(text);
    const cols = cfg.sheets[sheet].columns as Record<string, string | undefined>;
    const present = new Set(table.headers.map((h) => h.toLowerCase()));
    const nameCols = cols.fullName && present.has(cols.fullName.toLowerCase()) ? [] : ["firstName", "lastName"];
    const missing = [...REQUIRED[sheet], ...nameCols].map((f) => cols[f]).filter((h): h is string => !!h && !present.has(h.toLowerCase()));
    if (missing.length) throw new Error(`${sheet}: missing column(s) ${missing.map((m) => `"${m}"`).join(", ")} (see the mapping file)`);
    const mapped = new Set(Object.values(cols).filter((h): h is string => !!h).map((h) => h.toLowerCase()));
    meta[sheet] = {
      file: basename(files[sheet]!), sha256: sha256(text), rows: table.rows.length,
      unmappedColumns: table.headers.filter((h) => h && !mapped.has(h.toLowerCase())),
    };
    for (const row of table.rows) {
      // The row key comes from the cells as exported; the stored cells carry
      // a DOB token instead of the date (only its keyed hash is kept).
      const rowKey = rowKeyOf(sheet, row.cells, opts.hmac);
      const raw: RawRow = { sheet, rowNo: row.line, cells: row.cells, rowKey };
      raws.push({ ...raw, cells: redactCells(raw, cfg, opts.hmac, today) });
    }
  }
  const digest = sha256(JSON.stringify({ files: Object.fromEntries(given.map((s) => [s, sha256(texts[s]!)])), mapping: sha256(mappingText) }));

  return withTx(pool, async (c) => {
    const open = (await c.query<{ id: string }>(
      `SELECT id FROM eureka.import_batch WHERE source_digest = $1 AND status <> 'committed'`, [digest])).rows[0];
    if (open) {
      await recomputeIn(c, open.id, opts.hmac);
      return { batchId: open.id, created: false };
    }
    if (!opts.ticket) throw new Error("A new batch needs --ticket (POST /api/v1/imports/tickets as an org admin)");
    const batchId = (await c.query<{ id: string }>(`SELECT authz.import_open_batch($1, $2, $3) AS id`,
      [opts.ticket, digest, { ...meta, mapping: JSON.parse(mappingText) }])).rows[0]!.id;
    const refs = await loadRefs(c);
    const first = raws.map((r) => normalizeRow(r, cfg, refs, opts.hmac, today));
    await c.query(
      `INSERT INTO eureka.import_row (batch_id, sheet, row_no, row_key, raw, norm, status_key, person_key, state, reasons)
       SELECT $1, x.sheet, x.row_no, x.row_key, x.raw, x.norm, x.status_key, NULL, 'review', x.reasons
       FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, row_no int, row_key text, raw jsonb, norm jsonb,
         status_key text, reasons text[])`,
      [batchId, JSON.stringify(first.map((r) => ({
        sheet: r.sheet, row_no: r.rowNo, row_key: r.rowKey, raw: r.raw, norm: r.norm, status_key: r.statusKey, reasons: r.reasons,
      })))]);
    await recomputeIn(c, batchId, opts.hmac);
    return { batchId, created: true };
  });
}

/**
 * Re-analyses a staged batch from its stored cells and mapping (after review
 * decisions or new reference data), in one transaction with the batch row
 * locked. Committed rows are never touched; an approved or committed batch is
 * left as signed off.
 */
export async function recompute(pool: pg.Pool, batchId: string, hmac: Hmac): Promise<void> {
  await withTx(pool, (c) => recomputeIn(c, batchId, hmac));
}

async function recomputeIn(c: pg.PoolClient, batchId: string, hmac: Hmac): Promise<void> {
  const b = (await c.query<{ status: string; files: { mapping: unknown }; purged_at: string | null }>(
    `SELECT status, files, purged_at FROM eureka.import_batch WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
  if (!b) throw new Error(`No import batch ${batchId}`);
  if (b.status !== "staged") return;
  if (b.purged_at) throw new Error("Batch data was purged; stage the files again");
  const cfg = parseMapping(b.files.mapping);
  const rows = (await c.query<{ id: string; sheet: Sheet; row_no: number; row_key: string; raw: Record<string, string>; state: string }>(
    `SELECT id, sheet, row_no, row_key, raw, state FROM eureka.import_row WHERE batch_id = $1
     ORDER BY array_position(ARRAY['sales','interviews','placements'], sheet), row_no`, [batchId])).rows;
  const refs = await loadRefs(c);
  const normalized = rows.map((r) => normalizeRow({ sheet: r.sheet, rowNo: r.row_no, cells: r.raw, rowKey: r.row_key }, cfg, refs, hmac));
  // Live duplicates: the database reads the stored row itself (yes/no answer).
  const live = new Set<string>();
  for (const r of rows) {
    if (r.sheet !== "sales") continue;
    if ((await c.query<{ m: boolean }>(`SELECT authz.import_live_match($1) AS m`, [r.id])).rows[0]?.m) live.add(r.row_key);
  }
  const staged = resolveBatch({
    rows: normalized, ledger: await loadLedger(c), decisions: await loadDecisions(c), liveMatches: live,
    placementsCommit: cfg.placements.commit, hmac,
  });
  const committed = new Set(rows.filter((r) => r.state === "committed").map((r) => `${r.sheet}:${r.row_no}`));
  const changes = staged.filter((s) => !committed.has(`${s.sheet}:${s.rowNo}`));
  await c.query(
    `UPDATE eureka.import_row r SET norm = x.norm, status_key = x.status_key, person_key = x.person_key,
       state = x.state, reasons = x.reasons, commit_error = NULL
     FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, row_no int, norm jsonb, status_key text, person_key text,
       state text, reasons text[])
     WHERE r.batch_id = $1 AND r.sheet = x.sheet AND r.row_no = x.row_no AND r.state <> 'committed'`,
    [batchId, JSON.stringify(changes.map(toRecord))]);
  await c.query(`UPDATE eureka.import_batch SET analysed_at = now() WHERE id = $1`, [batchId]);
}
