import { describe, expect, it } from "vitest";
import { isRestrictedRole } from "@eureka/shared";
import { BootstrapError, parseAdmin, parseBootstrapArgs } from "./bootstrap.js";
import { DEMO_EMAIL_DOMAIN, DEMO_USERS, checkDemoEnvironment, checkDemoTarget } from "./demo-data.js";

const env = { GOOGLE_HOSTED_DOMAIN: "AceIntegrator.com" };
const fails = (argv: string[], re: RegExp, e: NodeJS.ProcessEnv = env) => {
  let err: unknown;
  try { parseBootstrapArgs(argv, e); } catch (x) { err = x; }
  expect(err).toBeInstanceOf(BootstrapError);
  expect((err as BootstrapError).exitCode).toBe(2);
  expect((err as Error).message).toMatch(re);
};

describe("bootstrap arguments", () => {
  it("accepts two admins, lowercases emails and the domain, and parses display names", () => {
    expect(parseBootstrapArgs(["--admin", "Ravi M <Ravi@AceIntegrator.com>", "--admin=ops@aceintegrator.com"], env)).toEqual({
      domain: "aceintegrator.com",
      demo: false,
      recover: false,
      admins: [{ email: "ravi@aceintegrator.com", displayName: "Ravi M" }, { email: "ops@aceintegrator.com", displayName: "ops" }],
    });
    expect(parseBootstrapArgs(["--admin", "a@aceintegrator.com", "--single-admin", "--demo-data", "--recover"], env)).toMatchObject({
      demo: true, recover: true, admins: [{ email: "a@aceintegrator.com" }],
    });
  });

  it("needs the hosted domain from the environment", () => {
    fails(["--admin", "a@x.com", "--admin", "b@x.com"], /GOOGLE_HOSTED_DOMAIN/, {});
    fails(["--admin", "a@x.com", "--admin", "b@x.com"], /GOOGLE_HOSTED_DOMAIN/, { GOOGLE_HOSTED_DOMAIN: "not a domain" });
    fails(["--admin", "a@x.com", "--admin", "b@x.com"], /GOOGLE_HOSTED_DOMAIN/, { GOOGLE_HOSTED_DOMAIN: "@x.com" });
  });

  it("rejects emails outside the hosted domain, subdomains and lookalikes included", () => {
    for (const e of ["a@gmail.com", "a@sub.aceintegrator.com", "a@aceintegrator.com.evil.io", "a@aceintegrator.co"]) {
      fails(["--admin", e, "--single-admin"], /not in the hosted domain/);
    }
    for (const e of ["aceintegrator.com", "a b@aceintegrator.com", "a@@aceintegrator.com", "<>", ""]) {
      fails(["--admin", e, "--single-admin"], /not an email/);
    }
  });

  it("requires two distinct admins unless --single-admin, and at most two", () => {
    fails([], /at least one --admin/);
    fails(["--admin", "a@aceintegrator.com"], /second admin.*--single-admin/s);
    fails(["--admin", "a@aceintegrator.com", "--admin", "A@AceIntegrator.com"], /must differ/);
    fails(["--admin", "a@aceintegrator.com", "--admin", "b@aceintegrator.com", "--admin", "c@aceintegrator.com"], /at most two/);
    fails(["--admin", "a@aceintegrator.com", "--admin", "b@aceintegrator.com", "--single-admin"], /conflicts/);
  });

  it("rejects unknown flags, missing values and bad display names", () => {
    fails(["--admin", "a@aceintegrator.com", "--admin", "b@aceintegrator.com", "--force"], /unknown argument: --force/);
    fails(["--admin"], /needs a value/);
    fails(["--admin", "--single-admin"], /needs a value/);
    fails(["--admin", `${"x".repeat(201)} <a@aceintegrator.com>`, "--single-admin"], /display name/);
    fails(["--admin", "Bad\u0007Name <a@aceintegrator.com>", "--single-admin"], /display name/);
  });

  it("never puts an email into an error message (they reach CloudWatch)", () => {
    for (const argv of [["--admin", "secret.person@gmail.com", "--single-admin"], ["--admin", "secret.person@@x", "--single-admin"]]) {
      let msg = "";
      try { parseBootstrapArgs(argv, env); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toBe("");
      expect(msg).not.toContain("secret.person");
    }
  });

  it("parses one admin spec", () => {
    expect(parseAdmin("  Jane Q. Admin   <JANE@aceintegrator.com> ", "aceintegrator.com"))
      .toEqual({ email: "jane@aceintegrator.com", displayName: "Jane Q. Admin" });
  });
});

describe("demo data", () => {
  it("uses placeholder emails that cannot be a Workspace account, and no restricted role", () => {
    expect(DEMO_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
    for (const u of DEMO_USERS) expect(isRestrictedRole(u.role), u.role).toBe(false);
    expect(DEMO_USERS.some((u) => u.role === "org_admin")).toBe(false);
  });

  it("needs EUREKA_ENVIRONMENT on the allow-list (staging or local), exactly", () => {
    for (const e of [undefined, "", "production", "prod", "Staging", "staging ", "dev"]) {
      expect(() => checkDemoEnvironment(e === undefined ? {} : { EUREKA_ENVIRONMENT: e }), String(e)).toThrow(/EUREKA_ENVIRONMENT/);
    }
    expect(() => checkDemoEnvironment({ EUREKA_ENVIRONMENT: "staging" })).not.toThrow();
    expect(() => checkDemoEnvironment({ EUREKA_ENVIRONMENT: "local" })).not.toThrow();
  });

  it("refuses before connecting: environment not allowed, or a production-looking host or database name", async () => {
    const staging = { EUREKA_ENVIRONMENT: "staging" };
    await expect(checkDemoTarget("postgres://u:p@10.0.0.5:1/eureka", { EUREKA_ENVIRONMENT: "production" }))
      .rejects.toMatchObject({ refused: true, message: expect.stringMatching(/EUREKA_ENVIRONMENT/) });
    await expect(checkDemoTarget("postgres://u:p@eureka-production.abc.us-east-1.rds.amazonaws.com:5432/eureka", staging))
      .rejects.toMatchObject({ refused: true, message: expect.stringMatching(/looks like production/) });
    await expect(checkDemoTarget("postgres://u:p@127.0.0.1:1/eureka_PROD", staging)).rejects.toMatchObject({ refused: true });
  });
});
