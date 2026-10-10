/**
 * Sheet migration CLI (docs/import.md). Connects as eureka_import and needs
 * the keyed-hash secret:
 *   IMPORT_DATABASE_URL=postgres://eureka_import@host/db  (password via PGPASSWORD or ~/.pgpass)
 *   IMPORT_HMAC_KEY=<at least 32 characters, from Secrets Manager>
 *   pnpm --filter @eureka/api exec tsx src/import/cli.ts <command> [options]
 *
 *   stage      --sales a.csv [--submissions s.csv] --interviews b.csv --placements c.csv --ticket T [--mapping m.json]
 *   stage      --workbook team.xlsx --ticket T [--mapping m.json] [--as-of YYYY-MM-DD]
 *              (a team workbook: "<Team> Submissions/Interviews/Placements" tabs; default mapping
 *              mapping.team-workbook.json; see team-workbook.ts)
 *   workbook   --file team.xlsx [--as-of YYYY-MM-DD]   (no database: how the tabs would be read)
 *   reanalyse  --batch ID              (after review decisions made in the API)
 *   review     --batch ID
 *   commit     --batch ID [--commit]   (dry run unless --commit)
 *   report     --batch ID
 *   purge      --batch ID | --expired
 *   propose-mapping --file x.xlsx|x.csv [--sheet NAME] [--kind sales|interviews|placements] [--mapping base.json] [--out m.json]
 *              (no database; needs ANTHROPIC_API_KEY. The LLM only proposes; review the output, then use it as --mapping.)
 * Review decisions and approval are API calls by signed-in org admins
 * (POST /api/v1/imports/...). Add --json for machine-readable output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { makeHmac } from "./analyze.js";
import { commitBatch } from "./commit.js";
import { DEFAULT_MAPPING_PATH, SHEETS, type Sheet } from "./mapping.js";
import { formatReport, reconcile } from "./report.js";
import { listReview, purgeBatch, purgeExpired } from "./review.js";
import { applyProposal, AnthropicClient, proposeMapping, type LlmClient } from "./llm-mapper.js";
import { parseCsv } from "./csv.js";
import { recompute, stage, stageTexts } from "./stage.js";
import { teamWorkbook, workbookTexts, type TeamWorkbook } from "./team-workbook.js";
import { todayIso } from "./analyze.js";
import { readWorkbook } from "./xlsx.js";

export const TEAM_WORKBOOK_MAPPING_PATH = DEFAULT_MAPPING_PATH.replace(/mapping\.default\.json$/, "mapping.team-workbook.json");

const USAGE = `usage: cli.ts <stage|reanalyse|review|commit|report|purge|propose-mapping|workbook> [options]  (see docs/import.md)`;

/** Commands that need no database (no IMPORT_DATABASE_URL). */
export const OFFLINE_COMMANDS = new Set(["workbook", "propose-mapping"]);

