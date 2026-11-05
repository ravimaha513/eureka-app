import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db-harness.js";

/**
 * Catalog-wide lint of the migrated database (R-26; docs/backend-audit/architecture.md G-11, G-09,
 * G-10). Hardening used to be asserted feature by feature against hard-coded name lists, so drift
 * outside them went unnoticed. These checks run over every table and function in authz and eureka;
 * an exception needs an entry below with its reason. Column-level grants on person, candidate and
 * job, and the behaviour behind them, stay in db-least-privilege.db.int.test.ts.
 */
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db?.drop());

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows as T[];
const SCHEMAS = `('authz'::regnamespace, 'eureka'::regnamespace)`;
const RUNTIME_ROLES = ["eureka_app", "eureka_worker", "eureka_portal", "eureka_import"];

/**
 * Tables without RLS enabled and forced (rule 3, design "RLS on all sensitive tables"). Two kinds:
 * org directory and reference data every signed-in user may read (no row is private), and authz
 * internals no runtime role can touch at all (only definer functions reach them).
 */
const NO_RLS_DIRECTORY: Record<string, string> = {
  "eureka.location": "reference data; written by authz.admin_create_location / admin_rename_location",
  "eureka.app_user": "staff directory; eureka_app may update google_sub only (first SSO sign-in links the account)",
  "eureka.role": "role catalog, seeded from packages/shared",
  "eureka.role_permission": "role catalog, seeded from packages/shared",
  "eureka.permission": "permission catalog, seeded from packages/shared",
  "eureka.team": "org structure",
  "eureka.team_member": "org structure",
  "eureka.department": "org structure",
  "eureka.reporting_line": "org structure; written by admin definers",
  "eureka.reporting_closure": "org structure; rebuilt by eureka.rebuild_reporting_closure",
  "eureka.coach_assignment": "org structure; written by authz.assign_coach / unassign_coach",
  "eureka.technology": "reference data",
  "eureka.client": "reference data; written by authz.create_client",
  "eureka.vendor": "reference data; written by authz.create_vendor",
  "eureka.implementation_partner": "reference data",
  "authz.document_type": "reference data (document kinds and their restriction flags)",
  "eureka.session": "server-side sessions: written by the API before any user context exists, never listed",
  "eureka.user_role": "who holds which role (column-level SELECT for the API and worker); written by role definers only",
};
const NO_RLS_INTERNAL: Record<string, string> = {
  "authz.policy_setting": "policy switches, read by definers",
  "authz.placement_status_context": "transaction-local context of authz.transition_placement",
  "authz.employment_team_context": "transaction-local context of the employment definers",
  "authz.checklist_template": "read by checklist definers",
  "authz.rate_window": "shared rate-limit windows (0486); only authz.rate_take / rate_purge (definers) touch it, keys stored hashed",
  "authz.user_credential": "password hashes; password_* definers only",
  "authz.password_setup_token": "token hashes; password_setup_* definers only",
  "authz.reporting_closure_pending": "deferred closure rebuild queue",
};

/**
 * Table-wide (not column-level) INSERT / UPDATE / DELETE / TRUNCATE held by a runtime role: a
 * snapshot, so every such grant shows up in review. Sensitive writes go through SECURITY DEFINER
 * functions (rule 6); a table-wide INSERT is acceptable only where a BEFORE INSERT guard sets the
 * server-managed columns (rule 4).
 */
