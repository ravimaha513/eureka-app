import { describe, expect, it } from "vitest";
import { candidateActions, placementTransitions, submissionActions } from "./actions.js";
import type { CandidateRef, UserAccess } from "./engine.js";
import {
  BATCH_OPEN_STATUSES,
  BATCH_STATUSES,
  CLOSED_BEFORE_JOIN_STATUSES,
  OPEN_PLACEMENT_STATUSES,
  PAPERWORK_LOCKED_PLACEMENT_STATUSES,
  PLACEMENT_STATUSES,
  batchTransitionAllowed,
  batchTransitionTargets,
  candidateTransitionTargets,
  placementTransitionAllowed,
  jobTransitionAllowed,
  jobTransitionTargets,
  placementTransitionTargets,
  submissionTransitionTargets,
} from "./state-machines.js";
import { JOB_STATUSES } from "../jobs.js";

const base = (over: Partial<UserAccess> & Pick<UserAccess, "userId" | "roles">): UserAccess => ({
  teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], subtreeCoachedTeamIds: [], ...over,
});
const R1a = base({ userId: "R1a", roles: [{ role: "recruiter" }], teamIds: ["T1"] });
const L1 = base({ userId: "L1", roles: [{ role: "lead" }], teamIds: ["T1"], subordinateUserIds: ["R1a"], subtreeTeamIds: ["T1"] });
const M = base({ userId: "M", roles: [{ role: "manager" }], subordinateUserIds: ["L1", "R1a"], subtreeTeamIds: ["T1"] });
const HR = base({ userId: "HR", roles: [{ role: "hr" }] });
const LOC = base({ userId: "LA", roles: [{ role: "location_incharge", locationId: "D" }] });

