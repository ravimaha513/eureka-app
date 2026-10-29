import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNCTIONS_DIR, MIGRATIONS_DIR, sqlFiles } from "./migrate.js";

/** Migrations up to this one may still define functions that now live in db/functions. */
const LAST_COPYING_MIGRATION = "0180";
/**
 * Numbers used twice; both files are applied in name order. 0090 predates this check; 0270 and 0280
 * merged in parallel (2026-10-29) and were applied on staging and production before anyone noticed,
 * so renaming them would re-run them. Never add to this list for an unapplied migration: renumber it.
 */
const KNOWN_DUPLICATE_PREFIXES = new Set(["0090", "0270", "0280"]);

const migrations = sqlFiles(MIGRATIONS_DIR);
const functionFiles = sqlFiles(FUNCTIONS_DIR);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const defines = (sql: string) =>
  [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(/gi)].map((m) => m[1]!.toLowerCase());

describe("migration files", () => {
  it("are flat, numbered and never share a number", () => {
    const seen = new Map<string, string>();
    for (const f of migrations) {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      const n = f.slice(0, 4);
      if (seen.has(n) && !KNOWN_DUPLICATE_PREFIXES.has(n)) {
        throw new Error(`${f} and ${seen.get(n)} share number ${n}; renumber the newer one`);
      }
      seen.set(n, f);
    }
  });

  it("do not redefine a function that lives in db/functions", () => {
    const managed = new Set(functionFiles.map((f) => f.replace(/\.sql$/, "").replace("/", ".")));
    const offenders = migrations
      .filter((f) => f.slice(0, 4) > LAST_COPYING_MIGRATION)
      .flatMap((f) => defines(read(MIGRATIONS_DIR, f)).filter((fn) => managed.has(fn)).map((fn) => `${f}: ${fn}`));
    expect(offenders, "change db/functions/<schema>/<name>.sql instead").toEqual([]);
  });
});

describe("function files", () => {
  it.each(functionFiles)("%s defines exactly its own function, as its owner, without PUBLIC execute", (f) => {
    const sql = read(FUNCTIONS_DIR, f);
    expect(defines(sql)).toEqual([f.replace(/\.sql$/, "").replace("/", ".")]);
    expect(sql).toMatch(/^SET ROLE (authz_definer|eureka_owner);$/m);
    expect(sql.trimEnd()).toMatch(/RESET ROLE;$/);
    expect(sql).toMatch(/^REVOKE ALL ON FUNCTION .+ FROM PUBLIC;$/m);
    expect(sql).toMatch(/^ SET search_path TO /m);
  });
});
