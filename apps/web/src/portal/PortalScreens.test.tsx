import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, wrap } from "../pipeline/testkit";
import { PortalApp } from "./PortalApp";
import { postedAgo } from "./PortalJobs";
import type { PortalApplication, PortalJob } from "./portalApi";

const ME = { id: "a1", firstName: "Rakesh", lastName: "Uvsn", email: "r@example.com", phone: "+12125550123", emailVerified: true, csrfToken: "ptok" };
const job = (id: string, over: Partial<PortalJob> = {}): PortalJob => ({
  id, title: "HR Generalist", employer: null, category: "hr", experienceLevel: "mid", employmentType: "full_time", workMode: "hybrid",
  status: "open", location: "Dallas, TX", deadline: null, workHours: 40, pay: null, skills: ["HRIS"], excerpt: "Support hiring and onboarding.",
  requirements: null, description: { blocks: [{ type: "p", runs: [{ text: "Full description text" }] }] },
  postedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), applied: false, applicationId: null, ...over,
});
const APP: PortalApplication = {
  id: "ap1", status: "interview_scheduled", appliedAt: "2026-10-01T10:00:00Z", statusChangedAt: "2026-10-02T10:00:00Z", canWithdraw: true,
  job: { id: "j1", title: "HR Generalist", employer: null, workMode: "hybrid", employmentType: "full_time", status: "open", location: "Dallas" },
  interviews: [{ id: "i1", interviewType: "video", round: "technical", startsAt: "2026-10-22T16:55:00Z", durationMinutes: 30, status: "scheduled", meetingLink: "https://meet.example.com/x" }],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/portal/me": () => ({ body: ME }),
    "GET /api/portal/jobs": () => ({ body: { items: [job("j1"), job("j2", { title: "Sales Rep", applied: true, applicationId: "ap1" })], nextCursor: null } }),
    "GET /api/portal/jobs/j1": () => ({ body: job("j1") }),
    "POST /api/portal/jobs/j1/apply": () => ({ status: 201, body: { id: "ap9" } }),
    "GET /api/portal/applications": () => ({ body: { items: [APP] } }),
    "GET /api/portal/applications/ap1": () => ({ body: APP }),
    "POST /api/portal/applications/ap1/withdraw": () => ({ body: { id: "ap1", status: "withdrawn" } }),
  });
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("portal screens", () => {
  it("postedAgo", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(postedAgo("2026-10-01T12:00:00Z", now)).toBe("4 days ago");
    expect(postedAgo("2026-10-05T01:00:00Z", now)).toBe("Posted today");
  });

  it("Finding Job: cards with pills, posted time, Apply now / Applied; applies with the portal headers", async () => {
    window.history.replaceState(null, "", "/portal/jobs");
    wrap(<PortalApp />);
    const card = await screen.findByRole("article", { name: "HR Generalist" });
    expect(within(card).getByText("Hybrid")).toBeInTheDocument();
    expect(within(card).getByText("Full time")).toBeInTheDocument();
    expect(within(card).getByText("4 days ago")).toBeInTheDocument();
    expect(within(await screen.findByRole("article", { name: "Sales Rep" })).getByRole("button", { name: "Applied" })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "Apply now" }));
    await waitFor(() => expect(api.writes()[0]!.path).toBe("/api/portal/jobs/j1/apply"));
    expect(api.writes()[0]!.headers["x-csrf-token"]).toBe("ptok");
    expect(await screen.findByText(/Application sent/)).toBeInTheDocument();
  });

  it("View details shows the description as text", async () => {
    window.history.replaceState(null, "", "/portal/jobs");
    wrap(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "View details of HR Generalist" }));
    expect(await screen.findByText("Full description text")).toBeInTheDocument();
  });

  it("My Applications: status, interviews without internal data, Withdraw confirmation", async () => {
    window.history.replaceState(null, "", "/portal/applications");
    wrap(<PortalApp />);
    const row = (await screen.findByText("HR Generalist", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("Interview scheduled")).toHaveClass("badge", "app-interview_scheduled");
    fireEvent.click(within(row).getByRole("button", { name: "View application for HR Generalist" }));
    const d = await screen.findByRole("dialog", { name: "HR Generalist" });
    expect(within(d).getByText("Technical")).toBeInTheDocument();
    expect(within(d).getByText("Video")).toBeInTheDocument();
    expect(d.textContent).not.toMatch(/rating|notes|panel/i);
    fireEvent.click(within(d).getByRole("button", { name: "Close application details" }));
    fireEvent.click(within(row).getByRole("button", { name: "Withdraw application for HR Generalist" }));
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(api.writes()[0]!.path).toBe("/api/portal/applications/ap1/withdraw"));
    expect(await screen.findByText("Application withdrawn.")).toBeInTheDocument();
  });
});
