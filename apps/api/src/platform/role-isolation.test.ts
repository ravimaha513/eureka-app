import { describe, expect, it } from "vitest";
import { assertImportRoleIsolated, importRoleMemberships, type Queryable } from "./role-isolation.js";

const fake = (roles: string[]): Queryable => ({
  query: async <R>() => ({ rows: roles.map((role) => ({ role })) as R[] }),
});

describe("import role isolation", () => {
  it("passes when eureka_import is a member of no Eureka role", async () => {
    await expect(assertImportRoleIsolated(fake([]))).resolves.toBeUndefined();
  });
  it("fails fast and names the roles otherwise", async () => {
    expect(await importRoleMemberships(fake(["eureka_app"]))).toEqual(["eureka_app"]);
    await expect(assertImportRoleIsolated(fake(["eureka_app", "authz_definer"]))).rejects.toThrow(/eureka_app, authz_definer/);
  });
});
