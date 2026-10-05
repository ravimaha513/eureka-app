/**
 * Local development only: fictional DataHub folders (migration 0075) on top of
 * the dev fixtures, created as the acting user through the app role and the
 * definer functions (RLS, guards and audit apply). No files: uploads need the
 * running worker to scan them. Idempotent: does nothing when folders exist.
 */
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const U = { r1a: uid(9), l1: uid(6), locD: uid(14), hr: uid(16), acct: uid(17) };
const DALLAS = "00000000-0000-0000-0000-00000000d001";

async function asUser<T>(admin: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
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

interface SeedFolder {
  as: string; name: string; description?: string; level: "internal" | "confidential" | "restricted";
  roles?: string[]; members?: string[]; upload?: boolean; location?: string; children?: SeedFolder[];
}

const FOLDERS: SeedFolder[] = [
  { as: U.hr, name: "Company policies", description: "Fictional sample policies for local development.", level: "internal", upload: false,
    children: [{ as: U.hr, name: "Templates", level: "internal", upload: true }] },
  { as: U.hr, name: "Java Resumes", description: "Sample resume formats (fictional).", level: "confidential", roles: ["recruiter", "lead", "manager", "assoc_director"], upload: true },
  { as: U.acct, name: "Payroll exports", description: "Restricted sample folder.", level: "restricted", members: [U.acct, U.hr] },
  { as: U.locD, name: "Dallas guest house", level: "internal", location: DALLAS },
];

export async function seedDevDatahub(admin: pg.Pool): Promise<number> {
  if ((await admin.query("SELECT 1 FROM eureka.datahub_folder LIMIT 1")).rowCount) return 0;
  let n = 0;
  const create = async (f: SeedFolder, parent: string | null) => {
    const id = await asUser(admin, f.as, async (c) => (await c.query<{ id: string }>(
      `SELECT authz.datahub_create_folder($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
      [parent, f.name, f.description ?? null, f.level, f.roles ?? [], f.members ?? [], f.upload ?? false, f.location ?? null])).rows[0]!.id);
    n += 1;
    for (const child of f.children ?? []) await create(child, id);
  };
  for (const f of FOLDERS) await create(f, null);
  return n;
}
