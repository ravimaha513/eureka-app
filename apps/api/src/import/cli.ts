/**
 * Sheet migration CLI (docs/import.md). Connects as eureka_import and needs
 * the keyed-hash secret:
 *   IMPORT_DATABASE_URL=postgres://eureka_import@host/db  (password via PGPASSWORD or ~/.pgpass)
 *   IMPORT_HMAC_KEY=<at least 32 characters, from Secrets Manager>
 *   pnpm --filter @eureka/api exec tsx src/import/cli.ts <command> [options]
 *
 *   stage      --sales a.csv --interviews b.csv --placements c.csv --ticket T [--mapping m.json]
 *              [--source sheets|crewnex] [--historical]   (fixed on a new batch, signed by the approver)
 *   reanalyse  --batch ID              (after review decisions made in the API)
 *   review     --batch ID
 *   commit     --batch ID [--commit]   (dry run unless --commit)
 *   report     --batch ID
 *   purge      --batch ID | --expired
 * Review decisions and approval are API calls by signed-in org admins
 * (POST /api/v1/imports/...). Add --json for machine-readable output.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { makeHmac } from "./analyze.js";
import { commitBatch } from "./commit.js";
import { DEFAULT_MAPPING_PATH } from "./mapping.js";
import { formatReport, reconcile } from "./report.js";
import { listReview, purgeBatch, purgeExpired } from "./review.js";
import { BATCH_SOURCES, recompute, stage, type BatchSource } from "./stage.js";

const USAGE = `usage: cli.ts <stage|reanalyse|review|commit|report|purge> [options]  (see docs/import.md)`;

export async function run(
  argv: string[], pool: pg.Pool, out: (s: string) => void = console.log, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const [command, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      sales: { type: "string" }, interviews: { type: "string" }, placements: { type: "string" },
      mapping: { type: "string" }, ticket: { type: "string" }, batch: { type: "string" },
      source: { type: "string" }, historical: { type: "boolean", default: false },
      commit: { type: "boolean", default: false }, expired: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const need = (k: keyof typeof v): string => {
    const x = v[k];
    if (typeof x !== "string" || !x) throw new Error(`--${k} is required for ${command}\n${USAGE}`);
    return x;
  };
  const print = (obj: unknown, text: string) => out(v.json ? JSON.stringify(obj, null, 2) : text);
  const hmac = () => makeHmac(env.IMPORT_HMAC_KEY ?? "");
  // Least privilege: never run the import as the owner, a superuser or the API role.
  const who = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
  if (who !== "eureka_import") throw new Error(`Connect as eureka_import (connected as ${who})`);

  switch (command) {
    case "stage": {
      const source = v.source ?? "sheets";
      if (!(BATCH_SOURCES as readonly string[]).includes(source)) {
        throw new Error(`--source must be one of ${BATCH_SOURCES.join(", ")}\n${USAGE}`);
      }
      const mappingText = readFileSync(v.mapping ?? DEFAULT_MAPPING_PATH, "utf8");
      const r = await stage(pool, { sales: v.sales, interviews: v.interviews, placements: v.placements }, mappingText,
        { ticket: v.ticket, hmac: hmac(), source: source as BatchSource, historical: v.historical });
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
