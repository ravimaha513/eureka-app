import { describe, expect, it } from "vitest";
import { GRANTS, ORG_SENSITIVE_PERMISSIONS, ROLES, SALES_ROLES, isRestrictedRole, type Role } from "./authz/catalog.js";
import type { UserAccess } from "./authz/engine.js";
import {
  RichDocSchema, applicationTransitionAllowed, creatableJobKinds, isSafeHttpsUrl, jobAllowed, nextApplicationStatuses,
  richExcerpt, richToPlain, type JobRef,
} from "./jobs.js";

const user = (role: Role, extra: Partial<UserAccess> = {}): UserAccess => ({
  userId: `u-${role}`, roles: [{ role }], teamIds: [], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...extra,
});

describe("jobs-portal catalog block", () => {
  it("non-org job grants are held by Sales roles only (the RLS policies rely on it)", () => {
    for (const role of ROLES) {
      for (const p of ["job:read", "job:manage"] as const) {
        const s = GRANTS[role][p];
        if (s !== undefined && s !== "org") expect(SALES_ROLES, `${role} ${p}`).toContain(role);
      }
    }
  });
  it("applicant and application permissions are org-wide HR only; applicant phones are org-sensitive", () => {
    for (const role of ROLES) {
      for (const p of ["applicant:read", "applicant.phone:read", "application:read", "application:manage"] as const) {
        if (GRANTS[role][p] !== undefined) { expect(role).toBe("hr"); expect(GRANTS[role][p]).toBe("org"); }
      }
    }
    expect(ORG_SENSITIVE_PERMISSIONS).toContain("applicant.phone:read");
    expect(isRestrictedRole("hr")).toBe(true);
  });
  it("job grants per role", () => {
    expect(GRANTS.recruiter["job:read"]).toBe("team");
    expect(GRANTS.recruiter["job:manage"]).toBeUndefined();
    expect(GRANTS.lead["job:manage"]).toBe("team");
    expect(GRANTS.manager["job:manage"]).toBe("hierarchy");
    expect(GRANTS.hr["job:manage"]).toBe("org");
    expect(GRANTS.ceo["job:manage"]).toBeUndefined();
  });
});

describe("jobAllowed", () => {
  const req = (o: Partial<JobRef> = {}): JobRef => ({ kind: "client_requirement", ownerId: "owner", teamId: "t1", hiringManagerId: null, ...o });
  it("client requirements: Sales roles at their scope", () => {
    expect(jobAllowed(user("recruiter", { teamIds: ["t1"] }), "job:read", req())).toBe(true);
    expect(jobAllowed(user("recruiter", { teamIds: ["t2"] }), "job:read", req())).toBe(false);
    expect(jobAllowed(user("recruiter", { teamIds: ["t1"] }), "job:manage", req())).toBe(false);
    expect(jobAllowed(user("lead", { teamIds: ["t1"] }), "job:manage", req())).toBe(true);
    expect(jobAllowed(user("manager", { subtreeTeamIds: ["t1"] }), "job:manage", req())).toBe(true);
    expect(jobAllowed(user("ceo"), "job:read", req())).toBe(true);
    expect(jobAllowed(user("hr"), "job:read", req())).toBe(false);
    expect(jobAllowed(user("hr"), "job:manage", req())).toBe(false);
  });
  it("internal openings: HR org-wide; the hiring manager reads", () => {
    const io = req({ kind: "internal_opening", teamId: null });
    expect(jobAllowed(user("hr"), "job:manage", io)).toBe(true);
    expect(jobAllowed(user("ceo"), "job:read", io)).toBe(false);
    expect(jobAllowed(user("lead", { teamIds: ["t1"] }), "job:read", io)).toBe(false);
    expect(jobAllowed(user("recruiter"), "job:read", { ...io, hiringManagerId: "u-recruiter" })).toBe(true);
    expect(jobAllowed(user("recruiter"), "job:manage", { ...io, hiringManagerId: "u-recruiter" })).toBe(false);
  });
  it("creatable kinds", () => {
    expect(creatableJobKinds(user("lead"))).toEqual(["client_requirement"]);
    expect(creatableJobKinds(user("hr"))).toEqual(["internal_opening"]);
    expect(creatableJobKinds(user("recruiter"))).toEqual([]);
  });
});

describe("rich text allow-list", () => {
  it("accepts paragraphs, lists, marks and https links", () => {
    const doc = { blocks: [
      { type: "p", runs: [{ text: "Hello " }, { text: "world", marks: ["b", "i"] }, { text: "site", href: "https://example.com/x?y=1" }] },
      { type: "ul", items: [[{ text: "one" }], [{ text: "two", marks: ["u", "s"] }]] },
    ] };
    expect(RichDocSchema.parse(doc)).toEqual(doc);
    expect(richToPlain(doc as never)).toBe("Hello worldsite\none\ntwo");
    expect(richExcerpt(doc as never, 8)).toBe("Hello w…");
  });
  it.each([
    [{ blocks: [{ type: "script", runs: [] }] }],
    [{ blocks: [{ type: "p", runs: [{ text: "x", href: "javascript:alert(1)" }] }] }],
    [{ blocks: [{ type: "p", runs: [{ text: "x", href: "http://example.com" }] }] }],
    [{ blocks: [{ type: "p", runs: [{ text: "x", marks: ["style"] }] }] }],
    [{ blocks: [{ type: "p", runs: [{ text: "x", onclick: "y" }] }] }],
    [{ blocks: [{ type: "p", runs: [{ text: "x" }], html: "<b>" }] }],
    [{ blocks: [{ type: "ul", items: [] }] }],
    [{ blocks: [], extra: 1 }],
    [{ blocks: [{ type: "p", runs: [{ text: "a\u0000b" }] }] }],
  ])("rejects %j", (doc) => {
    expect(RichDocSchema.safeParse(doc).success).toBe(false);
  });
  it("https only, no credentials", () => {
    expect(isSafeHttpsUrl("https://meet.example.com/abc")).toBe(true);
    expect(isSafeHttpsUrl("https://user:pw@example.com")).toBe(false);
    expect(isSafeHttpsUrl("data:text/html,x")).toBe(false);
    expect(isSafeHttpsUrl("https://exa mple.com")).toBe(false);
  });
});

describe("application status machine", () => {
  it("moves forward, rejects from any open state, never out of a final state", () => {
    expect(applicationTransitionAllowed("applied", "shortlisted")).toBe(true);
    expect(applicationTransitionAllowed("applied", "offered")).toBe(true);
    expect(applicationTransitionAllowed("offered", "shortlisted")).toBe(false);
    expect(applicationTransitionAllowed("interview_scheduled", "rejected")).toBe(true);
    expect(applicationTransitionAllowed("hired", "rejected")).toBe(false);
    expect(applicationTransitionAllowed("applied", "withdrawn")).toBe(false);
    expect(nextApplicationStatuses("offered")).toEqual(["hired", "rejected"]);
    expect(nextApplicationStatuses("withdrawn")).toEqual([]);
  });
});
