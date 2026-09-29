/**
 * Local development seed: applies migrations, then loads the same fictional
 * org and candidates the integration tests use. Refuses to run in production.
 *   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/eureka pnpm db:seed
 */
import pg from "pg";
import { migrate } from "./migrate.js";
import { seedFixtures } from "../../test/fixtures.js";

if (process.env.NODE_ENV === "production") throw new Error("seed-dev must not run in production");
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

await migrate(url);
const admin = new pg.Pool({ connectionString: url });
const { rows } = await admin.query("SELECT count(*)::int AS n FROM eureka.app_user");
if (rows[0].n === 0) {
  const candidates = await seedFixtures(admin);
  await admin.query(`UPDATE eureka.candidate SET marketing_start_date = current_date - (random() * 40)::int`);
  console.log(`seeded ${candidates.length} fictional candidates; sign in as e.g. r1a@eureka.example, l1@eureka.example, m1@eureka.example, locD@eureka.example`);
} else {
  console.log("database already has users; skipping fixtures");
}
if (process.env.APP_DB_PASSWORD) {
  await admin.query(`ALTER ROLE eureka_app PASSWORD '${process.env.APP_DB_PASSWORD.replace(/'/g, "''")}'`);
}
await admin.end();
