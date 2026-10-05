import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRANTS, type Role } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, U, USERS, seedFixtures } from "./fixtures.js";

/**
 * Database-only checks for migration 0075 (DataHub): RLS alone matches an
 * independent model of the level rules for every fixture user, writes only
 * through the definer functions (guards refuse the app and the owner),
 * versioning, step-up and the access log, and audit rows without names or
 * descriptions (design B8: the rules hold with the API removed).
 */
let db: TestDb;
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const SHA = "b".repeat(64);
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on')`);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const q = async <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = [], commit = true) =>
  asUser(db.app, user, async (c) => (await c.query(sql, params)).rows as T[], commit);
const createFolder = (user: string, o: {
  parent?: string | null; name: string; description?: string | null; level: string; roles?: string[]; members?: string[];
  upload?: boolean; location?: string | null;
}) => q<{ id: string }>(user, `SELECT authz.datahub_create_folder($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
  [o.parent ?? null, o.name, o.description ?? null, o.level, o.roles ?? [], o.members ?? [], o.upload ?? false, o.location ?? null])
  .then((r) => r[0]!.id);
const upload = (user: string, folder: string, name: string, size = 1000, type = PDF) =>
  q<{ file_id: string; version_id: string; version: number; file_object_id: string; classification: string }>(user,
    `SELECT * FROM authz.datahub_create_upload($1, $2, $3, $4)`, [folder, name, type, size]).then((r) => r[0]!);
const finish = (id: string, status: string, result: string, sha: string | null = null, size: number | null = null) =>
  db.worker.query<{ s: string }>(`SELECT authz.document_scan_finish($1, $2, $3, $4, $5) AS s`, [id, status, result, sha, size]).then((r) => r.rows[0]!.s);
const err = (p: Promise<unknown>) => p.then(() => null, (e: { message: string; code: string }) => ({ message: e.message, code: e.code }));

async function session(userId: string): Promise<Buffer> {
  const hash = sha256(randomBytes(32));
  await db.admin.query(
    `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version)
     SELECT $1, id, now() + interval '1 hour', now(), access_version FROM eureka.app_user WHERE id = $2`, [hash, userId]);
  return hash;
}
const download = (user: string, version: string, s: Buffer | null) =>
  q<{ outcome: string; file_object_id: string | null; classification: string; access_id: string | null }>(user,
    `SELECT * FROM authz.datahub_download($1, $2)`, [version, s]).then((r) => r[0]!);

// ---- an independent model of the level rules (docs/datahub-api.md DH-1..DH-3) ----
interface ModelFolder { id: string; parent: string | null; level: "internal" | "confidential" | "restricted"; roles: Role[]; members: string[]; location: string | null }
const folders: ModelFolder[] = [];
const rolesOf = (key: keyof typeof U) => USERS[key].roles.map((r) => r.role);
const staff = (key: keyof typeof U) => rolesOf(key).some((r) => GRANTS[r]["datahub:read"] !== undefined);
const manages = (key: keyof typeof U, f: ModelFolder) => staff(key) && USERS[key].roles.some((r) => {
  const s = GRANTS[r.role]["datahub:manage"];
  return s === "org" || (s === "location" && r.location !== undefined && LOC[r.location] === f.location);
});
function ownRule(key: keyof typeof U, f: ModelFolder): boolean {
  if (!staff(key)) return false;
  if (f.level === "internal") return true;
  if (f.level === "confidential") return f.roles.some((r) => rolesOf(key).includes(r)) || manages(key, f);
  return f.members.includes(U[key]);
}
function readable(key: keyof typeof U, f: ModelFolder): boolean {
  const parent = f.parent ? folders.find((x) => x.id === f.parent)! : null;
  return ownRule(key, f) && (!parent || ownRule(key, parent));
}

const F: Record<string, string> = {};
async function add(user: string, name: string, f: Omit<ModelFolder, "id">, upload = false) {
  const id = await createFolder(user, { parent: f.parent, name, level: f.level, roles: f.roles, members: f.members, location: f.location, upload });
  folders.push({ id, ...f });
  F[name] = id;
  return id;
}

beforeAll(async () => {
  await add(U.hr, "Company policies", { parent: null, level: "internal", roles: [], members: [], location: null }, true);
  await add(U.hr, "Sales playbooks", { parent: null, level: "confidential", roles: ["lead", "manager"], members: [], location: null });
  await add(U.acct, "Payroll exports", { parent: null, level: "restricted", roles: [], members: [U.r1a, U.acct], location: null });
  await add(U.acct, "Payroll 2026", { parent: F["Payroll exports"]!, level: "restricted", roles: [], members: [U.r1a, U.acct], location: null });
  await add(U.locD, "Dallas guest house", { parent: null, level: "internal", roles: [], members: [], location: LOC.dallas });
  await add(U.hr, "Austin office", { parent: null, level: "confidential", roles: ["location_incharge"], members: [], location: LOC.austin });
  await add(U.locD, "Dallas leases", { parent: null, level: "restricted", roles: [], members: [U.locD], location: LOC.dallas });
});

describe("folder visibility (RLS) matches the model for every fixture user", () => {
  it.each(users)("%s", async (key) => {
    const rows = await q<{ id: string }>(U[key], `SELECT id FROM eureka.datahub_folder ORDER BY id`);
    const expected = folders.filter((f) => readable(key, f) || manages(key, f)).map((f) => f.id).sort();
    expect(rows.map((r) => r.id)).toEqual(expected);
    const readableIds = (await q<{ ids: string[] }>(U[key], `SELECT authz.datahub_readable_folders() AS ids`))[0]!.ids.sort();
    expect(readableIds).toEqual(folders.filter((f) => readable(key, f)).map((f) => f.id).sort());
  });

  it("org_admin (no staff role) and an applicant-like account with no role see nothing", async () => {
    const applicant = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name) VALUES ('applicant@example.invalid', 'Applicant') RETURNING id`)).rows[0]!.id;
    for (const u of [U.admin, applicant]) {
      expect(await q(u, `SELECT id FROM eureka.datahub_folder`)).toEqual([]);
      expect((await q<{ ids: string[] }>(u, `SELECT authz.datahub_visible_folders() AS ids`))[0]!.ids).toEqual([]);
      expect(await err(createFolder(u, { name: "x", level: "internal" }))).toMatchObject({ message: "not_permitted" });
    }
  });

  it("an inactive member loses access", async () => {
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.r1a]);
    try {
      expect((await q(U.r1a, `SELECT id FROM eureka.datahub_folder`)).length).toBe(0);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.r1a]);
    }
  });

  it("the folder sets run once per statement (InitPlan), not per row", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.r1a]);
      const calls = async () => Number((await c.query<{ n: string | null }>(
        `SELECT pg_stat_get_xact_function_calls('authz.datahub_readable_folders()'::regprocedure) AS n`)).rows[0]!.n ?? 0);
      const before = await calls();
      await c.query("SET LOCAL ROLE eureka_app");
      const n = (await c.query(`SELECT f.id FROM eureka.datahub_file f`)).rowCount;
      await c.query("RESET ROLE");
      expect(n).toBeGreaterThanOrEqual(0);
      expect((await calls()) - before).toBeLessThanOrEqual(1);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("folder writes", () => {
  it("only definer functions write: the app has no write privilege; the owner is refused by the guard", async () => {
    expect(await err(q(U.hr, `INSERT INTO eureka.datahub_folder (name, level, created_by, updated_by) VALUES ('x', 'internal', $1, $1)`, [U.hr])))
      .toMatchObject({ code: "42501" });
    expect(await err(q(U.hr, `UPDATE eureka.datahub_folder SET name = 'x' WHERE id = $1`, [F["Company policies"]]))).toMatchObject({ code: "42501" });
    expect(await err(q(U.hr, `DELETE FROM eureka.datahub_folder_member`))).toMatchObject({ code: "42501" });
    expect(await err(db.admin.query(`UPDATE eureka.datahub_folder SET level = 'internal'`))).toMatchObject({ code: "42501" });
    expect(await err(db.admin.query(`INSERT INTO eureka.datahub_access (folder_id, file_id, version_id, version, user_id, action, level)
      SELECT id, id, id, 1, created_by, 'download', 'internal' FROM eureka.datahub_folder LIMIT 1`))).toMatchObject({ code: "42501" });
    expect(await err(db.admin.query(`TRUNCATE eureka.datahub_access`))).toMatchObject({ code: "42501" });
  });

  it("refuses non-managers, out-of-scope locations, depth, duplicates and bad level settings", async () => {
    expect(await err(createFolder(U.r1a, { name: "Mine", level: "internal" }))).toMatchObject({ message: "not_permitted" });
    expect(await err(createFolder(U.locD, { name: "Org wide", level: "internal" }))).toMatchObject({ message: "location_required" });
    expect(await err(createFolder(U.locD, { name: "Austin", level: "internal", location: LOC.austin }))).toMatchObject({ message: "not_permitted" });
    expect(await err(createFolder(U.locD, { parent: F["Company policies"]!, name: "Sub", level: "internal" }))).toMatchObject({ message: "not_permitted" });
    expect(await err(createFolder(U.acct, { parent: F["Payroll 2026"]!, name: "Too deep", level: "internal" }))).toMatchObject({ message: "too_deep" });
    expect(await err(createFolder(U.hr, { name: "company POLICIES", level: "internal" }))).toMatchObject({ message: "name_taken", code: "23505" });
    expect(await err(createFolder(U.hr, { name: "C", level: "confidential", roles: [] }))).toMatchObject({ message: "invalid_roles" });
    expect(await err(createFolder(U.hr, { name: "C", level: "confidential", roles: ["no_such_role"] }))).toMatchObject({ message: "invalid_roles" });
    expect(await err(createFolder(U.hr, { name: "C", level: "internal", roles: ["hr"] }))).toMatchObject({ message: "invalid_roles" });
    expect(await err(createFolder(U.hr, { name: "C", level: "internal", members: [U.r1a] }))).toMatchObject({ message: "invalid_member" });
    expect(await err(createFolder(U.hr, { name: "C", level: "restricted", members: [U.admin] }))).toMatchObject({ message: "invalid_member" });
    expect(await err(createFolder(U.hr, { name: "a/b", level: "internal" }))).toMatchObject({ message: "invalid_folder" });
    expect(await err(createFolder(U.hr, { name: " padded", level: "internal" }))).toMatchObject({ message: "invalid_folder" });
    expect(await err(createFolder(U.hr, { name: "x", level: "secret" }))).toMatchObject({ message: "invalid_level" });
    // A subfolder of a folder in another location is not a way around the location scope.
    expect(await err(createFolder(U.hr, { parent: F["Dallas guest house"]!, name: "Sub", level: "internal", location: LOC.austin })))
      .toMatchObject({ message: "invalid_location" });
  });

  it("update: managers only, row version, lowering restricted drops the members", async () => {
    const id = await createFolder(U.hr, { name: "Temp restricted", level: "restricted", members: [U.r2a] });
    expect(await err(q(U.r2a, `SELECT authz.datahub_update_folder($1, 1, '{"name":"x"}', '{}')`, [id]))).toMatchObject({ message: "not_permitted" });
    expect(await err(q(U.locD, `SELECT authz.datahub_update_folder($1, 1, '{"name":"x"}', '{}')`, [id]))).toMatchObject({ message: "not_found" });
    expect(await err(q(U.hr, `SELECT authz.datahub_update_folder($1, 7, '{"name":"x"}', '{}')`, [id]))).toMatchObject({ message: "stale" });
    expect(await err(q(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"owner":"x"}', '{}')`, [id]))).toMatchObject({ message: "invalid_folder" });
    const v = (await q<{ v: number }>(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"level":"internal"}', '{}') AS v`, [id]))[0]!.v;
    expect(v).toBe(2);
    expect((await db.admin.query(`SELECT count(*)::int n FROM eureka.datahub_folder_member WHERE folder_id = $1`, [id])).rows[0].n).toBe(0);
    const v3 = (await q<{ v: number }>(U.hr, `SELECT authz.datahub_update_folder($1, 2, '{"level":"confidential","roleKeys":["accounts"]}', '{}') AS v`, [id]))[0]!.v;
    expect(v3).toBe(3);
    expect((await q(U.acct, `SELECT id FROM eureka.datahub_file WHERE folder_id = $1`, [id]))).toEqual([]);
    expect((await q<{ ids: string[] }>(U.acct, `SELECT authz.datahub_readable_folders() AS ids`))[0]!.ids).toContain(id);
    expect((await q<{ ids: string[] }>(U.r1a, `SELECT authz.datahub_readable_folders() AS ids`))[0]!.ids).not.toContain(id);
    // Raising back to restricted with a named member.
    await q(U.hr, `SELECT authz.datahub_update_folder($1, 3, '{"level":"restricted"}', $2)`, [id, [U.r3a]]);
    expect((await q<{ ids: string[] }>(U.r3a, `SELECT authz.datahub_readable_folders() AS ids`))[0]!.ids).toContain(id);
    expect((await q<{ ids: string[] }>(U.acct, `SELECT authz.datahub_readable_folders() AS ids`))[0]!.ids).not.toContain(id);
  });

  it("members: restricted folders only, managers only, staff only; readers see only their own membership row", async () => {
    const id = F["Payroll exports"]!;
    expect(await err(q(U.r1a, `SELECT authz.datahub_set_member($1, $2, true)`, [id, U.r2a]))).toMatchObject({ message: "not_permitted" });
    expect(await err(q(U.hr, `SELECT authz.datahub_set_member($1, $2, true)`, [F["Company policies"], U.r2a]))).toMatchObject({ message: "not_restricted" });
    expect(await err(q(U.hr, `SELECT authz.datahub_set_member($1, $2, true)`, [id, U.admin]))).toMatchObject({ message: "invalid_member" });
    expect((await q<{ c: boolean }>(U.hr, `SELECT authz.datahub_set_member($1, $2, true) AS c`, [id, U.r2a]))[0]!.c).toBe(true);
    expect((await q<{ c: boolean }>(U.hr, `SELECT authz.datahub_set_member($1, $2, true) AS c`, [id, U.r2a]))[0]!.c).toBe(false);
    expect((await q(U.r1a, `SELECT user_id FROM eureka.datahub_folder_member WHERE folder_id = $1`, [id]))).toEqual([{ user_id: U.r1a }]);
    expect((await q(U.hr, `SELECT user_id FROM eureka.datahub_folder_member WHERE folder_id = $1`, [id])).length).toBe(3);
    expect((await q<{ c: boolean }>(U.hr, `SELECT authz.datahub_set_member($1, $2, false) AS c`, [id, U.r2a]))[0]!.c).toBe(true);
  });

  it("deletes only empty folders", async () => {
    expect(await err(q(U.acct, `SELECT authz.datahub_delete_folder($1, 1)`, [F["Payroll exports"]]))).toMatchObject({ message: "folder_not_empty" });
    const id = await createFolder(U.hr, { name: "Empty", level: "internal" });
    expect(await err(q(U.r1a, `SELECT authz.datahub_delete_folder($1, 1)`, [id]))).toMatchObject({ message: "not_permitted" });
    await q(U.hr, `SELECT authz.datahub_delete_folder($1, 1)`, [id]);
    expect(await q(U.hr, `SELECT id FROM eureka.datahub_folder WHERE id = $1`, [id])).toEqual([]);
    // The name is free again.
    await createFolder(U.hr, { name: "Empty", level: "internal" });
  });
});

describe("files, versions, scan, download, access log", () => {
  it("upload rules: reader with members-can-upload, manager, nobody else; versions by name (case-insensitive)", async () => {
    expect(await err(upload(U.r1a, F["Sales playbooks"]!, "x.pdf"))).toMatchObject({ message: "not_found" });
    expect(await err(upload(U.l1, F["Sales playbooks"]!, "x.pdf"))).toMatchObject({ message: "not_permitted" });
    expect(await err(upload(U.admin, F["Company policies"]!, "x.pdf"))).toMatchObject({ message: "not_found" });
    // A manager who is not a member of a restricted folder cannot read it, so cannot upload there.
    expect(await err(upload(U.hr, F["Payroll exports"]!, "x.pdf"))).toMatchObject({ message: "not_found" });
    const a = await upload(U.r1b, F["Company policies"]!, "Leave policy.pdf");
    expect(a).toMatchObject({ version: 1, classification: "internal" });
    const b = await upload(U.hr, F["Company policies"]!, "LEAVE POLICY.pdf");
    expect(b).toMatchObject({ file_id: a.file_id, version: 2 });
    const r = await upload(U.acct, F["Payroll exports"]!, "June.pdf");
    expect(r.classification).toBe("restricted");
    expect(await err(upload(U.hr, F["Company policies"]!, "bad.docx"))).toMatchObject({ message: "invalid_upload" });
    expect(await err(upload(U.hr, F["Company policies"]!, "a/b.pdf"))).toMatchObject({ message: "invalid_upload" });
    expect(await err(upload(U.hr, F["Company policies"]!, "big.pdf", 15 * 1024 * 1024 + 1))).toMatchObject({ message: "invalid_upload" });
    expect(await err(upload(U.hr, F["Company policies"]!, "img.jpeg", 10, "image/gif"))).toMatchObject({ message: "invalid_upload" });
    expect((await q(U.r1a, `SELECT name, latest_version FROM eureka.datahub_file WHERE id = $1`, [a.file_id]))).toEqual([{ name: "Leave policy.pdf", latest_version: 2 }]);
    // File objects are readable with their version, and only then.
    expect((await q(U.r1a, `SELECT id FROM eureka.file_object WHERE id = $1`, [b.file_object_id])).length).toBe(1);
    expect((await q(U.r1a, `SELECT id FROM eureka.file_object WHERE id = $1`, [r.file_object_id])).length).toBe(1); // r1a is a member
    expect((await q(U.r2a, `SELECT id FROM eureka.file_object WHERE id = $1`, [r.file_object_id])).length).toBe(0);
    expect((await q(U.hr, `SELECT id FROM eureka.datahub_file_version WHERE file_object_id = $1`, [r.file_object_id])).length).toBe(0);
  });

  it("at most ten pending uploads per user", async () => {
    const id = await createFolder(U.hr, { name: "Pending", level: "internal", upload: true });
    for (let i = 0; i < 10; i++) await upload(U.r3a, id, `p${i}.pdf`);
    expect(await err(upload(U.r3a, id, "p10.pdf"))).toMatchObject({ message: "too_many_pending" });
  });

  it("downloads: clean only, restricted needs a step-up; each link is logged for the managers", async () => {
    const pol = await upload(U.hr, F["Company policies"]!, "Holidays.pdf");
    const pay = await upload(U.acct, F["Payroll exports"]!, "July.pdf");
    const s1 = await session(U.r1a);
    expect((await download(U.r1a, pol.version_id, s1)).outcome).toBe("not_available");
    await finish(pol.file_object_id, "clean", "NO_THREATS_FOUND", SHA, 1000);
    await finish(pay.file_object_id, "clean", "NO_THREATS_FOUND", SHA, 1000);
    expect(await download(U.r1a, pol.version_id, s1)).toMatchObject({ outcome: "ok", classification: "internal" });
    expect(await download(U.r1a, pay.version_id, s1)).toMatchObject({ outcome: "step_up_required", file_object_id: null });
    expect(await err(download(U.r2a, pay.version_id, s1))).toMatchObject({ message: "not_found" });
    expect(await err(download(U.hr, pay.version_id, await session(U.hr)))).toMatchObject({ message: "not_found" });
    await q(U.r1a, `SELECT * FROM authz.step_up_dev($1, 10)`, [s1]);
    const ok = await download(U.r1a, pay.version_id, s1);
    expect(ok).toMatchObject({ outcome: "ok", classification: "restricted" });
    // Another session of the same user has no grant.
    expect((await download(U.r1a, pay.version_id, await session(U.r1a))).outcome).toBe("step_up_required");

    const log = await q<{ user_id: string; level: string; step_up_grant_id: string | null; version: number }>(U.acct,
      `SELECT user_id, level, step_up_grant_id, version FROM eureka.datahub_access WHERE folder_id = $1`, [F["Payroll exports"]]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ user_id: U.r1a, level: "restricted", version: 1 });
    expect(log[0]!.step_up_grant_id).not.toBeNull();
    // hr manages every folder (org scope) and sees the log; readers do not.
    expect((await q(U.hr, `SELECT id FROM eureka.datahub_access WHERE folder_id = $1`, [F["Payroll exports"]])).length).toBe(1);
    expect(await q(U.r1a, `SELECT id FROM eureka.datahub_access`)).toEqual([]);
    expect(await q(U.locD, `SELECT id FROM eureka.datahub_access WHERE folder_id = $1`, [F["Payroll exports"]])).toEqual([]);
    expect((await q(U.admin, `SELECT id FROM eureka.datahub_access`)).length).toBeGreaterThanOrEqual(2); // audit:read
  });

  it("a subfolder of a restricted folder is readable only by the parent's members", async () => {
    const f = await upload(U.acct, F["Payroll 2026"]!, "Q1.pdf");
    expect((await q(U.r1a, `SELECT id FROM eureka.datahub_file WHERE id = $1`, [f.file_id])).length).toBe(1);
    expect((await q(U.r2a, `SELECT id FROM eureka.datahub_file WHERE id = $1`, [f.file_id])).length).toBe(0);
  });

  it("delete: the uploader of every version or a manager; soft delete hides the file", async () => {
    const id = await createFolder(U.hr, { name: "Team uploads", level: "internal", upload: true });
    const mine = await upload(U.r1a, id, "Mine.pdf");
    const shared = await upload(U.r1a, id, "Shared.pdf");
    await upload(U.r2a, id, "shared.pdf");
    expect(await err(q(U.r2a, `SELECT authz.datahub_delete_file($1)`, [mine.file_id]))).toMatchObject({ message: "not_permitted" });
    expect(await err(q(U.r1a, `SELECT authz.datahub_delete_file($1)`, [shared.file_id]))).toMatchObject({ message: "not_permitted" });
    await q(U.r1a, `SELECT authz.datahub_delete_file($1)`, [mine.file_id]);
    await q(U.hr, `SELECT authz.datahub_delete_file($1)`, [shared.file_id]);
    expect(await q(U.hr, `SELECT id FROM eureka.datahub_file WHERE folder_id = $1`, [id])).toEqual([]);
    expect(await err(q(U.hr, `SELECT authz.datahub_delete_file($1)`, [shared.file_id]))).toMatchObject({ message: "not_found" });
    // A new upload of a deleted name starts a new file at version 1.
    expect((await upload(U.r1a, id, "Mine.pdf")).version).toBe(1);
  });

  it("guards keep versions append-only and file rows' identity fixed", async () => {
    const f = await upload(U.hr, F["Company policies"]!, "Guarded.pdf");
    expect(await err(db.admin.query(`UPDATE eureka.datahub_file_version SET version = 9 WHERE id = $1`, [f.version_id]))).toMatchObject({ code: "42501" });
    expect(await err(db.admin.query(`DELETE FROM eureka.datahub_file WHERE id = $1`, [f.file_id]))).toMatchObject({ code: "42501" });
    expect(await err(q(U.hr, `UPDATE eureka.datahub_file SET name = 'x.pdf' WHERE id = $1`, [f.file_id]))).toMatchObject({ code: "42501" });
  });
});

describe("review fixes: levels never weaken below the parent; locks; membership rows", () => {
  const raw = (sql: string, params: unknown[] = []) => db.admin.query(sql, params).then((r) => r.rows);

  it("a subfolder below its parent's level is refused on create and update; a parent is not raised above a live subfolder", async () => {
    const par = await createFolder(U.hr, { name: "Lvl parent", level: "restricted", members: [U.hr, U.r1a] });
    expect(await err(createFolder(U.hr, { parent: par, name: "weak", level: "internal" }))).toMatchObject({ message: "level_below_parent" });
    expect(await err(createFolder(U.hr, { parent: par, name: "weak2", level: "confidential", roles: ["hr"] }))).toMatchObject({ message: "level_below_parent" });
    const sub = await createFolder(U.hr, { parent: par, name: "strong", level: "restricted", members: [U.hr, U.r1a] });
    expect(await err(q(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"level":"internal"}', '{}')`, [sub]))).toMatchObject({ message: "level_below_parent" });
    const par2 = await createFolder(U.hr, { name: "Lvl parent2", level: "internal" });
    const sub2 = await createFolder(U.hr, { parent: par2, name: "kid", level: "internal" });
    expect(await err(q(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"level":"restricted"}', $2)`, [par2, [U.hr]]))).toMatchObject({ message: "subfolder_level_below" });
    // Raise the subfolder first, then the parent.
    await q(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"level":"restricted"}', $2)`, [sub2, [U.hr]]);
    await q(U.hr, `SELECT authz.datahub_update_folder($1, 1, '{"level":"restricted"}', $2)`, [par2, [U.hr]]);
  });

  it("even a forced weaker subfolder uses the effective level: restricted storage, step-up, logged level", async () => {
    const par = await createFolder(U.hr, { name: "Secret", level: "restricted", members: [U.hr, U.r1a] });
    const sub = await createFolder(U.hr, { parent: par, name: "Secret sub", level: "restricted", members: [U.hr, U.r1a] });
    // Simulate legacy/forced data (superuser, triggers off): the subfolder row is internal.
    await db.admin.query("BEGIN");
    await db.admin.query("SET LOCAL session_replication_role = replica");
    await db.admin.query(`UPDATE eureka.datahub_folder SET level = 'internal' WHERE id = $1`, [sub]);
    await db.admin.query("COMMIT");
    const up = await upload(U.hr, sub, "Forced.pdf");
    expect(up.classification).toBe("restricted");
    expect((await raw(`SELECT level FROM eureka.audit_event, LATERAL (SELECT changes->>'level' AS level) l WHERE action = 'datahub.upload_requested' AND entity_id = $1`, [up.file_id]))[0].level).toBe("restricted");
    await finish(up.file_object_id, "clean", "NO_THREATS_FOUND", SHA, 1000);
    const s = await session(U.r1a);
    expect((await download(U.r1a, up.version_id, s)).outcome).toBe("step_up_required");
    await q(U.r1a, `SELECT * FROM authz.step_up_dev($1, 10)`, [s]);
    expect(await download(U.r1a, up.version_id, s)).toMatchObject({ outcome: "ok", classification: "restricted" });
    expect((await raw(`SELECT level FROM eureka.datahub_access WHERE version_id = $1`, [up.version_id]))[0].level).toBe("restricted");
  });

  it("an upload into a deleted folder is refused (the folder row is locked and re-read)", async () => {
    const id = await createFolder(U.hr, { name: "Soon gone", level: "internal" });
    await q(U.hr, `SELECT authz.datahub_delete_folder($1, 1)`, [id]);
    expect(await err(upload(U.hr, id, "late.pdf"))).toMatchObject({ message: "not_found" });
    // A concurrent delete waits for an upload in flight (FOR SHARE vs FOR UPDATE).
    const id2 = await createFolder(U.hr, { name: "Racing", level: "internal" });
    const c1 = await db.app.connect();
    const c2 = await db.app.connect();
    try {
      await c1.query("BEGIN"); await c1.query("SELECT set_config('eureka.user_id', $1, true)", [U.hr]);
      await c1.query(`SELECT * FROM authz.datahub_create_upload($1, 'a.pdf', $2, 10)`, [id2, PDF]);
      await c2.query("BEGIN"); await c2.query("SELECT set_config('eureka.user_id', $1, true)", [U.hr]);
      await c2.query("SET LOCAL lock_timeout = '300ms'");
      await expect(c2.query(`SELECT authz.datahub_delete_folder($1, 1)`, [id2])).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await c2.query("ROLLBACK").catch(() => undefined); await c1.query("ROLLBACK").catch(() => undefined);
      c1.release(); c2.release();
    }
  });

  it("membership rows are visible only for folders the user can see", async () => {
    const id = await createFolder(U.hr, { name: "Gone member", level: "restricted", members: [U.hr, U.r2a] });
    expect((await q(U.r2a, `SELECT folder_id FROM eureka.datahub_folder_member WHERE folder_id = $1`, [id])).length).toBe(1);
    // r2a goes inactive-staff-equivalent: lose the role entirely, the row must not leak.
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(now() - interval '2 days', now() - interval '1 day') WHERE user_id = $1`, [U.r2a]);
    try {
      expect(await q(U.r2a, `SELECT folder_id FROM eureka.datahub_folder_member`)).toEqual([]);
    } finally {
      await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(now() - interval '1 day', NULL) WHERE user_id = $1`, [U.r2a]);
    }
  });
});

describe("audit (rule 5)", () => {
  it("datahub audit rows hold ids, levels and counts: never folder names, file names or descriptions", async () => {
    await createFolder(U.hr, { name: "Secret project Zephyr", description: "Board minutes about Zephyr", level: "internal" });
    const rows = (await db.admin.query<{ action: string; changes: unknown }>(
      `SELECT action, changes FROM eureka.audit_event WHERE action LIKE 'datahub.%'`)).rows;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["datahub.folder_created", "datahub.folder_updated", "datahub.folder_deleted", "datahub.member_added",
      "datahub.member_removed", "datahub.upload_requested", "datahub.file_deleted", "datahub.downloaded", "datahub.viewed",
      "datahub.view_refused"]) expect(actions, a).toContain(a);
    const text = JSON.stringify(rows);
    for (const s of ["Zephyr", "Company policies", "Payroll", "Leave policy", "Holidays", "June", "July", "Mine.pdf", "Shared", ".pdf"]) {
      expect(text).not.toContain(s);
    }
  });
});
