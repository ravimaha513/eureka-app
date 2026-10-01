import { describe, expect, it } from "vitest";
import { RESUME_MAX_BYTES, isResumeContentType, resumeAccess } from "./documents.js";
import type { CandidateRef, UserAccess } from "./authz/engine.js";

const user = (roles: UserAccess["roles"], extra: Partial<UserAccess> = {}): UserAccess => ({
  userId: "me", roles, teamIds: ["t1"], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...extra,
});
const cand = (c: Partial<CandidateRef> = {}): CandidateRef => ({
  recruiterId: "me", teamId: "t1", locationId: "dallas", visibility: "team", marketingStatus: "active", ...c,
});

describe("resume upload rules", () => {
  it("allows PDF and DOCX only, up to 15 MB", () => {
    expect(isResumeContentType("application/pdf")).toBe(true);
    expect(isResumeContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isResumeContentType("application/msword")).toBe(false);
    expect(isResumeContentType("image/png")).toBe(false);
    expect(isResumeContentType("toString")).toBe(false);
    expect(RESUME_MAX_BYTES).toBe(15_728_640);
  });
});

describe("resumeAccess (document:read / document:upload over the candidate)", () => {
  it("recruiter: own candidates only, not a teammate's (document grants are own)", () => {
    const r = user([{ role: "recruiter" }]);
    expect(resumeAccess(r, cand())).toEqual({ read: true, upload: true });
    expect(resumeAccess(r, cand({ recruiterId: "other" }))).toEqual({ read: false, upload: false });
  });

  it("lead: the team's candidates", () => {
    const l = user([{ role: "lead" }]);
    expect(resumeAccess(l, cand({ recruiterId: "other" }))).toEqual({ read: true, upload: true });
    expect(resumeAccess(l, cand({ recruiterId: "other", teamId: "t9" }))).toEqual({ read: false, upload: false });
  });

  it("the Open-to-all-teams rule never reveals resumes", () => {
    const l = user([{ role: "lead" }]);
    expect(resumeAccess(l, cand({ recruiterId: "x", teamId: "t9", visibility: "all_teams" }))).toEqual({ read: false, upload: false });
  });

  it("org roles: HR and Documents Team read and upload, Accounts reads only; CEO and location roles neither", () => {
    expect(resumeAccess(user([{ role: "hr" }]), cand({ recruiterId: "x", teamId: "t9" }))).toEqual({ read: true, upload: true });
    expect(resumeAccess(user([{ role: "documents_team" }]), cand({ recruiterId: "x" }))).toEqual({ read: true, upload: true });
    expect(resumeAccess(user([{ role: "accounts" }]), cand({ recruiterId: "x" }))).toEqual({ read: true, upload: false });
    expect(resumeAccess(user([{ role: "ceo" }]), cand())).toEqual({ read: false, upload: false });
    expect(resumeAccess(user([{ role: "location_incharge", locationId: "dallas" }]), cand())).toEqual({ read: false, upload: false });
  });
});
