import { describe, expect, it } from "vitest";
import { GRANTS, ROLES, ROLE_TRAITS, roleClassification } from "./catalog.js";

/** Admin is only admin, per user (docs/roles-api.md "Admin separation"; migration 0480). */
describe("role classification", () => {
  it("built-in roles: org_admin is the only admin role, every other one is a data role", () => {
    expect(ROLES.filter((r) => roleClassification(ROLE_TRAITS[r], GRANTS[r]) === "admin")).toEqual(["org_admin"]);
    expect(ROLES.filter((r) => roleClassification(ROLE_TRAITS[r], GRANTS[r]) === "admin_compatible_only")).toEqual([]);
  });

  it("admin-compatible permissions do not make a data role; anything else does", () => {
    expect(roleClassification({ admin: false }, {})).toBe("admin_compatible_only");
    expect(roleClassification({ admin: false }, { "chat:use": "own", "staff.contact:read": "org", "technology:create": "org" }))
      .toBe("admin_compatible_only");
    expect(roleClassification({ admin: false }, { "chat:use": "own", "candidate:read": "own" })).toBe("data");
    // An admin-only permission without the admin trait is a violation, and counts as data.
    expect(roleClassification({ admin: false }, { "access:manage": "org" })).toBe("data");
    // The admin trait decides, whatever the grants.
    expect(roleClassification({ admin: true }, { "candidate:read": "org" })).toBe("admin");
    expect(roleClassification({ admin: true }, {})).toBe("admin");
  });
});