const TABLE_WIDE_WRITES: Record<string, string> = {
  "eureka_app eureka.audit_event INSERT": "append-only audit; ids and keys only (rule 5)",
  "eureka_app eureka.session INSERT": "sign-in creates the server-side session",
  "eureka_app eureka.submission INSERT": "submission_insert_guard sets snapshots and status (0019)",
  "eureka_app eureka.interview INSERT": "interview snapshot guard sets server-managed columns (0019)",
  "eureka_app eureka.hotlist_view DELETE": "a user's own saved views (RLS by owner)",
  "eureka_app eureka.course DELETE": "training catalog (RLS: training:manage)",
  "eureka_app eureka.course_module DELETE": "training catalog (RLS: training:manage)",
  "eureka_app eureka.batch_course DELETE": "training catalog (RLS: training:manage)",
  "eureka_app eureka.notification_preference DELETE": "a user's own preferences (RLS by owner)",
  "eureka_app eureka.calendar_connection DELETE": "a user's own calendar link (RLS by owner)",
  "eureka_portal eureka.audit_event INSERT": "append-only audit (rule 5)",
  "eureka_worker eureka.audit_event INSERT": "append-only audit (rule 5)",
  "eureka_worker eureka.job_run INSERT": "worker job ledger",
  "eureka_worker eureka.audit_export INSERT": "audit export batches",
  "eureka_worker eureka.outbox_event DELETE": "outbox retention",
  "eureka_worker eureka.idempotency_key DELETE": "idempotency key expiry",
  "eureka_worker eureka.notification DELETE": "notification retention",
};

/**
 * SECURITY DEFINER functions callable by more than one role (rule 2: EXECUTE to exactly the needed
 * role). Everything else is granted to at most one role besides its owner. Mostly the RLS scope
 * helpers, which policies evaluate as whichever role queries the table.
 */
const RLS_HELPER = ["eureka_app", "eureka_owner", "eureka_worker"];
const MULTI_ROLE_DEFINERS: Record<string, string[]> = {
  "authz.current_user_id()": RLS_HELPER,
  "authz.grants(text)": RLS_HELPER,
  "authz.has_perm(text)": RLS_HELPER,
  "authz.has_org(text)": RLS_HELPER,
  "authz.recruiter_ids(text)": RLS_HELPER,
  "authz.team_ids(text)": RLS_HELPER,
  "authz.location_ids(text)": RLS_HELPER,
  "authz.all_teams(text)": RLS_HELPER,
  "authz.owns(text,uuid,uuid,uuid)": RLS_HELPER,
  "authz.candidate_visible(uuid,text)": RLS_HELPER,
  "authz.candidate_owned(uuid,text)": RLS_HELPER,
  "authz.actor_team()": RLS_HELPER,
  "authz.owned_team_ids(text)": RLS_HELPER,
  "authz.coached_team_ids(text)": RLS_HELPER,
  "authz.submission_closed(uuid)": RLS_HELPER,
  "authz.feedback_kind_allowed(uuid,text)": RLS_HELPER,
  // Guard / trigger functions fired by writes of the API, the worker and the owner's migrations.
  "authz.submission_snapshot()": RLS_HELPER,
  "authz.interview_snapshot()": RLS_HELPER,
  "authz.transition_submission(uuid,text,text)": RLS_HELPER,
  "authz.is_interview_coach(uuid)": ["eureka_app", "eureka_owner"],
  "authz.user_has_trait(uuid,text)": ["eureka_app", "eureka_import", "eureka_owner", "eureka_worker"],
  // Triggers on org tables written by admin definers (authz_definer) and by the API / worker.
  "eureka.rebuild_reporting_closure()": ["authz_definer", "eureka_app", "eureka_worker"],
  "eureka.bump_access_version()": ["authz_definer", "eureka_app", "eureka_worker"],
  "eureka.candidate_team_invariant()": ["authz_definer", "eureka_app", "eureka_worker"],
};

/** CHECK constraints allowed to stay NOT VALID on a fresh database (0484 validated the last ones). */
const NOT_VALID_CHECKS: Record<string, string> = {};

