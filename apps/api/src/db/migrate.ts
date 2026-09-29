import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { GRANTS, LOCATION_ROLES, ROLES, ROLE_LABELS, SALES_ROLES } from "@eureka/shared";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");

/**
 * Applies SQL migrations in order, then seeds roles and grants from the
 * authorization catalog (design B4.1: grants live in code, never edited at runtime).
 * Must run with a privileged connection (superuser / rds_superuser).
 */
export async function migrate(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM public.schema_migration")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("RESET ROLE");
        await client.query("INSERT INTO public.schema_migration (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    await seedCatalog(client);
  } finally {
    await client.end();
  }
}

/** Replaces role and role_permission rows with the catalog contents. */
export async function seedCatalog(client: pg.Client | pg.PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const role of ROLES) {
      await client.query(
        `INSERT INTO eureka.role (key, label, is_sales, is_location_bound) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, is_sales = EXCLUDED.is_sales,
           is_location_bound = EXCLUDED.is_location_bound`,
        [role, ROLE_LABELS[role], SALES_ROLES.includes(role), LOCATION_ROLES.includes(role)],
      );
    }
    await client.query("DELETE FROM eureka.role_permission");
    for (const role of ROLES) {
      for (const [permission, scope] of Object.entries(GRANTS[role])) {
        await client.query(
          "INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ($1,$2,$3)",
          [role, permission, scope],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  migrate(url).then(() => console.log("migrations applied"));
}
