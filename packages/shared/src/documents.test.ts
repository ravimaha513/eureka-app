import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CONTENT_TYPE_LIST, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, DOCUMENT_TYPE_LIST, RESUME_MAX_BYTES,
  documentAccess, isDocumentContentType, isDocumentType, isResumeContentType, resumeAccess,
} from "./documents.js";
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

describe("paperwork document types and upload rules", () => {
  it("allows PDF, DOCX, PNG and JPEG, up to 15 MB", () => {
    expect([...DOCUMENT_CONTENT_TYPE_LIST].sort()).toEqual([
      "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/jpeg", "image/png"]);
    expect(isDocumentContentType("image/gif")).toBe(false);
    expect(isDocumentContentType("text/html")).toBe(false);
    expect(isDocumentContentType("constructor")).toBe(false);
    expect(DOCUMENT_MAX_BYTES).toBe(15_728_640);
  });

  it("I-9, driving license and work-authorization copies are restricted (design A6.3)", () => {
    const restricted = DOCUMENT_TYPE_LIST.filter((t) => DOCUMENT_TYPES[t].classification === "restricted").sort();
    expect(restricted).toEqual(["drivers_license", "i9", "work_authorization"]);
    for (const t of DOCUMENT_TYPE_LIST) expect(t).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
    expect(isDocumentType("i9")).toBe(true);
    expect(isDocumentType("hasOwnProperty")).toBe(false);
  });
});

describe("documentAccess (B4.4: document:read scope; restricted needs document.restricted:read)", () => {
  const none = { read: false, upload: false, readRestricted: false, uploadRestricted: false };
  const other = cand({ recruiterId: "x", teamId: "t9" });

  it("only HR, Accounts and Immigration see restricted documents; Accounts cannot upload", () => {
    expect(documentAccess(user([{ role: "hr" }]), other)).toEqual({ read: true, upload: true, readRestricted: true, uploadRestricted: true });
    expect(documentAccess(user([{ role: "immigration" }]), other)).toEqual({ read: true, upload: true, readRestricted: true, uploadRestricted: true });
    expect(documentAccess(user([{ role: "accounts" }]), other)).toEqual({ read: true, upload: false, readRestricted: true, uploadRestricted: false });
  });

  it("Documents Team and Associate HR handle internal documents only", () => {
    for (const role of ["documents_team", "associate_hr"] as const) {
      expect(documentAccess(user([{ role }]), other)).toEqual({ read: true, upload: true, readRestricted: false, uploadRestricted: false });
    }
  });

  it("Sales: own/team scope, never restricted, never through Open to all teams", () => {
    expect(documentAccess(user([{ role: "recruiter" }]), cand())).toEqual({ read: true, upload: true, readRestricted: false, uploadRestricted: false });
    expect(documentAccess(user([{ role: "recruiter" }]), cand({ recruiterId: "x" }))).toEqual(none);
    expect(documentAccess(user([{ role: "lead" }]), cand({ recruiterId: "x", teamId: "t9", visibility: "all_teams" }))).toEqual(none);
  });

  it("CEO, BU head, location roles, coaches and org admins see no documents", () => {
    for (const roles of [[{ role: "ceo" }], [{ role: "bu_head" }], [{ role: "org_admin" }], [{ role: "interview_coach" }],
      [{ role: "location_incharge", locationId: "dallas" }]] as UserAccess["roles"][]) {
      expect(documentAccess(user(roles), cand())).toEqual(none);
    }
  });
});
