/**
 * Golden expectations written by hand from SRS section 5 (and SRS 4.x text),
 * NOT generated from the catalog. This is the check that the catalog matches
 * the business rules (design B8, judge finding N7). Any intentional deviation
 * must be listed in DEVIATIONS with its design reference.
 */
import { describe, expect, it } from "vitest";
import type { Permission } from "./catalog.js";
import {
  activityVisible,
  candidateVisible,
  ownsCandidate,
  resolveScope,
  type CandidateRef,
  type UserAccess,
} from "./engine.js";

const D = "loc-dallas";
const A = "loc-austin";

// Org: AD > M > L1 (T1: R1, R1b) ; M > L2 (T2: R2). Location admin for Dallas.
const u = (userId: string, roles: UserAccess["roles"], extra: Partial<UserAccess> = {}): UserAccess => ({
  userId, roles, teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...extra,
});
const USERS: Record<string, UserAccess> = {
  recruiter: u("R1", [{ role: "recruiter" }], { teamIds: ["T1"] }),
  lead: u("L1", [{ role: "lead" }], { teamIds: ["T1"], subordinateUserIds: ["R1", "R1b"], subtreeTeamIds: ["T1"] }),
  manager: u("M", [{ role: "manager" }], { subordinateUserIds: ["L1", "L2", "R1", "R1b", "R2"], subtreeTeamIds: ["T1", "T2"] }),
  assoc_director: u("AD", [{ role: "assoc_director" }], { subordinateUserIds: ["M", "L1", "L2", "R1", "R1b", "R2"], subtreeTeamIds: ["T1", "T2"] }),
  location_admin: u("LA", [{ role: "location_ops_admin", locationId: D }]),
  hr: u("H", [{ role: "hr" }]),
  offshore_manager: u("OM", [{ role: "offshore_manager" }]),
};

// Record positions relative to recruiter R1.
const POS: Record<string, CandidateRef> = {
  own: { recruiterId: "R1", teamId: "T1", locationId: D, visibility: "team", marketingStatus: "active" },
  teammate: { recruiterId: "R1b", teamId: "T1", locationId: D, visibility: "team", marketingStatus: "active" },
  otherTeam: { recruiterId: "R2", teamId: "T2", locationId: A, visibility: "team", marketingStatus: "active" },
  otherTeamAllTeams: { recruiterId: "R2", teamId: "T2", locationId: A, visibility: "all_teams", marketingStatus: "active" },
  outsideHierarchy: { recruiterId: "R9", teamId: "T9", locationId: A, visibility: "team", marketingStatus: "active" },
};

type Check = "view" | "edit" | "logActivity";
type Row = [role: keyof typeof USERS, check: Check, pos: keyof typeof POS, allowed: boolean, srs: string];

const CHECK_PERMISSION: Record<Check, Permission> = {
  view: "hotlist:read",
  edit: "candidate:update",
  logActivity: "submission:create",
};

const GOLDEN: Row[] = [
  // SRS 5 "Candidate Profile": Recruiter edit only assigned; Lead team; Manager/AD hierarchy
  ["recruiter", "edit", "own", true, "5 Candidate Profile"],
  ["recruiter", "edit", "teammate", false, "5 Candidate Profile"],
  ["lead", "edit", "teammate", true, "5 Candidate Profile"],
  ["lead", "edit", "otherTeam", false, "5 Candidate Profile"],
  ["manager", "edit", "otherTeam", true, "5 Candidate Profile"],
  ["manager", "edit", "outsideHierarchy", false, "5 Candidate Profile"],
  ["assoc_director", "edit", "otherTeam", true, "5 Candidate Profile"],
  // SRS 4.3 / 5 "Hotlist": team-assigned visible to own team; Open-to-all visible to all Sales
  ["recruiter", "view", "teammate", true, "4.3 FR-HOT-04"],
  ["recruiter", "view", "otherTeam", false, "4.3 FR-HOT-04 (AS-07)"],
  ["recruiter", "view", "otherTeamAllTeams", true, "4.3 FR-HOT-05"],
  ["lead", "view", "otherTeamAllTeams", true, "4.3 FR-HOT-05"],
  ["location_admin", "view", "own", true, "4 Location Incharge: own location"],
  ["location_admin", "view", "otherTeam", false, "4 Location Incharge: own location"],
  ["offshore_manager", "view", "outsideHierarchy", true, "4 Offshore manager: all teams"],
  // SRS 5 "Submission Entry": Recruiter any Hotlist candidate; Lead/Manager/AD any candidate (D-01)
  ["recruiter", "logActivity", "teammate", true, "5 Submission Entry"],
  ["recruiter", "logActivity", "otherTeamAllTeams", true, "5 Submission Entry"],
  ["recruiter", "logActivity", "otherTeam", false, "5 Submission Entry (not on caller's Hot List)"],
  ["lead", "logActivity", "otherTeamAllTeams", true, "5 Submission Entry"],
  ["manager", "logActivity", "outsideHierarchy", false, "5 Submission Entry (D-01)"],
  ["hr", "logActivity", "own", false, "HR does not market candidates"],
];

