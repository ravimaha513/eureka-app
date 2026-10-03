import { describe, expect, it } from "vitest";
import { bgcActions, checklistItemActions, checklistTemplateAccess, paperworkCovered, type PaperworkRef } from "./actions.js";
import type { UserAccess } from "./engine.js";
import {
  BGC_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  bgcTransitionAllowed,
  bgcTransitionTargets,
  checklistItemTransitionAllowed,
  checklistItemTransitionTargets,
} from "./state-machines.js";

const base = (over: Partial<UserAccess> & Pick<UserAccess, "userId" | "roles">): UserAccess => ({
  teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...over,
});
const R1a = base({ userId: "R1a", roles: [{ role: "recruiter" }], teamIds: ["T1"] });
const R2a = base({ userId: "R2a", roles: [{ role: "recruiter" }], teamIds: ["T2"] });
const M = base({ userId: "M", roles: [{ role: "manager" }], subordinateUserIds: ["L1", "R1a"], subtreeTeamIds: ["T1"] });
const HR = base({ userId: "HR", roles: [{ role: "hr" }] });
const AHR = base({ userId: "AHR", roles: [{ role: "associate_hr" }] });
const ACCT = base({ userId: "ACCT", roles: [{ role: "accounts" }] });
const IMM = base({ userId: "IMM", roles: [{ role: "immigration" }] });
const DOCS = base({ userId: "DOCS", roles: [{ role: "documents_team" }] });
const CEO = base({ userId: "CEO", roles: [{ role: "ceo" }] });
const HR_M = base({ userId: "HRM", roles: [{ role: "hr" }, { role: "manager" }], subordinateUserIds: ["R1a"], subtreeTeamIds: ["T1"] });

const ref: PaperworkRef = {
  recruiterId: "R1a", teamId: "T1", locationId: "D",
  candidate: { recruiterId: "R1a", teamId: "T1", locationId: "D", visibility: "team", marketingStatus: "confirmation" },
};

describe("checklist item state machine (PW-2)", () => {
  it("allows exactly the documented edges", () => {
    const edges = CHECKLIST_ITEM_STATUSES.flatMap((f) => CHECKLIST_ITEM_STATUSES.filter((t) => checklistItemTransitionAllowed(f, t)).map((t) => `${f}>${t}`));
    expect(edges.sort()).toEqual([
      "pending>received", "pending>waived", "received>pending", "received>verified", "received>waived",
      "verified>pending", "waived>pending"].sort());
    expect(checklistItemTransitionTargets("bogus")).toEqual([]);
    expect(checklistItemTransitionAllowed("pending", "verified")).toBe(false);
  });
});

describe("BGC state machine (PW-7)", () => {
  it("steps forward; cleared can still fail (FR-PLC-06); failed is final", () => {
    const edges = BGC_STATUSES.flatMap((f) => BGC_STATUSES.filter((t) => bgcTransitionAllowed(f, t)).map((t) => `${f}>${t}`));
    expect(edges.sort()).toEqual([
      "cleared>failed", "in_progress>cleared", "in_progress>failed", "initiated>cleared", "initiated>failed",
      "initiated>in_progress", "not_started>initiated"].sort());
    expect(bgcTransitionTargets("failed")).toEqual([]);
  });
});

describe("paperwork coverage and actions", () => {
  it("document scope covers the actor snapshot or the owned candidate, never the all-teams rule", () => {
    expect(paperworkCovered(R1a, "document:read", ref)).toBe(true);
    expect(paperworkCovered(R2a, "document:read", ref)).toBe(false);
    expect(paperworkCovered(R2a, "document:read", { ...ref, candidate: { ...ref.candidate!, visibility: "all_teams", marketingStatus: "active" } })).toBe(false);
    expect(paperworkCovered(CEO, "document:read", ref)).toBe(false);
    expect(paperworkCovered(IMM, "document:read", { ...ref, candidate: null })).toBe(true);
  });

  it("receiving needs upload or verify; verifying, waiving, returning and assigning need verify", () => {
    expect(checklistItemActions(R1a, ref, "pending", "paperwork")).toEqual({ transition: ["received"], editNotes: true, assign: false });
    expect(checklistItemActions(AHR, ref, "pending", "paperwork")).toEqual({ transition: ["received"], editNotes: true, assign: false });
    expect(checklistItemActions(HR, ref, "pending", "paperwork")).toEqual({ transition: ["received", "waived"], editNotes: true, assign: true });
    expect(checklistItemActions(HR, ref, "received", null)).toEqual({ transition: ["verified", "waived", "pending"], editNotes: true, assign: true });
    expect(checklistItemActions(DOCS, ref, "verified", "ready").transition).toEqual(["pending"]);
    expect(checklistItemActions(ACCT, ref, "pending", "paperwork")).toEqual({ transition: [], editNotes: false, assign: false });
    expect(checklistItemActions(R2a, ref, "pending", "paperwork")).toEqual({ transition: [], editNotes: false, assign: false });
    expect(checklistItemActions(HR, ref, "pending", "backout")).toEqual({ transition: [], editNotes: false, assign: false });
  });

  it("BGC updates need bgc:update; failing the placement also needs the placement rights", () => {
    expect(bgcActions(HR, ref, "not_started", "bgc")).toEqual({ update: true, transition: ["initiated"], failPlacement: false });
    expect(bgcActions(HR, ref, "in_progress", "bgc")).toEqual({ update: true, transition: ["cleared", "failed"], failPlacement: false });
    expect(bgcActions(HR_M, ref, "in_progress", "bgc").failPlacement).toBe(true);
    expect(bgcActions(HR_M, ref, "failed", "joined").failPlacement).toBe(true);
    expect(bgcActions(HR_M, ref, "failed", "bgc_failed").failPlacement).toBe(false);
    expect(bgcActions(HR_M, ref, "in_progress", null).failPlacement).toBe(false);
    expect(bgcActions(M, ref, "in_progress", "bgc")).toEqual({ update: false, transition: [], failPlacement: false });
    expect(bgcActions(IMM, ref, "in_progress", null).update).toBe(false);
    expect(bgcActions(HR, ref, "initiated", "backout").update).toBe(false);
  });

  it("templates: org-wide document readers read, org-wide verifiers publish", () => {
    expect(checklistTemplateAccess(HR)).toEqual({ read: true, publish: true });
    expect(checklistTemplateAccess(IMM)).toEqual({ read: true, publish: true });
    expect(checklistTemplateAccess(ACCT)).toEqual({ read: true, publish: false });
    expect(checklistTemplateAccess(R1a)).toEqual({ read: false, publish: false });
    expect(checklistTemplateAccess(M)).toEqual({ read: false, publish: false });
  });
});