describe("catalog lint: row-level security", () => {
  it("every authz / eureka table has RLS enabled and forced, or a listed reason", async () => {
    const missing = await rows<{ t: string }>(
      `SELECT c.oid::regclass::text AS t FROM pg_class c
        WHERE c.relnamespace IN ${SCHEMAS} AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        ORDER BY 1`);
    expect(missing.map((r) => r.t).sort()).toEqual(Object.keys({ ...NO_RLS_DIRECTORY, ...NO_RLS_INTERNAL }).sort());
  });

  it("no table has RLS enabled but not forced (the owner would bypass it)", async () => {
    expect(await rows(`SELECT c.oid::regclass::text AS t FROM pg_class c
      WHERE c.relnamespace IN ${SCHEMAS} AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity`)).toEqual([]);
  });

  it("internal tables without RLS are out of reach of every runtime role", async () => {
    const reach = await rows<{ x: string }>(
      `SELECT r || ' ' || t AS x FROM unnest($1::text[]) t CROSS JOIN unnest($2::text[]) r
        WHERE has_table_privilege(r, t, 'SELECT') OR has_any_column_privilege(r, t, 'SELECT')
           OR has_any_column_privilege(r, t, 'INSERT') OR has_any_column_privilege(r, t, 'UPDATE')
           OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE')`,
      [Object.keys(NO_RLS_INTERNAL), RUNTIME_ROLES]);
    expect(reach).toEqual([]);
  });

  it("directory tables without RLS are read-only for the worker, portal and import roles", async () => {
    const writes = await rows<{ x: string }>(
      `SELECT r || ' ' || t AS x FROM unnest($1::text[]) t CROSS JOIN unnest($2::text[]) r
        WHERE has_any_column_privilege(r, t, 'INSERT') OR has_any_column_privilege(r, t, 'UPDATE')
           OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE')`,
      [Object.keys(NO_RLS_DIRECTORY), RUNTIME_ROLES.filter((r) => r !== "eureka_app")]);
    expect(writes).toEqual([]);
  });
});

describe("catalog lint: table privileges", () => {
  it("table-wide writes by runtime roles are exactly the reviewed list", async () => {
    const got = await rows<{ x: string }>(
      `SELECT r.rolname || ' ' || c.oid::regclass::text || ' ' || p AS x
         FROM pg_class c CROSS JOIN pg_roles r CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
        WHERE c.relnamespace IN ${SCHEMAS} AND c.relkind IN ('r', 'p') AND r.rolname = ANY ($1) AND has_table_privilege(r.oid, c.oid, p)`,
      [RUNTIME_ROLES]);
    expect(got.map((r) => r.x).sort()).toEqual(Object.keys(TABLE_WIDE_WRITES).sort());
  });

  it("no runtime role holds a table-wide UPDATE anywhere (column grants only)", async () => {
    expect(Object.keys(TABLE_WIDE_WRITES).filter((k) => k.endsWith(" UPDATE"))).toEqual([]);
  });

  it("no runtime role is superuser, bypasses RLS or owns an authz / eureka object", async () => {
    expect(await rows(`SELECT rolname FROM pg_roles WHERE rolname = ANY ($1) AND (rolsuper OR rolbypassrls)`, [RUNTIME_ROLES])).toEqual([]);
    expect(await rows(
      `SELECT c.oid::regclass::text AS o FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relnamespace IN ${SCHEMAS} AND r.rolname = ANY ($1)
       UNION ALL
       SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace IN ${SCHEMAS} AND r.rolname = ANY ($1)`, [RUNTIME_ROLES])).toEqual([]);
  });
});

