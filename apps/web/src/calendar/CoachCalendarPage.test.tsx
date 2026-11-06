import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { LOCAL_ZONE, todayIn, zoneDayBoundary } from "../pipeline/zones";
import { addDays } from "./coachCalendarLayout";
import { CoachCalendarPage } from "./CoachCalendarPage";

const ME: Me = { id: "u-me", email: "me@eureka.example", displayName: "Me", roles: [], capabilities: [], csrfToken: "tok" };
// Tomorrow, so nothing reads as finished; the tests step forward one day first.
const DAY = addDays(todayIn(LOCAL_ZONE), 1);
const at = (h: number, m = 0) => new Date(Date.parse(zoneDayBoundary(DAY, LOCAL_ZONE)) + (h * 60 + m) * 60_000).toISOString();
const interview = (coachId: string, id: string, name: string, h: number, m: number, minutes: number) =>
  ({ coachId, interviewId: id, candidateName: name, round: "Technical", callStatus: null, startsAt: at(h, m), endsAt: at(h, m + minutes) });

// Shapes from docs/coach-calendar-api.md (GET /api/v1/coach-calendar and /google).
const CALENDAR = {
  canManage: false,
  coaches: [{ id: "c1", name: "Jason", detail: "full" }, { id: "c2", name: "Prakash", detail: "full" }, { id: "c3", name: "Amira", detail: "full" }],
  events: [
    interview("c1", "i1", "Maya Chen", 10, 0, 45),
    interview("c1", "i2", "Liam Brooks", 10, 30, 45),
    interview("c2", "i3", "Nora Patel", 11, 0, 45),
    interview("c3", "i4", "Alex Rivera", 14, 0, 30),
  ],
};
const GOOGLE = { enabled: false, me: { canConnect: false, connected: false, accountEmail: null }, coaches: [], events: [], allDay: [] };

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = path === "/api/v1/coach-calendar" ? CALENDAR : path === "/api/v1/coach-calendar/google" ? GOOGLE : null;
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

const renderPage = (onOpenInterview = vi.fn()) => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CoachCalendarPage me={ME} onOpenInterview={onOpenInterview} />
  </QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  return onOpenInterview;
};
const timeline = () => screen.findByRole("region", { name: "Day timeline by coach" });

describe("Coach calendar", () => {
  it("lays coaches out as rows and opens a double-booked interview with what it overlaps", async () => {
    const open = renderPage();
    const grid = await timeline();
    for (const name of [/^Jason: 2 interviews, 2 double-booked/, /^Prakash: 1 interview\./, /^Amira: 1 interview\./]) {
      expect(within(grid).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/2 double-booked/, { selector: ".cc-count *" })).toBeInTheDocument();

    fireEvent.click(within(grid).getByRole("button", { name: /^Maya Chen, Technical, .*, double-booked$/ }));
    const drawer = await screen.findByRole("dialog", { name: "Maya Chen" });
    expect(within(drawer).getByText("Jason has 1 other event at the same time.")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /^Liam Brooks, Technical/ })).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Open interview" }));
    expect(open).toHaveBeenCalledWith("i1");
  });

  it("shows only the chosen coaches, remembers them, and can narrow to double-bookings", async () => {
    renderPage();
    const grid = await timeline();
    fireEvent.click(screen.getByRole("button", { name: /All 3 coaches/ }));
    const menu = screen.getByRole("group", { name: "Choose coaches" });
    fireEvent.click(within(menu).getByRole("checkbox", { name: /Amira/ }));
    fireEvent.click(within(menu).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: /2 of 3 coaches/ })).toHaveFocus();
    expect(within(grid).queryByRole("button", { name: /^Amira:/ })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("eureka.coachCalendar.coaches")!)).toEqual(["c1", "c2"]);
    expect(screen.getByRole("button", { name: "Remove Jason" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Double-booked only" }));
    expect(within(await timeline()).queryByRole("button", { name: /^Prakash:/ })).not.toBeInTheDocument();
    expect(within(await timeline()).getByRole("button", { name: /^Jason:/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all coaches" }));
    expect(window.localStorage.getItem("eureka.coachCalendar.coaches")).toBeNull();
  });

  it("lists the day in time order in the agenda, and a coach's day in the drawer", async () => {
    renderPage();
    await timeline();
    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    const rows = screen.getAllByRole("button", { name: /, Technical, / }).map((b) => b.getAttribute("aria-label")!.split(",")[0]);
    expect(rows).toEqual(["Maya Chen", "Liam Brooks", "Nora Patel", "Alex Rivera"]);

    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Maya Chen,/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Maya Chen" })).getByRole("button", { name: "See Jason’s day" }));
    const day = await screen.findByRole("dialog", { name: "Jason’s day" });
    expect(within(day).getAllByRole("button", { name: /, Technical, / })).toHaveLength(2);
  });
});
