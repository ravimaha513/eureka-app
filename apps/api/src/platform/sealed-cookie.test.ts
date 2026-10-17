import { describe, expect, it } from "vitest";
import { openCookie, sealCookie } from "./sealed-cookie.js";

const SECRET = "test-secret-test-secret-test-secret-123";

describe("sealed cookies", () => {
  it("round-trips a value and refuses a tampered payload, MAC or extra segment", () => {
    const raw = sealCookie(SECRET, { state: "s", nonce: "n" });
    expect(openCookie(SECRET, raw)).toEqual({ state: "s", nonce: "n" });
    const [payload, sig] = raw.split(".");
    const other = Buffer.from(JSON.stringify({ state: "x", nonce: "n" })).toString("base64url");
    expect(openCookie(SECRET, `${other}.${sig}`)).toBeNull();
    expect(openCookie(SECRET, `${payload}.${sig!.slice(1)}`)).toBeNull();
    expect(openCookie(SECRET, `${raw}.x`)).toBeNull();
    expect(openCookie(SECRET, undefined)).toBeNull();
    expect(openCookie("another-secret-another-secret-12345", raw)).toBeNull();
  });

  it("opens only in the context it was bound to", () => {
    const raw = sealCookie(SECRET, { v: 1 }, "step-up|aa");
    expect(openCookie(SECRET, raw, "step-up|aa")).toEqual({ v: 1 });
    expect(openCookie(SECRET, raw, "step-up|bb")).toBeNull();
    expect(openCookie(SECRET, raw)).toBeNull();
  });
});
