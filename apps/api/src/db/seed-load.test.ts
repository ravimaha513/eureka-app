import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTarget, loadUsers, mintedSid } from "./seed-load.js";

describe("load seed", () => {
  it("refuses production-looking targets and targets not named in LOAD_SEED_CONFIRM", () => {
    expect(() => checkTarget("postgres://u:p@eureka-production.abc.us-east-1.rds.amazonaws.com:5432/eureka", "eureka-production.abc.us-east-1.rds.amazonaws.com/eureka"))
      .toThrow(/looks like production/);
    expect(() => checkTarget("postgres://u:p@127.0.0.1:5432/eureka_prod", "127.0.0.1/eureka_prod")).toThrow(/production/);
    expect(() => checkTarget("postgres://u:p@127.0.0.1:5432/eureka_load", undefined)).toThrow(/LOAD_SEED_CONFIRM=127.0.0.1\/eureka_load/);
    expect(() => checkTarget("postgres://u:p@127.0.0.1:5432/eureka_load", "127.0.0.1/eureka")).toThrow(/LOAD_SEED_CONFIRM/);
    expect(() => checkTarget("postgres://u:p@127.0.0.1:5432/eureka_load", "127.0.0.1/eureka_load")).not.toThrow();
  });

  it("creates only fictional users, with the counts the k6 script signs in as", () => {
    const users = loadUsers();
    expect(users.every((u) => /^load-[a-z]+-\d{2,3}@eureka\.example$/.test(u.email))).toBe(true);
    expect(new Set(users.map((u) => u.email)).size).toBe(users.length);
    const counts: Record<string, number> = {};
    for (const u of users) counts[u.kind] = (counts[u.kind] ?? 0) + 1;
    const k6 = readFileSync(new URL("../../../../loadtest/eureka.js", import.meta.url), "utf8");
    const declared = /const COUNTS = (\{[^}]+\});/.exec(k6)![1]!.replace(/(\w+):/g, '"$1":');
    expect(JSON.parse(declared)).toEqual(counts);
  });

  it("derives minted session ids the way k6 does (hex HMAC-SHA256 of the email)", () => {
    // Same value as crypto.hmac("sha256", key, email, "hex") in k6.
    expect(mintedSid("k".repeat(32), "load-recruiter-001@eureka.example")).toMatch(/^[0-9a-f]{64}$/);
    expect(mintedSid("k".repeat(32), "a")).not.toBe(mintedSid("k".repeat(32), "b"));
  });
});
