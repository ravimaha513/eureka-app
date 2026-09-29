import { describe, expect, it } from "vitest";
import { GRANTS, PERMISSIONS, ROLES, LOCATION_ROLES, RESTRICTED_PERMISSIONS } from "./catalog.js";
import {
  activityVisible,
  applyCandidateFieldPolicy,
  candidateVisible,
  capabilities,
  hotlistVisible,
  resolveScope,
  type CandidateRef,
  type UserAccess,
} from "./engine.js";

// Fixture org: manager M leads nothing directly but has leads L1 (team T1) and L2 (team T2).
// Recruiters R1a, R1b in T1; R2a in T2. Location Dallas = LOC_D.
const LOC_D = "loc-dallas";
const LOC_A = "loc-austin";

const base = (over: Partial<UserAccess> & Pick<UserAccess, "userId" | "roles">): UserAccess => ({
  teamIds: [],
  subordinateUserIds: [],
  subtreeTeamIds: [],
  coachedTeamIds: [],
  ...over,
});

const R1a = base({ userId: "R1a", roles: [{ role: "recruiter" }], teamIds: ["T1"] });
const L1 = base({ userId: "L1", roles: [{ role: "lead" }], teamIds: ["T1"], subordinateUserIds: ["R1a", "R1b"], subtreeTeamIds: ["T1"] });
const M = base({ userId: "M", roles: [{ role: "manager" }], subordinateUserIds: ["L1", "L2", "R1a", "R1b", "R2a"], subtreeTeamIds: ["T1", "T2"] });
const LOCADM = base({ userId: "LA", roles: [{ role: "location_ops_admin", locationId: LOC_D }] });
const COACH = base({ userId: "C", roles: [{ role: "interview_coach" }], coachedTeamIds: ["T2"] });
const HR = base({ userId: "H", roles: [{ role: "hr" }] });
const ADMIN = base({ userId: "A", roles: [{ role: "org_admin" }] });

const cand = (over: Partial<CandidateRef>): CandidateRef => ({
  recruiterId: "R1b",
  teamId: "T1",
  locationId: LOC_D,
  visibility: "team",
  marketingStatus: "active",
  ...over,
});

describe("catalog integrity", () => {
  it("every grant references a known permission", () => {
    for (const role of ROLES) {
      for (const p of Object.keys(GRANTS[role])) expect(PERMISSIONS).toContain(p);
    }
  });

  it("location scope is only granted to location-bound roles", () => {
    for (const role of ROLES) {
      const usesLocation = Object.values(GRANTS[role]).includes("location");
      expect(usesLocation).toBe(LOCATION_ROLES.includes(role));
    }
  });

  it("org_admin holds no data permissions (no self-escalation into data)", () => {
    expect(Object.keys(GRANTS.org_admin).sort()).toEqual(["access:manage", "audit:read"]);
  });

  it("restricted permissions are held only by HR, Accounts and Immigration", () => {
    for (const role of ROLES) {
      const holds = RESTRICTED_PERMISSIONS.filter((p) => GRANTS[role][p]);
      if (holds.length) expect(["hr", "accounts", "immigration"]).toContain(role);
    }
  });

  it("no Sales role can read DOB or restricted documents", () => {
    for (const role of ["recruiter", "lead", "manager", "assoc_director", "offshore_manager", "ceo"] as const) {
      expect(GRANTS[role]["candidate.dob:read"]).toBeUndefined();
      expect(GRANTS[role]["document.restricted:read"]).toBeUndefined();
    }
  });
});

describe("resolveScope", () => {
  it("denies when the role has no grant", () => {
    expect(resolveScope(ADMIN, "candidate:read")).toBeNull();
    expect(resolveScope(R1a, "rate:read")).toBeNull();
  });

  it("recruiter team scope includes the recruiter's team, not only themselves (judge issue 1)", () => {
    const s = resolveScope(R1a, "candidate:read")!;
    expect([...s.teamIds]).toEqual(["T1"]);
    expect(s.recruiterIds.has("R1a")).toBe(true);
    expect(s.allTeams).toBe(true);
  });

  it("recruiter update scope is own only", () => {
    const s = resolveScope(R1a, "candidate:update")!;
    expect([...s.recruiterIds]).toEqual(["R1a"]);
    expect(s.teamIds.size).toBe(0);
  });

  it("manager hierarchy includes subordinates and their teams", () => {
    const s = resolveScope(M, "candidate:read")!;
    expect(s.recruiterIds).toEqual(new Set(["M", "L1", "L2", "R1a", "R1b", "R2a"]));
    expect(s.teamIds).toEqual(new Set(["T1", "T2"]));
  });

  it("location role requires a location id", () => {
    const bad = base({ userId: "X", roles: [{ role: "location_incharge" }] });
    expect(() => resolveScope(bad, "candidate:read")).toThrow(/requires a location/);
  });

  it("non-Sales roles never get the all-teams rule", () => {
    expect(resolveScope(LOCADM, "candidate:read")!.allTeams).toBe(false);
    expect(resolveScope(COACH, "candidate:read")!.allTeams).toBe(false);
    expect(resolveScope(HR, "candidate:read")!.allTeams).toBe(false);
  });

  it("multiple roles union their scopes", () => {
    const both = base({ userId: "Z", roles: [{ role: "recruiter" }, { role: "location_ops_admin", locationId: LOC_A }], teamIds: ["T2"] });
    const s = resolveScope(both, "candidate:read")!;
    expect(s.teamIds.has("T2")).toBe(true);
    expect(s.locationIds.has(LOC_A)).toBe(true);
  });
});

