import { describe, expect, it } from "vitest";
import { addDays, hourRange, layOutLanes, minutesWithinDay, mondayOf, coversDay, mergeGoogleEvents, findClashes, overlapping } from "./coachCalendarLayout";

const span = (s: { start: number; end: number }) => s;

describe("coach calendar layout", () => {
  it("finds the Monday of a week, across a month end", () => {
    expect(mondayOf("2026-11-05")).toBe("2026-11-02");
    expect(mondayOf("2026-11-02")).toBe("2026-11-02");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("reads minutes in the zone and clips an interview crossing midnight", () => {
    expect(minutesWithinDay("2026-11-05T15:00:00Z", "2026-11-05T16:30:00Z", "2026-11-05", "America/New_York")).toEqual({ start: 600, end: 690 });
    expect(minutesWithinDay("2026-11-06T04:30:00Z", "2026-11-06T05:30:00Z", "2026-11-05", "America/New_York")).toEqual({ start: 1410, end: 1440 });
    expect(minutesWithinDay("2026-11-06T04:30:00Z", "2026-11-06T05:30:00Z", "2026-11-06", "America/New_York")).toEqual({ start: 0, end: 30 });
  });

  it("widens working hours only as far as the interviews need", () => {
    expect(hourRange([])).toEqual({ first: 9, last: 18 });
    expect(hourRange([{ start: 450, end: 500 }, { start: 1200, end: 1230 }])).toEqual({ first: 7, last: 21 });
  });

  it("puts double-booked interviews side by side and leaves touching ones alone", () => {
    const a = { start: 660, end: 720 }, b = { start: 690, end: 750 }, c = { start: 750, end: 780 };
    const out = layOutLanes([c, b, a], span);
    expect(out.map((x) => [x.item, x.lane, x.lanes, x.overlaps])).toEqual([[a, 0, 2, true], [b, 1, 2, true], [c, 0, 1, false]]);
  });

  it("reuses a freed lane within one overlapping group", () => {
    const a = { start: 0, end: 100 }, b = { start: 10, end: 20 }, c = { start: 30, end: 40 };
    expect(layOutLanes([a, b, c], span).map((x) => [x.lane, x.lanes])).toEqual([[0, 2], [1, 2], [1, 2]]);
  });
});

describe("Google events on the grid", () => {
  const at = (coachId: string, startsAt: string, endsAt: string, title?: string) => ({ coachId, startsAt, endsAt, title });
  it("drops a Google event at exactly a coach's interview time, whatever the offset says", () => {
    const merged = mergeGoogleEvents(
      [at("a", "2033-03-02T15:00:00.000Z", "2033-03-02T16:00:00.000Z")],
      [at("a", "2033-03-02T10:00:00-05:00", "2033-03-02T11:00:00-05:00", "Interview invite")],
    );
    expect(merged).toHaveLength(1);
  });
  it("keeps a real overlap, and the same time on another coach", () => {
    const merged = mergeGoogleEvents(
      [at("a", "2033-03-02T15:00:00.000Z", "2033-03-02T16:00:00.000Z")],
      [at("a", "2033-03-02T15:30:00.000Z", "2033-03-02T16:00:00.000Z"), at("b", "2033-03-02T15:00:00.000Z", "2033-03-02T16:00:00.000Z")],
    );
    expect(merged).toHaveLength(3);
  });
  it("treats an all-day end date as exclusive", () => {
    const e = { startDate: "2033-03-02", endDate: "2033-03-04" };
    expect(["2033-03-01", "2033-03-02", "2033-03-03", "2033-03-04"].map((d) => coversDay(e, d))).toEqual([false, true, true, false]);
  });
});

describe("double-bookings across the grid", () => {
  const at = (coachId: string, s: string, e: string) => ({ coachId, startsAt: `2033-03-02T${s}:00Z`, endsAt: `2033-03-02T${e}:00Z` });
  it("flags only events that overlap the same coach, not touching ones or other coaches", () => {
    const a = at("a", "15:00", "16:00"), b = at("a", "15:30", "16:30"), c = at("a", "16:30", "17:00"), d = at("b", "15:00", "16:00");
    const clashes = findClashes([a, b, c, d]);
    expect([a, b, c, d].map((e) => clashes.has(e))).toEqual([true, true, false, false]);
    expect(overlapping(a, [a, b, c, d])).toEqual([b]);
    expect(overlapping(c, [a, b, c, d])).toEqual([]);
  });
});
