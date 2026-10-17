import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";
import { migrate } from "../src/db/migrate.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
export const APP_PASSWORD = "eureka_app_test";

declare module "vitest" {
  export interface ProvidedContext { templateDb: string }
}

const root = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

/**
 * Migrates one template database per run; each test file then copies it (CREATE DATABASE ... TEMPLATE),
 * which takes a fraction of a second instead of applying every migration again. The role passwords are
 * cluster-wide, so they are set here once rather than by each file.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const name = `eureka_tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await root((c) => c.query(`CREATE DATABASE ${name}`));
  await migrate(`${ADMIN_BASE}/${name}`);
  const admin = new pg.Client({ connectionString: `${ADMIN_BASE}/${name}` });
  await admin.connect();
  await admin.query(`ALTER ROLE eureka_app PASSWORD '${APP_PASSWORD}'`);
  await admin.query(`ALTER ROLE eureka_worker PASSWORD '${APP_PASSWORD}'`);
  await admin.end();
  provide("templateDb", name);
  return async () => {
    await root((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  };
}