export async function run(
  argv: string[], pool: pg.Pool | null, out: (s: string) => void = console.log, env: NodeJS.ProcessEnv = process.env,
  llm?: LlmClient,
): Promise<void> {
  const [command, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      sales: { type: "string" }, submissions: { type: "string" }, interviews: { type: "string" }, placements: { type: "string" },
      workbook: { type: "string" }, "as-of": { type: "string" },
      mapping: { type: "string" }, ticket: { type: "string" }, batch: { type: "string" },
      commit: { type: "boolean", default: false }, expired: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      file: { type: "string" }, sheet: { type: "string" }, kind: { type: "string" }, out: { type: "string" },
    },
    strict: true,
  });
  const need = (k: keyof typeof v): string => {
    const x = v[k];
    if (typeof x !== "string" || !x) throw new Error(`--${k} is required for ${command}\n${USAGE}`);
    return x;
  };
  const print = (obj: unknown, text: string) => out(v.json ? JSON.stringify(obj, null, 2) : text);
  const asOf = v["as-of"] ?? todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  if (command === "workbook") {
    if (!v.file) throw new Error(`--file is required for workbook\n${USAGE}`);
    const wb = teamWorkbook(await readWorkbook(readFileSync(v.file)), { asOf });
    print(workbookSummary(wb), formatWorkbook(wb));
    return;
  }
  if (command === "propose-mapping") {
    await proposeMappingCommand(v, print, llm ?? new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY ?? "", model: env.IMPORT_LLM_MODEL }));
    return;
  }
  if (!pool) throw new Error("IMPORT_DATABASE_URL is required (a login for the eureka_import role; see docs/import.md)");
  const hmac = () => makeHmac(env.IMPORT_HMAC_KEY ?? "");
  // Least privilege: never run the import as the owner, a superuser or the API role.
  const who = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
  if (who !== "eureka_import") throw new Error(`Connect as eureka_import (connected as ${who})`);

  switch (command) {
    case "stage": {
      let r;
      if (v.workbook) {
        if (v.sales || v.submissions || v.interviews || v.placements) throw new Error("--workbook replaces the per-sheet files");
        const mappingText = readFileSync(v.mapping ?? TEAM_WORKBOOK_MAPPING_PATH, "utf8");
        const wb = teamWorkbook(await readWorkbook(readFileSync(v.workbook)), { asOf });
        r = await stageTexts(pool, workbookTexts(wb, basename(v.workbook), asOf), mappingText, { ticket: v.ticket, hmac: hmac() });
      } else {
        const mappingText = readFileSync(v.mapping ?? DEFAULT_MAPPING_PATH, "utf8");
        r = await stage(pool, { sales: v.sales, submissions: v.submissions, interviews: v.interviews, placements: v.placements }, mappingText,
          { ticket: v.ticket, hmac: hmac() });
      }
      const rep = await reconcile(pool, r.batchId);
      print({ ...r, report: rep }, `${r.created ? "Staged new" : "Re-analysed open"} batch ${r.batchId} (nothing loaded)\n\n${formatReport(rep)}`);
      return;
    }
    case "reanalyse": {
      const batch = need("batch");
      await recompute(pool, batch, hmac());
      const rep = await reconcile(pool, batch);
      print(rep, formatReport(rep));
      return;
    }
    case "review": {
      const items = await listReview(pool, need("batch"));
      print(items, items.length === 0 ? "Review queue is empty." : items.map((i) =>
        `${i.sheet} row ${i.rowNo}  [${i.state}]  ${i.reasons.join(", ")}`
        + `${i.salesRow ? `  (person: sales row ${i.salesRow})` : ""}`
        + `${i.approvable ? "  approvable" : ""}${i.commitError ? `  commit error: ${i.commitError}` : ""}`).join("\n"));
      return;
    }
    case "commit": {
      const batch = need("batch");
      const result = await commitBatch(pool, batch, { dryRun: !v.commit });
      const rep = await reconcile(pool, batch);
      print({ commit: result, report: rep }, formatReport(rep, result));
      return;
    }
    case "report": {
      const rep = await reconcile(pool, need("batch"));
      print(rep, formatReport(rep));
      return;
    }
    case "purge": {
      if (v.expired) {
        const r = await purgeExpired(pool);
        print(r, `Purged ${r.batches} batches older than the configured retention (${r.rows} rows cleared).`);
        return;
      }
      const n = await purgeBatch(pool, need("batch"));
      print({ purgedRows: n }, `Cleared stored cells of ${n} rows.`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

/** Counts and tab names only: no candidate data. */
function workbookSummary(wb: TeamWorkbook) {
  return {
    tabs: wb.tabs.map((t) => ({ tab: t.name, kind: t.kind, team: t.team, rows: t.rows, classifiedBy: t.by, sourceRange: t.source?.range })),
    ignored: wb.ignored,
    generated: Object.fromEntries(Object.entries(wb.sheets).map(([k, s]) => [k, s.rows.length])),
    ...wb.stats,
  };
}

function formatWorkbook(wb: TeamWorkbook): string {
  const s = workbookSummary(wb);
  return [
    ...s.tabs.map((t) => `  ${t.tab.padEnd(28)} ${t.kind.padEnd(12)} team ${t.team.padEnd(12)} ${String(t.rows).padStart(5)} rows  (${t.classifiedBy}${t.sourceRange ? `: IMPORTRANGE ${t.sourceRange}` : ""})`),
    s.ignored.length ? `Ignored tabs: ${s.ignored.join(", ")}` : "",
    `Generated: ${Object.entries(s.generated).map(([k, n]) => `${n} ${k === "sales" ? "people" : k}`).join(", ")}`,
    `Candidates: ${s.candidates} (${s.multiTeamCandidates} submitted by more than one team: open to all teams)`,
    `Interviews: client inferred for ${s.interviewsWithInferredClient} (need approval); ${s.interviewsWithoutClient} without a client wait in review`,
  ].filter(Boolean).join("\n");
}

async function proposeMappingCommand(
  v: { file?: string; sheet?: string; kind?: string; mapping?: string; out?: string },
  print: (obj: unknown, text: string) => void, llm: LlmClient,
): Promise<void> {
  if (!v.file) throw new Error(`--file is required for propose-mapping\n${USAGE}`);
  if (v.kind !== undefined && !(SHEETS as readonly string[]).includes(v.kind)) throw new Error(`--kind must be one of ${SHEETS.join(", ")}`);
  const kind = v.kind as Sheet | undefined;
  // The header may sit below title rows here: only staging needs it on row 1.
  const raw = readFileSync(v.file);
  let table: { headers: string[]; rows: string[][] };
  if (v.file.toLowerCase().endsWith(".xlsx")) {
    const sheets = await readWorkbook(raw);
    const s = v.sheet ? sheets.find((x) => x.name === v.sheet) : sheets[0];
    if (!s) throw new Error(`No sheet "${v.sheet}" (has: ${sheets.map((x) => x.name).join(", ")})`);
    table = s;
  } else {
    const t = parseCsv(raw.toString("utf8"));
    table = { headers: t.headers, rows: t.rows.map((r) => t.headers.map((h) => r.cells[h] ?? "")) };
  }
  const proposal = await proposeMapping(llm, table, { kind });
  let merged: unknown;
  let problem: string | undefined;
  try {
    merged = applyProposal(JSON.parse(readFileSync(v.mapping ?? DEFAULT_MAPPING_PATH, "utf8")), proposal);
  } catch (e) {
    problem = (e as Error).message;
  }
  if (v.out && merged) writeFileSync(v.out, JSON.stringify(merged, null, 2) + "\n");
  const lines = [
    `Sheet kind: ${proposal.kind} (${Math.round(proposal.kindConfidence * 100)}%)`,
    ...Object.entries(proposal.columns).map(([f, h]) => `  ${f.padEnd(22)} <- "${h}"  (${Math.round(proposal.confidence[f]! * 100)}%)`),
    proposal.missing.length ? `Missing (map by hand): ${proposal.missing.join(", ")}` : "",
    proposal.unmapped.length ? `Ignored columns: ${proposal.unmapped.map((h) => `"${h}"`).join(", ")}` : "",
    ...proposal.rejected.map((r) => `Dropped model answer ${r.field} -> ${JSON.stringify(r.header)}: ${r.reason}`),
    ...proposal.notes.map((n) => `Note: ${n}`),
    problem ? `Not a usable mapping yet: ${problem}` : v.out ? `Wrote ${v.out}. Review it; status and row-colour labels are NOT proposed and still come from the base mapping.` : "",
  ].filter(Boolean);
  print({ proposal, usable: !problem, problem }, lines.join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const url = process.env.IMPORT_DATABASE_URL;
  if (!url && !OFFLINE_COMMANDS.has(process.argv[2] ?? "")) {
    console.error("IMPORT_DATABASE_URL is required (a login for the eureka_import role; see docs/import.md)");
    process.exit(2);
  }
  const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
  try {
    await run(process.argv.slice(2), pool);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