describe("catalog matches SRS section 5 (golden expectations)", () => {
  it.each(GOLDEN)("%s %s %s → %s (%s)", (role, check, pos, allowed) => {
    const scope = resolveScope(USERS[role]!, CHECK_PERMISSION[check]);
    const cand = POS[pos]!;
    const result = check === "edit" ? scope !== null && ownsCandidate(scope, cand) : candidateVisible(scope, cand);
    expect(result).toBe(allowed);
  });
});

describe("SRS 5 status rows", () => {
  const sub = (recruiterId: string, teamId: string, candidate: CandidateRef) => ({ recruiterId, teamId, locationId: candidate.locationId, candidate });

  it("Submission Status: recruiter views own submissions only", () => {
    const s = resolveScope(USERS.recruiter!, "submission:read");
    expect(activityVisible(s, sub("R1", "T1", POS.own!))).toBe(true);
    expect(activityVisible(s, sub("R1b", "T1", POS.teammate!))).toBe(false);
  });

  it("Interview Status: recruiter sees interviews of own/assigned candidates, even if another recruiter logged them", () => {
    const s = resolveScope(USERS.recruiter!, "interview:read");
    expect(activityVisible(s, sub("R2", "T2", POS.own!))).toBe(true);
  });

  it("Submission Status: lead views submissions under their team", () => {
    const s = resolveScope(USERS.lead!, "submission:read");
    expect(activityVisible(s, sub("R1b", "T1", POS.teammate!))).toBe(true);
    expect(activityVisible(s, sub("R2", "T2", POS.otherTeam!))).toBe(false);
  });

  it("Team Performance: recruiter has no access to others; lead sees team", () => {
    expect([...resolveScope(USERS.recruiter!, "performance:read")!.recruiterIds]).toEqual(["R1"]);
    expect(resolveScope(USERS.lead!, "performance:read")!.teamIds.has("T1")).toBe(true);
  });

  it("Rates: visible to Manager and above, not Recruiter or Lead (SRS 4.6 recommendation)", () => {
    expect(resolveScope(USERS.recruiter!, "rate:read")).toBeNull();
    expect(resolveScope(USERS.lead!, "rate:read")).toBeNull();
    expect(resolveScope(USERS.manager!, "rate:read")).not.toBeNull();
  });

  it("Restricted documents: HR yes, Sales no (SRS 4.7 recommendation)", () => {
    expect(resolveScope(USERS.hr!, "document.restricted:read")).not.toBeNull();
    expect(resolveScope(USERS.assoc_director!, "document.restricted:read")).toBeNull();
  });

  it("Lead can create a candidate for their team (judge N4b)", () => {
    expect(resolveScope(USERS.lead!, "candidate:create")!.teamIds.has("T1")).toBe(true);
  });

  it("Offshore manager can reassign across hierarchies (FR-EMP-05, FR-ORG-03, judge N4c)", () => {
    expect(resolveScope(USERS.offshore_manager!, "candidate:assign")!.all).toBe(true);
  });

  it("Location roles can update technical rating only in their location", () => {
    const s = resolveScope(USERS.location_admin!, "candidate.rating:update")!;
    expect(ownsCandidate(s, POS.own!)).toBe(true);
    expect(ownsCandidate(s, POS.otherTeam!)).toBe(false);
    expect(resolveScope(USERS.location_admin!, "candidate:update")).toBeNull();
  });

  it("Coach and location admin see activity only in their scope", () => {
    const coach = u("C", [{ role: "interview_coach" }], { coachedTeamIds: ["T2"] });
    const cs = resolveScope(coach, "interview:read");
    expect(activityVisible(cs, sub("R2", "T2", POS.otherTeam!))).toBe(true);
    expect(activityVisible(cs, sub("R1", "T1", POS.own!))).toBe(false);
    const ls = resolveScope(USERS.location_admin!, "interview:read");
    expect(activityVisible(ls, { recruiterId: "R2", teamId: "T2", locationId: D, candidate: POS.otherTeam! })).toBe(true);
  });
});
