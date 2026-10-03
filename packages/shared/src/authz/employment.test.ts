import { describe, expect, it } from "vitest";
import { GRANTS, ROLES, type Role } from "./catalog.js";
import { NO_EMPLOYEE_ACTIONS, canManageEmployment, employeeActions } from "./employment.js";
import { resolveScope, type UserAccess } from "./engine.js";

const as = (role: Role): UserAccess => ({
  userId: "u1", roles: [{ role, locationId: role.startsWith("location_") ? "loc" : undefined }],
  teamIds: ["t1"], subordinateUserIds: [], subtreeTeamIds: ["t1"], coachedTeamIds: [],
});
const actor = { recruiterId: "r9", teamId: "t1", locationId: "loc" };
const onAssignment = { status: "on_assignment", hasOpenAssignment: true, lastEndReason: null, candidateStatus: "placed" };
const bench = { status: "bench", hasOpenAssignment: false, lastEndReason: "completed", candidateStatus: "bench" };

describe("employment actions", () => {
  it("only roles with assignment:update and employee:read at org scope manage employment (HR, Associate HR, Accounts)", () => {
    const managers = ROLES.filter((r) => canManageEmployment(as(r), actor));
    expect(managers.sort()).toEqual(["accounts", "associate_hr", "hr"]);
    for (const r of managers) expect(GRANTS[r]["employee:read"]).toBe("org");
  });

  it("employee:read is org-scoped wherever it is granted (B4.4)", () => {
    for (const r of ROLES) {
      const s = resolveScope(as(r), "employee:read");
      if (s) expect(s.all, r).toBe(true);
    }
  });

  it("follows the lifecycle: on assignment -> end/extend; bench -> exit/return to market", () => {
    expect(employeeActions(as("hr"), actor, onAssignment)).toEqual({ endAssignment: true, setEndDate: true, exit: false, returnToMarket: false });
    expect(employeeActions(as("hr"), actor, bench)).toEqual({ endAssignment: false, setEndDate: false, exit: true, returnToMarket: true });
    expect(employeeActions(as("hr"), actor, { ...bench, status: "exited" })).toEqual(NO_EMPLOYEE_ACTIONS);
  });

  it("no return to market after a failed background check, or when the candidate already left the bench", () => {
    expect(employeeActions(as("accounts"), actor, { ...bench, lastEndReason: "bgc_failed" }).returnToMarket).toBe(false);
    expect(employeeActions(as("accounts"), actor, { ...bench, candidateStatus: "active" }).returnToMarket).toBe(false);
    expect(employeeActions(as("accounts"), actor, { ...bench, candidateStatus: null }).returnToMarket).toBe(false);
  });

  it("read-only roles and an unreadable latest assignment get no actions", () => {
    for (const r of ["ceo", "bu_head", "immigration", "recruiter", "manager"] as Role[]) {
      expect(employeeActions(as(r), actor, onAssignment), r).toEqual(NO_EMPLOYEE_ACTIONS);
    }
    expect(employeeActions(as("hr"), null, onAssignment)).toEqual(NO_EMPLOYEE_ACTIONS);
  });
});
