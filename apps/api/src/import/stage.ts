/**
 * Staging (design B9 steps 1-3). Runs entirely as eureka_import and writes
 * only the import_* tables: nothing here touches live tables, so staging is
 * the dry run. Re-staging the same files and mapping reuses the batch.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type pg from "pg";
import { parseCsv } from "./csv.js";
import { parseMapping, SHEETS, type MappingConfig, type Sheet } from "./mapping.js";
import {
  normalizeRow, resolveBatch, sha256, type Decision, type Ledger, type NormalizedRow, type RawRow, type Refs,
  type StagedRow,
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

export async function userIdByEmail(c: pg.PoolClient | pg.Pool, email: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM eureka.app_user WHERE lower(email::text) = lower($1) AND status = 'active'`, [email.trim()]);
  if (!r.rows[0]) throw new Error(`No active Eureka user with email ${email}`);
  return r.rows[0].id;
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
  return new Map((await c.query<{ sheet: string; row_key: string; action: Decision["action"]; link_row_key: string | null }>(
    `SELECT sheet, row_key, action, link_row_key FROM eureka.import_decision`)).rows
    .map((d) => [`${d.sheet}:${d.row_key}`, { action: d.action, linkRowKey: d.link_row_key }] as const));
}

/** Sales rows whose email or phone already belongs to a live candidate not created by an import. */
async function liveMatches(c: pg.PoolClient, rows: NormalizedRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.sheet !== "sales") continue;
    const probes: [string | null, string | null][] = [
      ...r.identity.emails.map((e) => [e, null] as [string, null]),
      ...(r.identity.phone ? [[null, r.identity.phone] as [null, string]] : []),
    ];
    for (const [email, phone] of probes) {
      const q = await c.query<{ m: boolean }>(`SELECT authz.import_live_match($1, $2) AS m`, [email, phone]);
      if (q.rows[0]?.m) { out.add(r.rowKey); break; }
    }
  }
  return out;
}

async function analyse(c: pg.PoolClient, raws: RawRow[], cfg: MappingConfig): Promise<StagedRow[]> {
  const refs = await loadRefs(c);
  const normalized = raws.map((r) => normalizeRow(r, cfg, refs));
  return resolveBatch({
    rows: normalized,
    ledger: await loadLedger(c),
    decisions: await loadDecisions(c),
    liveMatches: await liveMatches(c, normalized),
    placementsCommit: cfg.placements.commit,
  });
}

const toRecord = (r: StagedRow) => ({
  sheet: r.sheet, row_no: r.rowNo, row_key: r.rowKey, raw: r.raw, norm: r.norm, status_key: r.statusKey,
  person_key: r.personKey, state: r.state, reasons: r.reasons,
});

export interface StageResult { batchId: string; created: boolean }

/** Stages CSV exports. Same files + same mapping -> same batch (re-analysed with the latest decisions). */
export async function stage(pool: pg.Pool, files: StageFiles, mappingText: string, operatorEmail: string): Promise<StageResult> {
  const cfg = parseMapping(JSON.parse(mappingText));
  const given = SHEETS.filter((s) => files[s]);
  if (given.length === 0) throw new Error("Give at least one of --sales, --interviews, --placements");
  const texts = Object.fromEntries(given.map((s) => [s, readFileSync(files[s]!, "utf8")])) as Partial<Record<Sheet, string>>;
  const raws: RawRow[] = [];
  const meta: Record<string, unknown> = {};
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
    for (const row of table.rows) raws.push({ sheet, rowNo: row.line, cells: row.cells });
  }
  const digest = sha256(JSON.stringify({ files: Object.fromEntries(given.map((s) => [s, sha256(texts[s]!)])), mapping: sha256(mappingText) }));

  return withTx(pool, async (c) => {
    const operatorId = await userIdByEmail(c, operatorEmail);
    const ins = await c.query<{ id: string }>(
      `INSERT INTO eureka.import_batch (source_digest, files, operator_id) VALUES ($1, $2, $3)
       ON CONFLICT (source_digest) DO NOTHING RETURNING id`,
      [digest, { ...meta, mapping: JSON.parse(mappingText) }, operatorId]);
    if (!ins.rows[0]) {
      const existing = (await c.query<{ id: string }>(`SELECT id FROM eureka.import_batch WHERE source_digest = $1`, [digest])).rows[0]!;
      await recomputeIn(c, existing.id);
      return { batchId: existing.id, created: false };
    }
    const batchId = ins.rows[0].id;
    const staged = await analyse(c, raws, cfg);
    await c.query(
      `INSERT INTO eureka.import_row (batch_id, sheet, row_no, row_key, raw, norm, status_key, person_key, state, reasons)
       SELECT $1, x.sheet, x.row_no, x.row_key, x.raw, x.norm, x.status_key, x.person_key, x.state, x.reasons
       FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, row_no int, row_key text, raw jsonb, norm jsonb,
         status_key text, person_key text, state text, reasons text[])`,
      [batchId, JSON.stringify(staged.map(toRecord))]);
    return { batchId, created: true };
  });
}

/**
 * Re-analyses a staged batch from its stored cells and mapping (after review
 * decisions or new reference data). Committed rows are never touched; a batch
 * that is approved or committed is left as signed off.
 */
export async function recompute(pool: pg.Pool, batchId: string): Promise<void> {
  await withTx(pool, (c) => recomputeIn(c, batchId));
}

async function recomputeIn(c: pg.PoolClient, batchId: string): Promise<void> {
  const b = (await c.query<{ status: string; files: { mapping: unknown }; purged_at: string | null }>(
    `SELECT status, files, purged_at FROM eureka.import_batch WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
  if (!b) throw new Error(`No import batch ${batchId}`);
  if (b.status !== "staged") return;
  if (b.purged_at) throw new Error("Batch data was purged; stage the files again");
  const cfg = parseMapping(b.files.mapping);
  const rows = (await c.query<{ sheet: Sheet; row_no: number; raw: Record<string, string>; state: string }>(
    `SELECT sheet, row_no, raw, state FROM eureka.import_row WHERE batch_id = $1
     ORDER BY array_position(ARRAY['sales','interviews','placements'], sheet), row_no`, [batchId])).rows;
  const staged = await analyse(c, rows.map((r) => ({ sheet: r.sheet, rowNo: r.row_no, cells: r.raw })), cfg);
  const committed = new Set(rows.filter((r) => r.state === "committed").map((r) => `${r.sheet}:${r.row_no}`));
  const changes = staged.filter((s) => !committed.has(`${s.sheet}:${s.rowNo}`));
  await c.query(
    `UPDATE eureka.import_row r SET norm = x.norm, status_key = x.status_key, person_key = x.person_key,
       state = x.state, reasons = x.reasons, commit_error = NULL
     FROM jsonb_to_recordset($2::jsonb) AS x(sheet text, row_no int, norm jsonb, status_key text, person_key text,
       state text, reasons text[])
     WHERE r.batch_id = $1 AND r.sheet = x.sheet AND r.row_no = x.row_no AND r.state <> 'committed'`,
    [batchId, JSON.stringify(changes.map(toRecord))]);
}
