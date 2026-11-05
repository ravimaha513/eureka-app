import { describe, expect, it } from "vitest";
import {
  ADMIN_COMPATIBLE_PERMISSIONS, ADMIN_PERMISSIONS, GRANTS, PERMISSIONS, ROLES, ROLE_TRAITS, adminSeparationViolations,
} from "./catalog.js";

/** Admin/data separation (docs/roles-api.md; security review C-01). */
describe("admin separation", () => {
  it("every built-in role complies", () => {
    for (const role of ROLES) expect(adminSeparationViolations(ROLE_TRAITS[role], GRANTS[role]), role).toEqual([]);
  });

  it("admin permissions are held by admin-trait roles only, and the lists are disjoint catalog permissions", () => {
    expect(ROLES.filter((r) => ADMIN_PERMISSIONS.some((p) => GRANTS[r][p] !== undefined))).toEqual(["org_admin"]);
    expect([...ADMIN_PERMISSIONS, ...ADMIN_COMPATIBLE_PERMISSIONS].every((p) => PERMISSIONS.includes(p))).toBe(true);
    expect(ADMIN_PERMISSIONS.filter((p) => ADMIN_COMPATIBLE_PERMISSIONS.includes(p))).toEqual([]);
  });

  it("flags admin permissions on a non-admin role and business permissions on an admin role", () => {
    expect(adminSeparationViolations({ admin: false }, { "access:manage": "org", "candidate:read": "org" })).toEqual(["access:manage"]);
    expect(adminSeparationViolations({ admin: true }, { "access:manage": "org", "chat:use": "own", "candidate:read": "org" }))
      .toEqual(["candidate:read"]);
  });
});
