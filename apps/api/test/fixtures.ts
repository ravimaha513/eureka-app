import type pg from "pg";
import type { Role, UserAccess, CandidateRef } from "@eureka/shared";

/**
 * Fictional org used by integration tests. The TypeScript view of access
 * (toUserAccess) is derived from these definitions, NOT from the database,
 * so the differential tests compare two independent implementations.
 *
 * Hierarchy: ceo <- om <- ad <- m1 <- l1 <- {r1a, r1b}
 *                                  m1 <- l2 <- {r2a}
 *                           ad <- m2 <- l3 <- {r3a}
 */
export const LOC = { dallas: "00000000-0000-0000-0000-00000000d001", austin: "00000000-0000-0000-0000-00000000a001" };

type UserDef = { id: string; roles: { role: Role; location?: keyof typeof LOC }[]; manager?: string };
const uid = (n: number) => `00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;

export const U = {
  ceo: uid(1), om: uid(2), ad: uid(3), m1: uid(4), m2: uid(5),
  l1: uid(6), l2: uid(7), l3: uid(8), r1a: uid(9), r1b: uid(10), r2a: uid(11), r3a: uid(12),
  coach: uid(13), locD: uid(14), locA: uid(15), hr: uid(16), acct: uid(17), admin: uid(18), imm: uid(19),
};

export const USERS: Record<keyof typeof U, UserDef> = {
  ceo: { id: U.ceo, roles: [{ role: "ceo" }] },
  om: { id: U.om, roles: [{ role: "offshore_manager" }], manager: U.ceo },
  ad: { id: U.ad, roles: [{ role: "assoc_director" }], manager: U.om },
  m1: { id: U.m1, roles: [{ role: "manager" }], manager: U.ad },
  m2: { id: U.m2, roles: [{ role: "manager" }], manager: U.ad },
  l1: { id: U.l1, roles: [{ role: "lead" }], manager: U.m1 },
  l2: { id: U.l2, roles: [{ role: "lead" }], manager: U.m1 },
  l3: { id: U.l3, roles: [{ role: "lead" }], manager: U.m2 },
  r1a: { id: U.r1a, roles: [{ role: "recruiter" }], manager: U.l1 },
  r1b: { id: U.r1b, roles: [{ role: "recruiter" }], manager: U.l1 },
  r2a: { id: U.r2a, roles: [{ role: "recruiter" }], manager: U.l2 },
  r3a: { id: U.r3a, roles: [{ role: "recruiter" }], manager: U.l3 },
  coach: { id: U.coach, roles: [{ role: "interview_coach" }] },
  locD: { id: U.locD, roles: [{ role: "location_ops_admin", location: "dallas" }] },
  locA: { id: U.locA, roles: [{ role: "location_incharge", location: "austin" }] },
  hr: { id: U.hr, roles: [{ role: "hr" }] },
  acct: { id: U.acct, roles: [{ role: "accounts" }] },
  admin: { id: U.admin, roles: [{ role: "org_admin" }] },
  imm: { id: U.imm, roles: [{ role: "immigration" }] },
};

export const T = { t1: uid(101), t2: uid(102), t3: uid(103) };
export const TEAMS = [
  { id: T.t1, name: "Team Rohit", lead: U.l1, members: [U.r1a, U.r1b] },
  { id: T.t2, name: "Team Anjali", lead: U.l2, members: [U.r2a] },
  { id: T.t3, name: "Team Vikram", lead: U.l3, members: [U.r3a] },
];
export const COACHING = [{ coach: U.coach, team: T.t2 }];

const managerOf = new Map(Object.values(USERS).filter((u) => u.manager).map((u) => [u.id, u.manager!]));

function subordinatesOf(userId: string): string[] {
  const out: string[] = [];
  for (const [child] of managerOf) {
    let m = managerOf.get(child);
    while (m) {
      if (m === userId) { out.push(child); break; }
      m = managerOf.get(m);
    }
  }
  return out;
}

export function toUserAccess(key: keyof typeof U): UserAccess {
  const def = USERS[key];
  const subs = subordinatesOf(def.id);
  const teamIds = TEAMS.filter((t) => t.lead === def.id || t.members.includes(def.id)).map((t) => t.id);
  return {
    userId: def.id,
    roles: def.roles.map((r) => ({ role: r.role, locationId: r.location ? LOC[r.location] : undefined })),
    teamIds,
    subordinateUserIds: subs,
    subtreeTeamIds: TEAMS.filter((t) => t.lead === def.id || subs.includes(t.lead)).map((t) => t.id),
    coachedTeamIds: COACHING.filter((c) => c.coach === def.id).map((c) => c.team),
  };
}

export interface FixtureCandidate extends CandidateRef { id: string }

export const TECH_ID = uid(501);
export const CLIENT_ID = uid(601);

/** Seeds org, users, teams and a combinatorial set of candidates (as superuser). */
export async function seedFixtures(admin: pg.Pool): Promise<FixtureCandidate[]> {
  await admin.query(`INSERT INTO eureka.location (id, name, kind) VALUES ($1,'Dallas','training'),($2,'Austin','training')`, [LOC.dallas, LOC.austin]);
  await admin.query(`INSERT INTO eureka.technology (id, name) VALUES ($1,'Java')`, [TECH_ID]);
  await admin.query(`INSERT INTO eureka.client (id, name) VALUES ($1,'Northwind Financial')`, [CLIENT_ID]);
  for (const [key, u] of Object.entries(USERS)) {
    await admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1,$2,$3)`, [u.id, `${key}@eureka.example`, key]);
  }
  for (const u of Object.values(USERS)) {
    for (const r of u.roles) {
      await admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1,$2,$3)`,
        [u.id, r.role, r.location ? LOC[r.location] : null]);
    }
  }
  for (const u of Object.values(USERS)) {
    if (u.manager) await admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1,$2)`, [u.id, u.manager]);
  }
  for (const t of TEAMS) {
    await admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ($1,$2,$3)`, [t.id, t.name, t.lead]);
    for (const m of t.members) await admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [t.id, m]);
  }
  for (const c of COACHING) await admin.query(`INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1,$2)`, [c.coach, c.team]);

  const recruitersByTeam: Record<string, (string | null)[]> = {
    [T.t1]: [U.r1a, U.r1b, null], [T.t2]: [U.r2a, null], [T.t3]: [U.r3a, null],
  };
  const out: FixtureCandidate[] = [];
  let n = 0;
  for (const [teamId, recs] of Object.entries(recruitersByTeam)) {
    for (const recruiterId of recs) for (const locationId of [LOC.dallas, LOC.austin])
      for (const visibility of ["team", "all_teams"] as const)
        for (const marketingStatus of ["active", "on_hold", "full_of_interviews"]) {
          n++;
          const p = await admin.query<{ id: string }>(
            `INSERT INTO eureka.person (first_name, last_name, phone_e164) VALUES ($1,$2,$3) RETURNING id`,
            [`Cand${n}`, "Test", `+1469555${n.toString().padStart(4, "0")}`]);
          const c = await admin.query<{ id: string }>(
            `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility, marketing_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [p.rows[0]!.id, TECH_ID, teamId, recruiterId, locationId, visibility, marketingStatus]);
          out.push({ id: c.rows[0]!.id, teamId, recruiterId, locationId, visibility, marketingStatus });
        }
  }
  // Remaining statuses (other Hot List statuses and non-Hot-List ones), appended
  // after the main grid so tests that pick "the first matching candidate" are stable.
  for (const [teamId, recs] of Object.entries(recruitersByTeam)) {
    for (const recruiterId of [recs[0]!, null])
      for (const visibility of ["team", "all_teams"] as const)
        for (const marketingStatus of ["bench", "stopped", "confirmation", "placed", "in_training", "terminated"]) {
          n++;
          const locationId = n % 2 ? LOC.dallas : LOC.austin;
          const p = await admin.query<{ id: string }>(
            `INSERT INTO eureka.person (first_name, last_name, phone_e164) VALUES ($1,$2,$3) RETURNING id`,
            [`Cand${n}`, "Test", `+1469555${n.toString().padStart(4, "0")}`]);
          const c = await admin.query<{ id: string }>(
            `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility, marketing_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [p.rows[0]!.id, TECH_ID, teamId, recruiterId, locationId, visibility, marketingStatus]);
          out.push({ id: c.rows[0]!.id, teamId, recruiterId, locationId, visibility, marketingStatus });
        }
  }
  return out;
}
