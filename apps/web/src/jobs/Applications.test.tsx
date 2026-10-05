import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap } from "../pipeline/testkit";
import { ApplicationsPage } from "./ApplicationsPage";
import { ApplicantsPage } from "./ApplicantsPage";
import type { Application, ApplicationDetail } from "./applicationsApi";

const app = (over: Partial<Application> = {}): Application => ({
  id: "ap1", status: "applied", appliedAt: "2026-10-01T10:00:00Z", statusChangedAt: "2026-10-01T10:00:00Z", rowVersion: 2, overallRating: 4,
  job: { id: "j1", title: "Sales Development Representative", kind: "internal_opening" }, company: null,
  applicant: { id: "p1", name: "Rakesh Uvsn", email: "r@example.com", phone: "+12125550123", phoneMasked: false, emailVerified: true },
  candidateId: null, actions: { transition: ["shortlisted", "offered", "rejected"], scheduleInterview: true, createCandidate: false }, ...over,
});
const detail = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  ...app(), interviews: [{ id: "i1", interviewType: "video", round: "technical", lead: { id: "u1", name: "Ajith Trainer" }, panel: [{ id: "u2", name: "Pawan" }],
    startsAt: "2026-10-22T16:55:00Z", durationMinutes: 30, meetingLink: "https://meet.example.com/x", status: "scheduled",
    scorecards: [{ id: "s1", reviewer: { id: "u1", name: "Ajith Trainer" }, technical: 4, communication: 4, problemSolving: 4, attitude: 5, notes: "Good", updatedAt: "2026-10-22T18:00:00Z" }],
    actions: { setStatus: true, scorecard: true } }],
  history: [{ id: "1", kind: "applied", at: "2026-10-01T10:00:00Z", actor: null, fromStatus: null, toStatus: "applied", comment: null }], ...over,
});

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/applications": () => ({ body: { items: [app()], nextCursor: null } }),
    "GET /api/v1/applications/ap1": () => ({ body: detail() }),
    "GET /api/v1/jobs": () => ({ body: { items: [], nextCursor: null } }),
    "POST /api/v1/applications/ap1/status": () => ({ body: { id: "ap1", status: "shortlisted", rowVersion: 3 } }),
    "PUT /api/v1/application-interviews/i1/scorecard": () => ({ body: { id: "s2" } }),
    "GET /api/v1/applicants": () => ({ body: { items: [{ id: "p1", name: "Rakesh Uvsn", email: "r@example.com", phone: "+12125550123", phoneMasked: true, emailVerified: true, createdAt: "2026-10-01T10:00:00Z", applications: 1 }], nextCursor: null } }),
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Applications (staff)", () => {
  it("lists job, applicant, company, applied date, rating and status; filters by status", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    const row = (await screen.findByText("Sales Development Representative", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("Rakesh Uvsn")).toBeInTheDocument();
    expect(within(row).getByText("Applied", { selector: ".badge" })).toHaveClass("app-applied");
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Hired" }));
    await waitFor(() => expect(api.gets("/api/v1/applications").at(-1)!.url.searchParams.get("status")).toBe("hired"));
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
  });

  it("drawer tabs; status change sends If-Match and the internal comment", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    expect(within(d).getByRole("tab", { name: "Job details" })).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("tab", { name: "Applicant" }));
    expect(within(d).getByText("r@example.com (verified)")).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("tab", { name: /Interviews/ }));
    expect(await within(d).findByText("Video")).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("button", { name: "Change status…" }));
    const dlg = await screen.findByRole("dialog", { name: "Application status" });
    fireEvent.change(within(dlg).getByLabelText(/Comment/), { target: { value: "Looks good" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.headers["if-match"]).toBe('"2"');
    expect(api.writes()[0]!.body).toEqual({ to: "shortlisted", comment: "Looks good" });
  });

  it("explains a stale status change", async () => {
    api.routes["POST /api/v1/applications/ap1/status"] = () => problem(412, { detail: "stale" });
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    fireEvent.click(within(d).getByRole("button", { name: "Change status…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Someone else changed/);
  });

  it("scorecard: scores 1-5 and notes go to the reviewer's own scorecard", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    fireEvent.click(within(d).getByRole("tab", { name: /Interviews/ }));
    fireEvent.click(await within(d).findByRole("button", { name: "Review Technical" }));
    const dlg = await screen.findByRole("dialog", { name: /Review/ });
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Attitude" })).getByLabelText("2"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(api.writes()[0]!.body).toEqual({ technical: 3, communication: 3, problemSolving: 3, attitude: 2 }));
  });

  it("applicants list masks the phone without applicant.phone:read", async () => {
    wrap(<ApplicantsPage />);
    const row = (await screen.findByText("Rakesh Uvsn", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("+12125550123")).toHaveClass("masked");
    expect(within(row).getByText("Yes")).toBeInTheDocument();
  });
});