describe("candidateVisible", () => {
  it("recruiter sees a teammate's candidate", () => {
    expect(candidateVisible(resolveScope(R1a, "candidate:read"), cand({}))).toBe(true);
  });

  it("recruiter does not see another team's team-only candidate", () => {
    expect(candidateVisible(resolveScope(R1a, "candidate:read"), cand({ recruiterId: "R2a", teamId: "T2" }))).toBe(false);
  });

  it("recruiter sees another team's Open-to-all-teams candidate only while marketable", () => {
    const s = resolveScope(R1a, "candidate:read");
    const other = cand({ recruiterId: "R2a", teamId: "T2", visibility: "all_teams" });
    expect(candidateVisible(s, other)).toBe(true);
    expect(candidateVisible(s, { ...other, marketingStatus: "on_hold" })).toBe(false);
  });

  it("lead sees an unassigned candidate of their team (no recruiter)", () => {
    expect(candidateVisible(resolveScope(L1, "candidate:read"), cand({ recruiterId: null }))).toBe(true);
  });

  it("location admin sees by location only", () => {
    const s = resolveScope(LOCADM, "candidate:read");
    expect(candidateVisible(s, cand({ teamId: "T9", recruiterId: "R9" }))).toBe(true);
    expect(candidateVisible(s, cand({ locationId: LOC_A }))).toBe(false);
  });

  it("interview coach sees coached teams only", () => {
    const s = resolveScope(COACH, "candidate:read");
    expect(candidateVisible(s, cand({ teamId: "T2" }))).toBe(true);
    expect(candidateVisible(s, cand({ teamId: "T1" }))).toBe(false);
  });

  it("denied scope sees nothing", () => {
    expect(candidateVisible(resolveScope(ADMIN, "candidate:read"), cand({}))).toBe(false);
  });
});

describe("activityVisible", () => {
  const theirSubmissionOfOurCandidate = {
    recruiterId: "R2a",
    teamId: "T2",
    locationId: LOC_D,
    candidate: cand({ teamId: "T1", recruiterId: "R1b", visibility: "all_teams" as const }),
  };

  it("owning team sees other teams' submissions of its candidate", () => {
    expect(activityVisible(resolveScope(L1, "submission:read"), theirSubmissionOfOurCandidate)).toBe(true);
  });

  it("recruiter with own submission scope does not see a teammate's submission", () => {
    const teammate = { recruiterId: "R1b", teamId: "T1", locationId: LOC_D, candidate: cand({ recruiterId: "R1b" }) };
    // candidate is owned by R1b; R1a's submission:read is own, so ownership check uses own scope
    expect(activityVisible(resolveScope(R1a, "submission:read"), teammate)).toBe(false);
  });

  it("all-teams visibility alone does not reveal another team's activity", () => {
    const s = resolveScope(base({ userId: "R3", roles: [{ role: "recruiter" }], teamIds: ["T3"] }), "submission:read");
    expect(activityVisible(s, theirSubmissionOfOurCandidate)).toBe(false);
  });
});

describe("field policy", () => {
  const fields = { phone: "(469) 555-0142", dob: "1994-03-12" };

  it("recruiter sees phone of own-team candidate but never DOB", () => {
    const r = applyCandidateFieldPolicy(R1a, cand({}), fields);
    expect(r.phone).toBe(fields.phone);
    expect(r.dob).toBeNull();
    expect(r.dobMasked).toBe("•• / •• / 1994");
  });

  it("phone is masked for an Open-to-all-teams candidate of another team", () => {
    const r = applyCandidateFieldPolicy(R1a, cand({ recruiterId: "R2a", teamId: "T2", visibility: "all_teams" }), fields);
    expect(r.phoneMasked).toBe(true);
    expect(r.phone).toBe("•••-•••-42");
  });

  it("HR sees DOB", () => {
    expect(applyCandidateFieldPolicy(HR, cand({}), fields).dob).toBe("1994-03-12");
  });
});

describe("Hot List visibility policy (OD-01)", () => {
  const otherTeam = cand({ recruiterId: "R2a", teamId: "T2", locationId: LOC_A });
  const users = { R1a, HR, COACH, ADMIN };

  it("everyone: every signed-in user sees every Hot List candidate", () => {
    for (const u of Object.values(users)) {
      const scope = resolveScope(u, "hotlist:read", "everyone");
      expect(hotlistVisible(scope, otherTeam)).toBe(true);
      expect(capabilities(u, "everyone")).toContain("hotlist:read");
    }
  });

  it("everyone: candidates outside Hot List statuses stay hidden", () => {
    expect(hotlistVisible(resolveScope(HR, "hotlist:read", "everyone"), cand({ marketingStatus: "placed" }))).toBe(false);
  });

  it("everyone: profiles and activity permissions are unchanged", () => {
    expect(candidateVisible(resolveScope(R1a, "candidate:read", "everyone"), otherTeam)).toBe(false);
    expect(candidateVisible(resolveScope(R1a, "submission:create", "everyone"), otherTeam)).toBe(false);
    expect(resolveScope(ADMIN, "candidate:read", "everyone")).toBeNull();
  });

  it("team: restores AS-07 (own hierarchy plus Open-to-all-teams)", () => {
    expect(hotlistVisible(resolveScope(R1a, "hotlist:read", "team"), otherTeam)).toBe(false);
    expect(hotlistVisible(resolveScope(R1a, "hotlist:read", "team"), { ...otherTeam, visibility: "all_teams" })).toBe(true);
    expect(resolveScope(ADMIN, "hotlist:read", "team")).toBeNull();
    expect(capabilities(ADMIN, "team")).not.toContain("hotlist:read");
  });
});
