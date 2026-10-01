import { describe, expect, it } from "vitest";
import { candidateActions, placementTransitions, submissionActions } from "./actions.js";
import type { CandidateRef, UserAccess } from "./engine.js";
import {
  PLACEMENT_STATUSES,
  candidateTransitionTargets,
  placementTransitionAllowed,
  placementTransitionTargets,
  submissionTransitionTargets,
} from "./state-machines.js";

const base = (over: Partial<UserAccess> & Pick<UserAccess, "userId" | "roles">): UserAccess => ({
  teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...over,
});
const R1a = base({ userId: "R1a", roles: [{ role: "recruiter" }], teamIds: ["T1"] });
const L1 = base({ userId: "L1", roles: [{ role: "lead" }], teamIds: ["T1"], subordinateUserIds: ["R1a"], subtreeTeamIds: ["T1"] });
const M = base({ userId: "M", roles: [{ role: "manager" }], subordinateUserIds: ["L1", "R1a"], subtreeTeamIds: ["T1"] });
const HR = base({ userId: "HR", roles: [{ role: "hr" }] });
const LOC = base({ userId: "LA", roles: [{ role: "location_incharge", locationId: "D" }] });

describe("placement state machine (PL-4)", () => {
  it("forward one step at a time; backout before joined; bgc_failed from any live state", () => {
    expect(placementTransitionTargets("confirmed")).toEqual(["paperwork", "backout", "bgc_failed"]);
    expect(placementTransitionTargets("ready")).toEqual(["joined", "backout", "bgc_failed"]);
    expect(placementTransitionTargets("joined")).toEqual(["bgc_failed"]);
    expect(placementTransitionTargets("backout")).toEqual([]);
    expect(placementTransitionTargets("bgc_failed")).toEqual([]);
    expect(placementTransitionAllowed("confirmed", "bgc")).toBe(false);
    expect(placementTransitionAllowed("paperwork", "confirmed")).toBe(false);
    for (const s of PLACEMENT_STATUSES) expect(placementTransitionAllowed(s, s)).toBe(false);
  });
});

describe("other state machines", () => {
  it("candidate manual targets stop while a placement is open", () => {
    expect(candidateTransitionTargets("confirmation", false)).toEqual(["active", "terminated"]);
    expect(candidateTransitionTargets("confirmation", true)).toEqual([]);
    expect(candidateTransitionTargets("placed", false)).toEqual([]);
  });
  it("submission targets", () => {
    expect(submissionTransitionTargets("submitted")).toEqual(["under_review", "rejected", "withdrawn"]);
    expect(submissionTransitionTargets("selected")).toEqual([]);
  });
});

describe("action hints", () => {
  const own: CandidateRef = { recruiterId: "R1a", teamId: "T1", locationId: "D", visibility: "team", marketingStatus: "active" };
  const r1aAct = { recruiterId: "R1a", teamId: "T1", locationId: "D" };

  it("candidate actions follow the grants", () => {
    expect(candidateActions(R1a, own, false)).toEqual({
      edit: true, transition: ["on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"],
      visibility: false, rating: false, logSubmission: true,
    });
    expect(candidateActions(L1, own, false).visibility).toBe(true);
    expect(candidateActions(LOC, own, false)).toEqual({ edit: false, transition: [], visibility: false, rating: true, logSubmission: false });
    expect(candidateActions(HR, own, false)).toEqual({ edit: false, transition: [], visibility: false, rating: false, logSubmission: false });
  });

  it("submission actions: createPlacement needs selected, update + create rights and an available candidate", () => {
    expect(submissionActions(R1a, r1aAct, "selected", own)).toEqual({ transition: [], createInterview: false, createPlacement: true });
    expect(submissionActions(R1a, r1aAct, "selected", { ...own, marketingStatus: "on_hold" }).createPlacement).toBe(false);
    expect(submissionActions(R1a, r1aAct, "selected", null).createPlacement).toBe(false);
    expect(submissionActions(R1a, r1aAct, "submitted", own)).toEqual({
      transition: ["under_review", "rejected", "withdrawn"], createInterview: true, createPlacement: false,
    });
    expect(submissionActions(HR, r1aAct, "selected", own)).toEqual({ transition: [], createInterview: false, createPlacement: false });
  });

  it("placement transitions: bgc_failed only with placement.bgc_status:update", () => {
    expect(placementTransitions(R1a, r1aAct, "confirmed")).toEqual(["paperwork", "backout"]);
    expect(placementTransitions(L1, r1aAct, "confirmed")).toEqual(["paperwork", "backout"]);
    expect(placementTransitions(M, r1aAct, "joined")).toEqual(["bgc_failed"]);
    expect(placementTransitions(HR, r1aAct, "confirmed")).toEqual([]);
  });
});