describe("catalog lint: functions", () => {
  it("every SECURITY DEFINER function pins search_path to pg_catalog, pg_temp", async () => {
    expect(await rows(
      `SELECT p.oid::regprocedure::text AS f, p.proconfig FROM pg_proc p
        WHERE p.pronamespace IN ${SCHEMAS} AND p.prosecdef
          AND NOT coalesce('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false)`)).toEqual([]);
  });

  it("no authz / eureka function is executable by PUBLIC", async () => {
    expect(await rows(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p
        WHERE p.pronamespace IN ${SCHEMAS} AND has_function_privilege('public', p.oid, 'EXECUTE')`)).toEqual([]);
  });

  it("every SECURITY DEFINER function is owned by authz_definer or eureka_owner", async () => {
    expect(await rows(
      `SELECT p.oid::regprocedure::text AS f, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
        WHERE p.pronamespace IN ${SCHEMAS} AND p.prosecdef AND pg_get_userbyid(p.proowner) NOT IN ('authz_definer', 'eureka_owner')`)).toEqual([]);
  });

  it("every SECURITY DEFINER function is executable by at most one role besides its owner, or a listed set", async () => {
    const got = await rows<{ f: string; roles: string[] }>(
      `SELECT p.oid::regprocedure::text AS f, array_agg(r.rolname::text ORDER BY r.rolname) AS roles
         FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE p.pronamespace IN ${SCHEMAS} AND p.prosecdef AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
        GROUP BY p.oid`);
    const multi = Object.fromEntries(got.filter((g) => g.roles.length > 1).map((g) => [g.f, g.roles]));
    expect(multi).toEqual(MULTI_ROLE_DEFINERS);
    const known = new Set([...RUNTIME_ROLES, "eureka_owner", "authz_definer"]);
    expect(got.filter((g) => g.roles.some((r) => !known.has(r)))).toEqual([]);
  });
});

describe("catalog lint: constraints (G-09, G-10)", () => {
  it("every CHECK constraint in authz / eureka is validated", async () => {
    const got = await rows<{ c: string }>(
      `SELECT conrelid::regclass::text || ' ' || conname AS c FROM pg_constraint
        WHERE connamespace IN ${SCHEMAS} AND contype = 'c' AND NOT convalidated`);
    expect(got.map((r) => r.c).sort()).toEqual(Object.keys(NOT_VALID_CHECKS).sort());
  });

  it("core free-text and contact columns carry their length / control-character CHECK (0484)", async () => {
    const got = await rows<{ c: string }>(
      `SELECT conrelid::regclass::text || ' ' || conname AS c FROM pg_constraint WHERE contype = 'c' AND conname = ANY ($1)`,
      [["person_first_name_text", "person_last_name_text", "person_personal_email_shape", "candidate_marketing_email_shape",
        "candidate_vitel_number_text", "submission_job_title_text", "app_user_display_name_text", "app_user_designation_text"]]);
    expect(got.map((r) => r.c).sort()).toEqual([
      "eureka.app_user app_user_designation_text", "eureka.app_user app_user_display_name_text",
      "eureka.candidate candidate_marketing_email_shape", "eureka.candidate candidate_vitel_number_text",
      "eureka.person person_first_name_text", "eureka.person person_last_name_text", "eureka.person person_personal_email_shape",
      "eureka.submission submission_job_title_text",
    ]);
  });

  /** Inserts one row as the superuser with triggers off, so only the CHECKs decide. */
  const insert = async (table: string, values: Record<string, unknown>) => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const cols = Object.keys(values);
      await c.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(values));
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  };
  const person = (o: Record<string, unknown>) => insert("eureka.person", { first_name: "Ok", last_name: "Name", ...o });
  const user = (o: Record<string, unknown>) => insert("eureka.app_user", { email: "lint@eureka.example", display_name: "Ok", ...o });

  it.each<[string, () => Promise<void>]>([
    ["a newline in person.first_name", () => person({ first_name: "A\nB" })],
    ["an empty person.first_name", () => person({ first_name: "" })],
    ["an 81-character person.last_name", () => person({ last_name: "x".repeat(81) })],
    ["a space in person.personal_email", () => person({ personal_email: "two words@example.com" })],
    ["a person.personal_email without @", () => person({ personal_email: "no-at-sign.example.com" })],
    ["a 262-character person.personal_email", () => person({ personal_email: `${"a".repeat(250)}@example.com` })],
    ["a tab in app_user.display_name", () => user({ display_name: "Tab\tName" })],
    ["a 121-character app_user.designation", () => user({ designation: "z".repeat(121) })],
  ])("rejects %s", async (_, write) => {
    await expect(write()).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts the longest values the API accepts", async () => {
    await expect(person({ first_name: "x".repeat(80), last_name: "O'Brien-Núñez", personal_email: `${"a".repeat(240)}@example.com` }))
      .resolves.toBeUndefined();
    await expect(user({ display_name: "y".repeat(120), designation: "d".repeat(120) })).resolves.toBeUndefined();
  });
});
