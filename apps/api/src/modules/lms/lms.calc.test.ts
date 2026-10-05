import { describe, expect, it } from "vitest";
import { batchStatus, coursePercent, studentPercent } from "./lms.calc.js";

describe("lms calc", () => {
  const mods = [{ id: "a", durationMinutes: 60 }, { id: "b", durationMinutes: 180 }];
  it("course percent is duration weighted", () => {
    expect(coursePercent(mods, (id) => (id === "a" ? 100 : 0))).toBe(25);
    expect(coursePercent(mods, () => 100)).toBe(100);
  });
  it("plain mean when all durations are 0, 0 without modules", () => {
    expect(coursePercent([{ id: "a", durationMinutes: 0 }, { id: "b", durationMinutes: 0 }], (id) => (id === "a" ? 100 : 50))).toBe(75);
    expect(coursePercent([], () => 100)).toBe(0);
  });
  it("student percent is the mean of course percents", () => {
    expect(studentPercent([100, 50])).toBe(75);
    expect(studentPercent([])).toBe(0);
  });
  it("batch status", () => {
    expect(batchStatus("2026-01-01", "2026-02-01", "2026-03-01", false)).toBe("not_started");
    expect(batchStatus("2026-02-10", "2026-02-01", "2026-03-01", false)).toBe("in_progress");
    expect(batchStatus("2026-02-10", "2026-02-01", "2026-03-01", true)).toBe("completed");
    expect(batchStatus("2026-03-02", "2026-02-01", "2026-03-01", false)).toBe("completed");
  });
});
