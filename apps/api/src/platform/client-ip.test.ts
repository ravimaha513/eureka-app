import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";
import { ipKey } from "./client-ip.js";

describe("ipKey", () => {
  it("keys IPv6 by /64, maps IPv4-in-IPv6, leaves IPv4", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    const a = ipKey("2001:db8:abcd:12:1:2:3:4");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:0db8:ABCD:0012:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipKey("2001:db8:abcd:13::1")).not.toBe(a);
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("RateLimiter bounds", () => {
  it("limits per key and never holds more than maxKeys keys, evicting the oldest first", () => {
    const l = new RateLimiter(2, 1000, () => 0, 100);
    expect([l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, false]);
    for (let i = 0; i < 10_000; i++) l.take(`k${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.take("a")).toBe(true); // evicted, fresh window
  });
});
