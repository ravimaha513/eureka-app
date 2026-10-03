import { describe, expect, it } from "vitest";
import type { CandidateRef, UserAccess } from "./authz/engine.js";
import { WORK_AUTH_NUMBER_RE, normalizeWorkAuthNumber, workAuthAccess } from "./workAuthorization.js";

const user = (role: UserAccess["roles"][number]["role"], extra: Partial<UserAccess> = {}): UserAccess => ({
  userId: "u1", roles: [{ role }], teamIds: ["t1"], subordinateUserIds: [], subtreeTeamIds: [], coachedTeamIds: [], ...extra,
});
const cand: CandidateRef = { recruiterId: "u1", teamId: "t1", locationId: "l1", visibility: "all_teams", marketingStatus: "active" };

describe("work authorization access (conservative: visa:read only)", () => {
  it("HR reads, Immigration reads and edits; Sales, Accounts, Documents Team, CEO and admins see nothing", () => {
    expect(workAuthAccess(user("hr"), cand)).toEqual({ read: true, update: false });
    expect(workAuthAccess(user("immigration"), cand)).toEqual({ read: true, update: true });
    for (const r of ["recruiter", "lead", "manager", "ceo", "accounts", "documents_team", "associate_hr", "org_admin"] as const) {
      expect(workAuthAccess(user(r), cand), r).toEqual({ read: false, update: false });
    }
  });

  it("numbers are normalized and checked without echoing", () => {
    expect(normalizeWorkAuthNumber(" eac 219 001-2 ")).toBe("EAC219001-2");
    expect(WORK_AUTH_NUMBER_RE.test("EAC219001-2")).toBe(true);
    expect(WORK_AUTH_NUMBER_RE.test("-EAC")).toBe(false);
    expect(WORK_AUTH_NUMBER_RE.test("A".repeat(41))).toBe(false);
    expect(WORK_AUTH_NUMBER_RE.test("EAC/1")).toBe(false);
  });
});
