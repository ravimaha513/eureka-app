import { describe, expect, it } from "vitest";
import { LOCATION_ROLES, ROLES, type Role } from "./catalog.js";
import { activityVisible, candidateVisible, resolveScope, type ActivityRef, type CandidateRef, type UserAccess } from "./engine.js";
import { EXPLAIN_KINDS, EXPLAIN_PERMISSION, explainActivity, explainCandidate } from "./explain.js";

const base = (over: Partial<UserAccess> & Pick<UserAccess, "userId" | "roles">): UserAccess => ({
  teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], subtreeCoachedTeamIds: [],
  ...over,
});
const cand = (over: Partial<CandidateRef> = {}): CandidateRef => ({
  id: "C1", recruiterId: "R1b", teamId: "T1", locationId: "loc-d", visibility: "team", marketingStatus: "active", ...over,
});

const R1a = base({ userId: "R1a", roles: [{ role: "recruiter" }], teamIds: ["T1"] });
const R2a = base({ userId: "R2a", roles: [{ role: "recruiter" }], teamIds: ["T2"] });
const M = base({ userId: "M", roles: [{ role: "manager" }], subordinateUserIds: ["L1", "R1b"], subtreeTeamIds: ["T1"] });
const HR = base({ userId: "H", roles: [{ role: "hr" }] });

describe("explainCandidate", () => {
  it("names the team path for a teammate's candidate", () => {
    const e = explainCandidate(R1a, cand());
    expect(e.allowed).toBe(true);
    expect(e.roles[0]!.paths).toContainEqual({ via: "team", on: "candidate", teamId: "T1" });
  });

  it("names self and report paths", () => {
    expect(explainCandidate(base({ ...R1a, userId: "R1b" }), cand()).roles[0]!.paths)
      .toContainEqual({ via: "self", on: "candidate" });
    expect(explainCandidate(M, cand()).roles[0]!.paths).toContainEqual({ via: "report", on: "candidate", userId: "R1b" });
  });

  it("explains the all-teams rule and its misses", () => {
    expect(explainCandidate(R2a, cand({ visibility: "all_teams" })).roles[0]!.paths).toEqual([{ via: "all_teams" }]);
    const parked = explainCandidate(R2a, cand({ visibility: "all_teams", marketingStatus: "in_training" }));
    expect(parked.allowed).toBe(false);
    expect(parked.roles[0]!.miss).toBe("open_to_all_not_marketable");
    const out = explainCandidate(R2a, cand());
    expect(out.roles[0]!.miss).toBe("out_of_scope");
    expect(out.phone).toBe("none");
  });

  it("selected teams need the share and a Sales role", () => {
    const shared = base({ ...R2a, sharedCandidateIds: ["C1"] });
    expect(explainCandidate(shared, cand({ visibility: "selected_teams" })).roles[0]!.paths).toEqual([{ via: "selected_teams" }]);
    expect(explainCandidate(R2a, cand({ visibility: "selected_teams" })).allowed).toBe(false);
  });

  it("shows the phone in full only with candidate.phone:read", () => {
    expect(explainCandidate(R1a, cand()).phone).toBe("masked");
    expect(explainCandidate(HR, cand()).phone).toBe("full");
  });

  it("reports roles without the permission with a null scope", () => {
    const e = explainCandidate(base({ userId: "A", roles: [{ role: "org_admin" }] }), cand());
    expect(e.allowed).toBe(false);
    expect(e.roles[0]).toMatchObject({ role: "org_admin", scope: null, paths: [] });
  });
});

describe("explainActivity", () => {
  const act = (over: Partial<ActivityRef> = {}): ActivityRef => ({
    recruiterId: "R2a", teamId: "T2", locationId: "loc-d", candidate: cand(), ...over,
  });

  it("covers the actor snapshot and the candidate owner separately", () => {
    // A recruiter's activity grant is own: only their own record.
    expect(explainActivity(R2a, "submission", act()).roles[0]!.paths).toEqual([{ via: "self", on: "record" }]);
    expect(explainActivity(R1a, "submission", act()).roles[0]!.miss).toBe("out_of_scope");
    const L2 = base({ userId: "L2", roles: [{ role: "lead" }], teamIds: ["T2"] });
    expect(explainActivity(L2, "submission", act()).roles[0]!.paths).toContainEqual({ via: "team", on: "record", teamId: "T2" });
    const L1 = base({ userId: "L1", roles: [{ role: "lead" }], teamIds: ["T1"] });
    expect(explainActivity(L1, "submission", act()).roles[0]!.paths).toContainEqual({ via: "team", on: "candidate", teamId: "T1" });
  });

  it("the all-teams rule never reveals activity", () => {
    const viewer = base({ userId: "X", roles: [{ role: "recruiter" }], teamIds: ["T9"] });
    const e = explainActivity(viewer, "placement", act({ candidate: cand({ visibility: "all_teams" }) }));
    expect(e.allowed).toBe(false);
    expect(e.roles[0]!.miss).toBe("open_to_all_not_for_activity");
  });

  it("an org grant reads as one path", () => {
    const e = explainActivity(HR, "placement", act());
    expect(e.allowed).toBe(true);
    expect(e.roles[0]!.paths).toEqual([{ via: "org" }]);
  });
});

// Property: the verdict always equals the engine's, and a role shows paths iff it alone would grant access.
describe("explain agrees with the engine (randomised)", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const some = <T>(xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.35);
  const USERS = ["U0", "U1", "U2", "U3"], TEAMS = ["T1", "T2", "T3"], LOCS = ["L1", "L2"];
  const STATUSES = ["active", "full_of_interviews", "in_training", "on_hold"];
  const VIS = ["team", "all_teams", "selected_teams"] as const;

  const randomUser = (): UserAccess => {
    const roles = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const role = pick(ROLES) as Role;
      return LOCATION_ROLES.includes(role) ? { role, locationId: pick(LOCS) } : { role };
    });
    return base({
      userId: pick(USERS), roles, teamIds: some(TEAMS), subordinateUserIds: some(USERS), subtreeTeamIds: some(TEAMS),
      coachedTeamIds: some(TEAMS), subtreeCoachedTeamIds: some(TEAMS), sharedCandidateIds: rnd() < 0.5 ? ["C1"] : [],
    });
  };
  const randomCand = (): CandidateRef => cand({
    recruiterId: rnd() < 0.2 ? null : pick(USERS), teamId: rnd() < 0.2 ? null : pick(TEAMS), locationId: pick(LOCS),
    visibility: pick(VIS), marketingStatus: pick(STATUSES),
  });

  it("over 3000 random users and records", () => {
    for (let i = 0; i < 3000; i++) {
      const user = randomUser();
      const kind = pick(EXPLAIN_KINDS);
      const perm = EXPLAIN_PERMISSION[kind];
      const c = randomCand();
      const a: ActivityRef = { recruiterId: pick(USERS), teamId: rnd() < 0.3 ? null : pick(TEAMS), locationId: pick(LOCS), candidate: c };
      const e = kind === "candidate" ? explainCandidate(user, c) : explainActivity(user, kind, a);
      const engine = kind === "candidate"
        ? candidateVisible(resolveScope(user, perm), c)
        : activityVisible(resolveScope(user, perm), a);
      expect(e.allowed).toBe(engine);
      expect(e.allowed).toBe(e.roles.some((r) => r.paths.length > 0));
      for (const r of e.roles) {
        if (r.scope === null) expect(r.paths).toEqual([]);
        else expect(r.paths.length > 0 || r.miss !== undefined).toBe(true);
      }
    }
  });

});
