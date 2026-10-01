/**
 * Sheet migration CLI (docs/import.md). Connects as eureka_import:
 *   IMPORT_DATABASE_URL=postgres://eureka_import:...@host/db \
 *   pnpm --filter @eureka/api exec tsx src/import/cli.ts <command> [options]
 *
 *   stage    --sales a.csv --interviews b.csv --placements c.csv --operator you@x [--mapping m.json]
 *   review   --batch ID
 *   resolve  --batch ID --sheet sales|interviews|placements --row N --action approve|reject|link [--sales-row N] --by reviewer@x
 *   approve  --batch ID --by org-admin@x
 *   commit   --batch ID [--commit]        (dry run unless --commit)
 *   report   --batch ID
 *   purge    --batch ID
 * Add --json for machine-readable output.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { commitBatch } from "./commit.js";
import { DEFAULT_MAPPING_PATH, SHEETS, type Sheet } from "./mapping.js";
import { formatReport, reconcile } from "./report.js";
import { approveBatch, decide, listReview, purgeBatch, type ReviewAction } from "./review.js";
import { stage } from "./stage.js";

const USAGE = `usage: cli.ts <stage|review|resolve|approve|commit|report|purge> [options]  (see docs/import.md)`;

export async function run(argv: string[], pool: pg.Pool, out: (s: string) => void = console.log): Promise<void> {
  const [command, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      sales: { type: "string" }, interviews: { type: "string" }, placements: { type: "string" },
      mapping: { type: "string" }, operator: { type: "string" }, batch: { type: "string" },
      sheet: { type: "string" }, row: { type: "string" }, action: { type: "string" }, "sales-row": { type: "string" },
      by: { type: "string" }, commit: { type: "boolean", default: false }, json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const need = (k: keyof typeof v): string => {
    const x = v[k];
    if (typeof x !== "string" || !x) throw new Error(`--${k} is required for ${command}\n${USAGE}`);
    return x;
  };
  const print = (obj: unknown, text: string) => out(v.json ? JSON.stringify(obj, null, 2) : text);
  // Least privilege: never run the import as the owner, a superuser or the API role.
  const who = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
  if (who !== "eureka_import") throw new Error(`Connect as eureka_import (connected as ${who})`);

  switch (command) {
    case "stage": {
      const mappingText = readFileSync(v.mapping ?? DEFAULT_MAPPING_PATH, "utf8");
      const r = await stage(pool, { sales: v.sales, interviews: v.interviews, placements: v.placements }, mappingText, need("operator"));
      const rep = await reconcile(pool, r.batchId);
      print({ ...r, report: rep }, `${r.created ? "Staged new" : "Re-analysed existing"} batch ${r.batchId} (dry run: nothing loaded)\n\n${formatReport(rep)}`);
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
    case "resolve": {
      const sheet = need("sheet") as Sheet;
      if (!SHEETS.includes(sheet)) throw new Error(`--sheet must be one of ${SHEETS.join(", ")}`);
      const row = Number(need("row"));
      const action = need("action");
      let a: ReviewAction;
      if (action === "approve" || action === "reject") a = { action };
      else if (action === "link") a = { action, salesRowNo: Number(need("sales-row")) };
      else throw new Error("--action must be approve, reject or link");
      const batch = need("batch");
      await decide(pool, batch, sheet, row, a, need("by"));
      print({ ok: true }, `Recorded ${action} for ${sheet} row ${row}; batch re-analysed (any approval was withdrawn).`);
      return;
    }
    case "approve": {
      const batch = need("batch");
      await approveBatch(pool, batch, need("by"));
      print({ ok: true }, `Batch ${batch} approved. Run commit without --commit to rehearse, then with --commit to load.`);
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
      const n = await purgeBatch(pool, need("batch"));
      print({ purgedRows: n }, `Cleared stored cells of ${n} rows.`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const url = process.env.IMPORT_DATABASE_URL;
  if (!url) {
    console.error("IMPORT_DATABASE_URL is required (a login for the eureka_import role; see docs/import.md)");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await run(process.argv.slice(2), pool);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