describe("placement state machine (PL-4)", () => {
  it("forward one step at a time; backout before joined; bgc_failed from any live state", () => {
    expect(placementTransitionTargets("confirmed")).toEqual(["paperwork", "backout", "bgc_failed", "joining_issue"]);
    expect(placementTransitionTargets("ready")).toEqual(["joined", "backout", "bgc_failed", "joining_issue"]);
    expect(placementTransitionTargets("joined")).toEqual(["bgc_failed"]);
    expect(placementTransitionTargets("backout")).toEqual([]);
    expect(placementTransitionTargets("bgc_failed")).toEqual([]);
    // joining_issue (migration 0160): closes an open placement; never after joining; final.
    expect(placementTransitionAllowed("joined", "joining_issue")).toBe(false);
    expect(placementTransitionTargets("joining_issue")).toEqual([]);
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

describe("job lifecycle (JP-3a: permissive as built)", () => {
  it("any status may change to any other; the unchanged status is not a transition", () => {
    for (const from of JOB_STATUSES) {
      expect(jobTransitionTargets(from)).toEqual(JOB_STATUSES.filter((s) => s !== from));
      expect(jobTransitionAllowed(from, from)).toBe(false);
    }
    expect(jobTransitionAllowed("closed", "draft")).toBe(true);
    expect(jobTransitionAllowed("open", "archived")).toBe(false);
    expect(jobTransitionAllowed("archived", "open")).toBe(false);
    expect(jobTransitionTargets("archived")).toEqual([]);
  });
});

describe("training batch lifecycle (TR-6)", () => {
  it("planned -> in_training -> completed; cancelled from either open state; completed and cancelled are final", () => {
    expect(batchTransitionTargets("planned")).toEqual(["in_training", "cancelled"]);
    expect(batchTransitionTargets("in_training")).toEqual(["completed", "cancelled"]);
    expect(batchTransitionTargets("completed")).toEqual([]);
    expect(batchTransitionTargets("cancelled")).toEqual([]);
    expect(batchTransitionAllowed("planned", "completed")).toBe(false);
    expect(batchTransitionAllowed("in_training", "planned")).toBe(false);
    for (const s of BATCH_STATUSES) expect(batchTransitionAllowed(s, s)).toBe(false);
  });
  it("open batches are exactly those with an outgoing transition", () => {
    expect(BATCH_STATUSES.filter((s) => BATCH_OPEN_STATUSES.has(s))).toEqual(BATCH_STATUSES.filter((s) => batchTransitionTargets(s).length > 0));
  });
});

describe("placement status sets", () => {
  it("paperwork locks only on a backout, which is a closed-before-join status and never open", () => {
    expect([...PAPERWORK_LOCKED_PLACEMENT_STATUSES]).toEqual(["backout"]);
    for (const s of PAPERWORK_LOCKED_PLACEMENT_STATUSES) {
      expect(CLOSED_BEFORE_JOIN_STATUSES.has(s)).toBe(true);
      expect(OPEN_PLACEMENT_STATUSES.has(s)).toBe(false);
    }
  });
});

describe("action hints", () => {
  const own: CandidateRef = { recruiterId: "R1a", teamId: "T1", locationId: "D", visibility: "team", marketingStatus: "active" };
  const r1aAct = { recruiterId: "R1a", teamId: "T1", locationId: "D" };

  it("candidate actions follow the grants", () => {
    expect(candidateActions(R1a, own, false)).toEqual({
      edit: true, transition: ["on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"],
      visibility: false, rating: false, logSubmission: true, delete: false, assign: false,
    });
    expect(candidateActions(L1, own, false).delete).toBe(true);
    expect(candidateActions(L1, own, false).visibility).toBe(true);
    expect(candidateActions(L1, own, false).assign).toBe(true);
    expect(candidateActions(LOC, own, false)).toEqual({ edit: false, transition: [], visibility: false, rating: true, logSubmission: false, delete: false, assign: false });
    expect(candidateActions(HR, own, false)).toEqual({ edit: false, transition: [], visibility: false, rating: false, logSubmission: false, delete: false, assign: false });
  });

  it("submission actions: createPlacement needs selected, update + create rights and an available candidate", () => {
    expect(submissionActions(R1a, r1aAct, "selected", own)).toEqual({ transition: [], createInterview: false, createPlacement: true, clearAndPlace: true, placeBlocked: null, editDetails: false, editRate: false });
    expect(submissionActions(R1a, r1aAct, "selected", { ...own, marketingStatus: "on_hold" }).createPlacement).toBe(false);
    // A candidate hidden from the caller does not stop them placing their own submission.
    expect(submissionActions(R1a, r1aAct, "selected", null).createPlacement).toBe(true);
    expect(submissionActions(R1a, r1aAct, "submitted", own)).toEqual({
      transition: ["under_review", "rejected", "withdrawn"], createInterview: true, createPlacement: false, clearAndPlace: true, placeBlocked: null,
      editDetails: false, editRate: false,
    });
    expect(submissionActions(R1a, r1aAct, "withdrawn", own).clearAndPlace).toBe(false);
    expect(submissionActions(R1a, r1aAct, "submitted", { ...own, marketingStatus: "on_hold" }).clearAndPlace).toBe(false);
    // A second placement may be made while another is in progress (candidate in confirmation).
    expect(submissionActions(R1a, r1aAct, "submitted", { ...own, marketingStatus: "confirmation" })).toMatchObject({ clearAndPlace: true, placeBlocked: null });
    expect(submissionActions(R1a, r1aAct, "submitted", { ...own, marketingStatus: "placed" }).placeBlocked).toBe("placed");
    expect(submissionActions(R1a, r1aAct, "withdrawn", { ...own, marketingStatus: "placed" }).placeBlocked).toBeNull();
    expect(submissionActions(HR, r1aAct, "selected", own)).toEqual({ transition: [], createInterview: false, createPlacement: false, clearAndPlace: false, placeBlocked: null, editDetails: false, editRate: false });
  });

  it("submission actions: lead and above correct details; the rate only with rate:read", () => {
    // Lead of the recruiter's team: details yes, rate no (no rate:read).
    expect(submissionActions(L1, r1aAct, "submitted", own)).toMatchObject({ editDetails: true, editRate: false });
    expect(submissionActions(R1a, r1aAct, "rejected", own)).toMatchObject({ editDetails: false, editRate: false });
  });

  it("placement transitions: bgc_failed only with placement.bgc_status:update", () => {
    expect(placementTransitions(R1a, r1aAct, "confirmed")).toEqual(["paperwork", "backout", "joining_issue"]);
    expect(placementTransitions(L1, r1aAct, "confirmed")).toEqual(["paperwork", "backout", "joining_issue"]);
    expect(placementTransitions(M, r1aAct, "joined")).toEqual(["bgc_failed"]);
    expect(placementTransitions(HR, r1aAct, "confirmed")).toEqual([]);
  });
});
