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
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("Applications (staff)", () => {
  it("keeps status, job and applicant search in the address bar", async () => {
    window.history.replaceState(null, "", "/applications?status=hired&jobId=j1&q=rak");
    wrap(<ApplicationsPage me={meFor("hr")} />);
    await screen.findByText("Rakesh Uvsn", { selector: "b" });
    const last = () => api.gets("/api/v1/applications").at(-1)!.url.searchParams;
    expect([last().get("status"), last().get("jobId"), last().get("search")]).toEqual(["hired", "j1", "rak"]);
    expect(screen.getByLabelText("Applicant")).toHaveValue("rak");
    fireEvent.change(screen.getByLabelText("Applicant"), { target: { value: "uvsn" } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("q")).toBe("uvsn"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("lists applicant first, then status, job, company, applied date and rating; filters by status", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    const row = (await screen.findByText("Rakesh Uvsn", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("Sales Development Representative")).toBeInTheDocument();
    expect(within(row).getByText("r@example.com")).toBeInTheDocument();
    expect(within(row).getByText("Applied", { selector: ".badge" })).toHaveClass("app-applied");
    expect(within(row).getByRole("link", { name: "Open application of Rakesh Uvsn" })).toHaveAttribute("href", "/applications/ap1");
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "hired" } });
    await waitFor(() => expect(api.gets("/api/v1/applications").at(-1)!.url.searchParams.get("status")).toBe("hired"));
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
  });

  it("drawer opens on the applicant; status has no preselection, warns about the email, sends If-Match and the comment", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("link", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    expect(within(d).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(within(d).getByRole("tab", { name: "Job details" })).toBeInTheDocument();
    expect(within(d).getByText("r@example.com (verified)")).toBeInTheDocument();
    expect(await within(d).findByText("Video")).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("button", { name: "Change status…" }));
    const dlg = await screen.findByRole("dialog", { name: "Application status" });
    expect(within(dlg).getByRole("combobox", { name: "Status" })).toHaveValue("");
    expect(within(dlg).getByText("This emails the applicant.")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Save status" }));
    expect(await within(dlg).findByText("Choose the new status.")).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Status" }), { target: { value: "shortlisted" } });
    fireEvent.change(within(dlg).getByLabelText(/Comment/), { target: { value: "Looks good" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.headers["if-match"]).toBe('"2"');
    expect(api.writes()[0]!.body).toEqual({ to: "shortlisted", comment: "Looks good" });
  });

  it("explains a stale status change", async () => {
    api.routes["POST /api/v1/applications/ap1/status"] = () => problem(412, { detail: "stale" });
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("link", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    fireEvent.click(within(d).getByRole("button", { name: "Change status…" }));
    const dlg = await screen.findByRole("dialog", { name: "Application status" });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Status" }), { target: { value: "rejected" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Someone else changed/);
  });

  it("scorecard: a new review starts unrated and needs all four scores", async () => {
    wrap(<ApplicationsPage me={meFor("hr")} />);
    fireEvent.click(await screen.findByRole("link", { name: "Open application of Rakesh Uvsn" }));
    const d = await screen.findByRole("dialog", { name: /Sales Development Representative/ });
    fireEvent.click(await within(d).findByRole("button", { name: "Review Technical" }));
    const dlg = await screen.findByRole("dialog", { name: /Review/ });
    for (const g of ["Technical skills", "Communication", "Problem solving", "Attitude"]) {
      expect(within(within(dlg).getByRole("group", { name: g })).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    }
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Attitude" })).getByLabelText("2"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Rate all four areas (3 left).");
    expect(api.writes()).toHaveLength(0);
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Technical skills" })).getByLabelText("4"));
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Communication" })).getByLabelText("3"));
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Problem solving" })).getByLabelText("5"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(api.writes()[0]!.body).toEqual({ technical: 4, communication: 3, problemSolving: 5, attitude: 2 }));
  });

  it("create candidate asks for the phone when the applicant's is masked, and sends it normalized (CA-6)", async () => {
    const hired = detail({ status: "hired", applicant: { ...app().applicant, phone: "+1 212•••0123", phoneMasked: true },
      actions: { transition: [], scheduleInterview: false, createCandidate: true } });
    api.routes["GET /api/v1/applications/ap1"] = () => ({ body: hired });
    api.routes["GET /api/v1/lookups"] = () => ({ body: { technologies: [{ id: "t1", name: "Java" }], locations: [{ id: "l1", name: "Dallas" }],
      clients: [], vendors: [], implementationPartners: [], roles: [], coaches: [] } });
    api.routes["POST /api/v1/applications/ap1/candidate"] = () => ({ status: 201, body: { candidateId: "c1" } });
    wrap(<ApplicationsPage me={meFor("lead")} />);
    fireEvent.click(await screen.findByRole("link", { name: "Open application of Rakesh Uvsn" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create candidate…" }));
    const dlg = await screen.findByRole("dialog", { name: /Create candidate/ });
    expect(within(dlg).queryByLabelText("Personal email")).not.toBeInTheDocument();
    await within(dlg).findByRole("option", { name: "Java" });
    fireEvent.change(within(dlg).getByLabelText("Technology"), { target: { value: "t1" } });
    fireEvent.change(within(dlg).getByLabelText("Location"), { target: { value: "l1" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/phone number/i);
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Phone"), { target: { value: "+1 (212) 555-0199" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create candidate" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ technologyId: "t1", locationId: "l1", phone: "+12125550199" });
  });

  it("schedules with a checkbox panel picker (no Ctrl multi-select) and says the applicant is emailed", async () => {
    api.routes["GET /api/v1/jobs/options"] = () => ({ body: { kinds: [], clients: [], staff: [{ id: "u1", name: "Ajith Trainer" }, { id: "u2", name: "Pawan" }, { id: "u3", name: "Mira" }] } });
    api.routes["POST /api/v1/applications/ap1/interviews"] = () => ({ status: 201, body: { id: "i9" } });
    wrap(<ApplicationsPage me={{ ...meFor("hr"), id: "u1" }} />);
    fireEvent.click(await screen.findByRole("link", { name: "Open application of Rakesh Uvsn" }));
    fireEvent.click(await screen.findByRole("button", { name: "Schedule interview…" }));
    const dlg = await screen.findByRole("dialog", { name: "Schedule interview" });
    expect(within(dlg).queryByRole("listbox")).toBeNull();
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: "Pawan" }));
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "Mira" }));
    expect(within(dlg).getByText(/This emails the applicant/)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Schedule interview" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ leadUserId: "u1", panelUserIds: ["u2", "u3"] });
  });

  it("applicants list masks the phone without applicant.phone:read and links to the person's applications", async () => {
    wrap(<ApplicantsPage />);
    const row = (await screen.findByText("Rakesh Uvsn", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("+12125550123")).toHaveClass("masked");
    expect(within(row).queryByText("Unverified")).toBeNull();
    expect(within(row).getByRole("link", { name: "1 application of Rakesh Uvsn" })).toHaveAttribute("href", "/applications?q=Rakesh%20Uvsn");
  });
});
