import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the limit per window and per key, then resets", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
    expect(rl.take("b")).toBe(true);
    t = 1000;
    expect(rl.take("a")).toBe(true);
  });
});
