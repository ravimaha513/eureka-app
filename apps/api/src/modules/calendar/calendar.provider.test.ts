import { describe, expect, it } from "vitest";
import { COACH_SCOPE, GoogleCalendarProvider, toCoachEvent } from "./calendar.provider.js";

const timed = { start: { dateTime: "2033-03-02T10:00:00-05:00" }, end: { dateTime: "2033-03-02T11:00:00-05:00" } };

describe("toCoachEvent: what the grid may show of a Google event", () => {
  it("keeps the title and the instants of an ordinary event", () => {
    expect(toCoachEvent({ ...timed, summary: "  Team sync " })).toEqual({
      allDay: false, startsAt: new Date("2033-03-02T15:00:00Z"), endsAt: new Date("2033-03-02T16:00:00Z"), title: "Team sync",
    });
  });
  it.each(["private", "confidential"])("masks the title of a %s event, even though the owner's token returns it", (visibility) => {
    expect(toCoachEvent({ ...timed, summary: "Doctor", visibility })).toMatchObject({ allDay: false, title: null });
  });
  it("leaves out declined and cancelled events", () => {
    expect(toCoachEvent({ ...timed, summary: "x", attendees: [{ self: true, responseStatus: "declined" }] })).toBeNull();
    expect(toCoachEvent({ ...timed, summary: "x", status: "cancelled" })).toBeNull();
  });
  it("keeps an event someone else declined", () => {
    expect(toCoachEvent({ ...timed, summary: "x", attendees: [{ self: false, responseStatus: "declined" }] })).not.toBeNull();
  });
  it("gives all-day events as dates", () => {
    expect(toCoachEvent({ start: { date: "2033-03-02" }, end: { date: "2033-03-03" }, summary: "Out of office" }))
      .toEqual({ allDay: true, startDate: "2033-03-02", endDate: "2033-03-03", title: "Out of office" });
  });
  it("drops an event with unusable times", () => {
    expect(toCoachEvent({ summary: "x" })).toBeNull();
    expect(toCoachEvent({ start: { dateTime: "nope" }, end: { dateTime: "nope" } })).toBeNull();
  });
});

describe("GoogleCalendarProvider for coaches", () => {
  const provider = () => {
    const p = new GoogleCalendarProvider("id", "secret");
    const calls: string[] = [];
    p.fetchImpl = (async (input: string) => {
      calls.push(String(input));
      if (String(input).includes("/token")) return new Response(JSON.stringify({ access_token: "a" }));
      if (String(input).includes("pageToken")) return new Response(JSON.stringify({ items: [{ ...timed, summary: "Second page" }] }));
      return new Response(JSON.stringify({ items: [{ ...timed, summary: "First page" }], nextPageToken: "p2" }));
    }) as typeof fetch;
    return { p, calls };
  };

  it("asks for read-only access, and never for the full calendar scope", () => {
    expect(COACH_SCOPE).toContain("calendar.events.readonly");
    expect(COACH_SCOPE.split(" ")).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(COACH_SCOPE.split(" ")).not.toContain("https://www.googleapis.com/auth/calendar.events");
    const url = new URL(new GoogleCalendarProvider("id", "secret").coachAuthUrl("https://x/cb", "st", "coach@x.example"));
    expect(url.searchParams.get("scope")).toBe(COACH_SCOPE);
    expect(url.searchParams.get("login_hint")).toBe("coach@x.example");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("follows pages, and never requests locations, descriptions, links or other attendees", async () => {
    const { p, calls } = provider();
    const events = await p.coachEvents("r", new Date("2033-03-01T00:00:00Z"), new Date("2033-03-08T00:00:00Z"));
    expect(events.map((e) => e.title)).toEqual(["First page", "Second page"]);
    const read = new URL(calls.find((c) => c.includes("/events"))!);
    const fields = read.searchParams.get("fields")!;
    for (const secret of ["location", "description", "hangoutLink", "conferenceData", "email", "htmlLink"]) expect(fields).not.toContain(secret);
    expect(read.searchParams.get("maxAttendees")).toBe("1");
    expect(read.pathname).toContain("/calendars/primary/events");
    expect(read.searchParams.getAll("eventTypes")).not.toContain("workingLocation");
  });

  it("carries Google's reason word, and nothing else from the body", async () => {
    const p = new GoogleCalendarProvider("id", "secret");
    p.fetchImpl = (async (input: string) => String(input).includes("/token")
      ? new Response(JSON.stringify({ access_token: "a" }))
      : new Response(JSON.stringify({ error: { message: "coach@x.example is blocked", errors: [{ reason: "accessNotConfigured", message: "coach@x.example" }] } }), { status: 403 })) as typeof fetch;
    const err = await p.coachEvents("r", new Date(0), new Date(1000)).catch((e: Error) => e);
    expect((err as Error).message).toBe("calendar events read failed (403 accessNotConfigured)");
  });

  it("drops a reason that isn't a single word", async () => {
    const p = new GoogleCalendarProvider("id", "secret");
    p.fetchImpl = (async (input: string) => String(input).includes("/token")
      ? new Response(JSON.stringify({ access_token: "a" }))
      : new Response(JSON.stringify({ error: { errors: [{ reason: "coach@x.example denied" }] } }), { status: 403 })) as typeof fetch;
    await expect(p.coachEvents("r", new Date(0), new Date(1000))).rejects.toThrow(/^calendar events read failed \(403\)$/);
  });

  it("does not carry Google's response body in an error", async () => {
    const p = new GoogleCalendarProvider("id", "secret");
    p.fetchImpl = (async (input: string) => String(input).includes("/token")
      ? new Response(JSON.stringify({ access_token: "a" }))
      : new Response("coach@x.example has no calendar", { status: 404 })) as typeof fetch;
    await expect(p.coachEvents("r", new Date(0), new Date(1000))).rejects.toThrow("calendar events read failed (404)");
    await expect(p.coachEvents("r", new Date(0), new Date(1000))).rejects.not.toThrow(/coach@/);
  });
});
