import { describe, expect, it } from "vitest";
import { GRANTS, RESTRICTED_PERMISSIONS, ROLES, type Role } from "./catalog.js";
import type { CandidateRef, UserAccess } from "./engine.js";
import {
  batchDisplayName,
  canManageTraining,
  canPlanBatch,
  trainingBatchCovered,
  trainingCandidateCovered,
  trainingManageLocations,
  trainingProgress,
} from "./training.js";

const user = (userId: string, role: Role, extra: Partial<UserAccess> = {}, locationId?: string): UserAccess => ({
  userId, roles: [{ role, locationId }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...extra,
});
const LOC_D = "loc-d", LOC_A = "loc-a";
const R1a = user("R1a", "recruiter", { teamIds: ["T1"] });
const L1 = user("L1", "lead", { teamIds: ["T1"], subordinateUserIds: ["R1a"], subtreeTeamIds: ["T1"] });
const LOCD = user("LD", "location_ops_admin", {}, LOC_D);
const INCH = user("LI", "location_incharge", {}, LOC_A);
const COACH = user("C", "interview_coach", { coachedTeamIds: ["T2"] });
const CEO = user("CEO", "ceo");
const HR = user("H", "hr");
const cand = (over: Partial<CandidateRef> = {}): CandidateRef =>
  ({ recruiterId: "R1a", teamId: "T1", locationId: LOC_D, visibility: "team", marketingStatus: "in_training", ...over });

describe("training grants (catalog)", () => {
  it("location roles manage at their location; coaches update progress; Sales and the CEO read; nobody else", () => {
    const holders = (p: "training:read" | "training:manage" | "training.progress:update") =>
      Object.fromEntries(ROLES.filter((r) => GRANTS[r][p]).map((r) => [r, GRANTS[r][p]]));
    expect(holders("training:manage")).toEqual({ location_incharge: "location", location_ops_admin: "location" });
    expect(holders("training.progress:update")).toEqual({ location_incharge: "location", location_ops_admin: "location", interview_coach: "coached" });
    expect(holders("training:read")).toEqual({
      recruiter: "own", lead: "team", manager: "hierarchy", assoc_director: "hierarchy", offshore_manager: "org", ceo: "org",
      location_incharge: "location", location_ops_admin: "location", interview_coach: "coached",
    });
  });

  it("no training permission is restricted", () => {
    for (const p of ["training:read", "training:manage", "training.progress:update"] as const) expect(RESTRICTED_PERMISSIONS).not.toContain(p);
  });
});

describe("batch-level coverage (mirrors authz.training_batch_ids)", () => {
  const dallas = { locationId: LOC_D, trainerId: null };
  const coached = { locationId: LOC_A, trainerId: "C" };
  it("org covers all, location its own location, coached the batches they train; Sales none", () => {
    expect(trainingBatchCovered(CEO, "training:read", dallas)).toBe(true);
    expect(trainingBatchCovered(LOCD, "training:manage", dallas)).toBe(true);
    expect(trainingBatchCovered(LOCD, "training:manage", coached)).toBe(false);
    expect(trainingBatchCovered(INCH, "training.progress:update", coached)).toBe(true);
    expect(trainingBatchCovered(COACH, "training:read", coached)).toBe(true);
    expect(trainingBatchCovered(COACH, "training.progress:update", coached)).toBe(true);
    expect(trainingBatchCovered(COACH, "training:read", dallas)).toBe(false);
    expect(trainingBatchCovered(COACH, "training:manage", coached)).toBe(false);
    expect(trainingBatchCovered(L1, "training:read", dallas)).toBe(false);
    expect(trainingBatchCovered(HR, "training:read", dallas)).toBe(false);
  });
});

describe("candidate-level coverage", () => {
  it("Sales read progress of candidates they own, coaches of coached teams, never through Open to all teams", () => {
    expect(trainingCandidateCovered(R1a, cand())).toBe(true);
    expect(trainingCandidateCovered(R1a, cand({ recruiterId: "R1b" }))).toBe(false);
    expect(trainingCandidateCovered(L1, cand({ recruiterId: "R1b" }))).toBe(true);
    expect(trainingCandidateCovered(L1, cand({ recruiterId: "X", teamId: "T9", visibility: "all_teams", marketingStatus: "active" }))).toBe(false);
    expect(trainingCandidateCovered(COACH, cand({ recruiterId: null, teamId: "T2" }))).toBe(true);
    expect(trainingCandidateCovered(HR, cand())).toBe(false);
  });

  it("manage helpers", () => {
    expect([LOCD, INCH, COACH, L1, CEO].map(canManageTraining)).toEqual([true, true, false, false, false]);
    expect([LOCD, INCH, COACH, L1, CEO, R1a].map(canPlanBatch)).toEqual([true, true, false, true, false, false]);
    expect(trainingManageLocations(LOCD)).toEqual({ all: false, locationIds: [LOC_D] });
    expect(trainingManageLocations(R1a)).toEqual({ all: false, locationIds: [] });
  });
});

describe("progress formula (TR-9)", () => {
  const modules = [
    { courseId: "A", moduleId: "a1", durationMinutes: 60 },
    { courseId: "A", moduleId: "a2", durationMinutes: 180 },
    { courseId: "B", moduleId: "b1", durationMinutes: 30 },
  ];
  it("weights by duration and rounds down", () => {
    const p = trainingProgress(modules, new Set(["a1", "b1", "zz"]));
    expect(p.courses).toEqual([
      { courseId: "A", completedModules: 1, totalModules: 2, completedMinutes: 60, totalMinutes: 240, percent: 25 },
      { courseId: "B", completedModules: 1, totalModules: 1, completedMinutes: 30, totalMinutes: 30, percent: 100 },
    ]);
    expect([p.completedMinutes, p.totalMinutes, p.percent]).toEqual([90, 270, 33]);
  });
  it("is 100 only when everything is done, 0 with no modules", () => {
    expect(trainingProgress(modules, new Set(["a1", "a2"])).percent).toBe(88);
    expect(trainingProgress(modules, new Set(["a1", "a2", "b1"])).percent).toBe(100);
    expect(trainingProgress([], new Set(["a1"]))).toEqual({ courses: [], completedMinutes: 0, totalMinutes: 0, percent: 0 });
  });
});

describe("batch display name", () => {
  it("uses the name, else technology and start month", () => {
    expect(batchDisplayName(" .NET 2026 ", "Java", "2026-09-01")).toBe(".NET 2026");
    expect(batchDisplayName(null, "Java", "2026-09-01")).toBe("Java Sep 2026");
    expect(batchDisplayName("", "Java", "2026-11")).toBe("Java Nov 2026");
  });
});
