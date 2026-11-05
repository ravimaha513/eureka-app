import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNCTIONS_BASELINE, FUNCTIONS_DIR, MIGRATIONS_DIR, functionSince, planRun, scramSha256Verifier, sqlFiles } from "./migrate.js";

/** Migrations up to this one may still define functions that now live in db/functions. */
const LAST_COPYING_MIGRATION = "0180";
/** Functions moved to db/functions after their last migrated body (migration: function). */
const MOVED_LATER = new Set([
  "0270_import_hotlist_sheet.sql: authz.import_load_person",
  // Moved with the other guards for the candidate delete bypass (migration 0330).
  "0240_candidate_team_share.sql: eureka.candidate_team_share_guard",
]);
/**
 * Numbers used twice; both files are applied in name order. 0090 predates this
 * check; 0270 and 0280 were merged together on 2026-10-29 (renaming an applied
 * migration would run it again under the new name).
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
      .flatMap((f) => defines(read(MIGRATIONS_DIR, f)).filter((fn) => managed.has(fn)).map((fn) => `${f}: ${fn}`))
      .filter((x) => !MOVED_LATER.has(x));
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

describe("run order (G-05)", () => {
  const fn = (file: string, since = FUNCTIONS_BASELINE) => ({ file, since });

  it("places each function file right after the migration its since names, fresh or incremental", () => {
    const fns = [fn("authz/b.sql"), fn("authz/a.sql", "0502"), fn("eureka/c.sql", "0400")];
    const order = (steps: ReturnType<typeof planRun>) => steps.map((s) => s.file);
    expect(order(planRun(["0398_x.sql", "0400_y.sql", "0499_z.sql", "0500_p.sql", "0502_q.sql", "0503_r.sql"], fns))).toEqual(
      ["0398_x.sql", "0400_y.sql", "eureka/c.sql", "0499_z.sql", "authz/b.sql", "0500_p.sql", "0502_q.sql", "authz/a.sql", "0503_r.sql"]);
    // The same database migrated through 0500 earlier: the pending tail sees the same bodies.
    expect(order(planRun(["0502_q.sql", "0503_r.sql"], fns))).toEqual(
      ["eureka/c.sql", "authz/b.sql", "0502_q.sql", "authz/a.sql", "0503_r.sql"]);
    // Nothing pending: files only, in since then name order.
    expect(order(planRun([], fns))).toEqual(["eureka/c.sql", "authz/b.sql", "authz/a.sql"]);
  });

  it("keeps every migration up to the baseline ahead of all unmarked function files (0001-0499 unchanged)", () => {
    const steps = planRun(migrations, functionFiles.map((f) => fn(f, functionSince(read(FUNCTIONS_DIR, f)))));
    const firstFn = steps.findIndex((s) => s.kind === "function");
    const lastBaselineMigration = steps.map((s) => s.kind === "migration" && s.file.slice(0, 4) <= FUNCTIONS_BASELINE).lastIndexOf(true);
    expect(firstFn).toBeGreaterThan(lastBaselineMigration);
  });

  it.each(functionFiles)("%s: a since marker names an existing migration", (f) => {
    const sql = read(FUNCTIONS_DIR, f);
    if (!/^-- since:/m.test(sql)) return;
    const since = functionSince(sql);
    expect(migrations.some((m) => m.startsWith(since)), `${f} -- since: ${since}`).toBe(true);
  });
});

describe("SCRAM verifier (G-06)", () => {
  it("has Postgres's rolpassword shape and never contains the password", () => {
    const v = scramSha256Verifier("s3cret-Pass word!");
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(v).not.toContain("s3cret");
    expect(scramSha256Verifier("s3cret-Pass word!")).not.toBe(v); // random salt
  });

  it("is deterministic for a given salt and iteration count", () => {
    const salt = Buffer.from("0123456789abcdef");
    expect(scramSha256Verifier("pencil", { salt, iterations: 4096 })).toBe(scramSha256Verifier("pencil", { salt, iterations: 4096 }));
    expect(scramSha256Verifier("pencil", { salt, iterations: 4096 })).not.toBe(scramSha256Verifier("pencil", { salt, iterations: 8192 }));
  });

  it("refuses passwords Postgres would SASLprep-normalise", () => {
    expect(() => scramSha256Verifier("pässword")).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier("")).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier("a\nb")).toThrow(/printable ASCII/);
  });
});
