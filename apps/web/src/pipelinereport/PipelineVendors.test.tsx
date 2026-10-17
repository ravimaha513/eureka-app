import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV } from "../nav";
import { LOOKUPS, mockApi, problem, wrap } from "../pipeline/testkit";
import { AssessmentsSection } from "./AssessmentsSection";
import { NonResponseCard } from "./NonResponseCard";
import { PipelineReportPage } from "./PipelineReportPage";
import { PreferredVendorsPage } from "./PreferredVendorsPage";
import type { PipelineReport, PreferredVendor } from "./pipelineReportApi";

const REPORT: PipelineReport = {
  period: null, total: 2,
  funnel: { marketing: 2, submitted: 1, interviewing: 1, assessment: 1, confirmed: 1, paperwork: 1, joined: 0 },
  notResponding: 1, byStage: { paperwork: 1, marketing: 1 }, limit: 50, offset: 0,
  items: [
    {
      candidate: { id: "c1", name: "Asha Iyer" }, technology: { id: "t", name: "Java" }, team: { id: "tm", name: "Team Rohit" },
      recruiter: { id: "r", name: "Ravi" }, location: { id: "l", name: "Dallas" }, marketingStatus: "confirmation",
      marketingStartDate: "2030-03-01", submissions: { count: 2, lastAt: "2030-03-04T10:00:00Z" },
      interviews: { count: 1, cleared: 1, lastAt: null }, assessments: { count: 1, passed: 1, lastOn: "2030-03-05" },
      placement: { id: "p", status: "paperwork", confirmedAt: "2030-03-10T00:00:00Z", tentativeStart: "2030-04-01", joinedAt: null, paperwork: { done: 2, total: 5 } },
      notResponding: false, stage: "paperwork",
    },
    {
      candidate: { id: "c2", name: "Divya Menon" }, technology: { id: "t", name: "Java" }, team: { id: "tm", name: "Team Rohit" },
      recruiter: null, location: { id: "l", name: "Dallas" }, marketingStatus: "active", marketingStartDate: null,
      submissions: { count: 0, lastAt: null }, interviews: { count: 0, cleared: 0, lastAt: null },
      assessments: { count: 0, passed: 0, lastOn: null }, placement: null, notResponding: true, stage: "marketing",
    },
  ],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => { api = mockApi({ "GET /api/v1/lookups": () => ({ body: LOOKUPS }) }); });
afterEach(() => vi.restoreAllMocks());

describe("navigation", () => {
  it("shows the pipeline to report readers and vendors to either vendor permission", () => {
    expect(NAV.find((n) => n.key === "pipeline")?.anyOf).toEqual(["report:read"]);
    expect(NAV.find((n) => n.key === "vendors")?.anyOf).toEqual(["vendor.preferred:create", "vendor.preferred:read"]);
  });
});

describe("Candidate pipeline", () => {
  it("shows the funnel and one row per candidate, and sends the filters", async () => {
    api.routes["GET /api/v1/reports/pipeline"] = () => ({ body: REPORT });
    wrap(<PipelineReportPage />);
    const table = await screen.findByRole("table", { name: "Candidate pipeline" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Paperwork 2/5")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Not responding")).toBeInTheDocument();
    const funnel = screen.getByRole("list", { name: "Pipeline funnel" });
    expect(within(funnel).getByText("Assessments").nextSibling).toHaveTextContent("1");
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "joined" } });
    fireEvent.click(screen.getByLabelText("Not responding only"));
    await waitFor(() => {
      const last = api.gets("/api/v1/reports/pipeline").at(-1)!.url.searchParams;
      expect(last.get("stage")).toBe("joined");
      expect(last.get("notResponding")).toBe("true");
      expect(last.get("offset")).toBe("0");
    });
  });

  it("explains a refusal", async () => {
    api.routes["GET /api/v1/reports/pipeline"] = () => problem(403);
    wrap(<PipelineReportPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You are not allowed to do this.");
  });
});

describe("Assessments in the submission drawer", () => {
  it("records an assessment and requires the completion date for a result", async () => {
    let items: unknown[] = [];
    api.routes["GET /api/v1/submissions/s1/assessments"] = () => ({ body: { items, actions: { create: true, update: true } } });
    api.routes["POST /api/v1/submissions/s1/assessments"] = (_u, body) => {
      items = [{ id: "a1", submissionId: "s1", candidateId: "c1", rowVersion: 1, createdAt: "", updatedAt: "", ...(body as object) }];
      return { status: 201, body: items[0] };
    };
    wrap(<AssessmentsSection submissionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Record assessment" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "passed" } });
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Completed on"), { target: { value: "2030-03-06" } });
    fireEvent.change(screen.getByLabelText("Score 0-100 (optional)"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByText("Passed", { selector: ".badge" })).toBeInTheDocument();
    expect(api.writes()[0]!.body).toMatchObject({ platform: "glider", status: "passed", completedOn: "2030-03-06", score: 88 });
  });

  it("is hidden when there is nothing to show or do", async () => {
    api.routes["GET /api/v1/submissions/s2/assessments"] = () => ({ body: { items: [], actions: { create: false, update: false } } });
    const { container } = wrap(<AssessmentsSection submissionId="s2" />);
    await waitFor(() => expect(api.gets("/api/v1/submissions/s2/assessments")).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Not responding card", () => {
  it("flags a candidate and resolves the flag", async () => {
    let state = { current: null as unknown, history: [] as unknown[], actions: { flag: true, resolve: false } };
    api.routes["GET /api/v1/candidates/c1/non-response"] = () => ({ body: state });
    api.routes["POST /api/v1/candidates/c1/non-response"] = (_u, body) => {
      state = {
        current: { id: "f1", reason: (body as { reason: string }).reason, status: "open", resolution: null, flaggedAt: "2030-03-01T10:00:00Z",
          flaggedBy: "Ravi", resolvedAt: null, holdReachedAt: null, candidateWarnedAt: null, candidateHoldNoticeAt: null },
        history: [], actions: { flag: false, resolve: true },
      };
      return { status: 201, body: { id: "f1" } };
    };
    api.routes["POST /api/v1/candidates/c1/non-response/resolve"] = () => problem(409, { detail: "stale" });
    wrap(<NonResponseCard candidateId="c1" />);
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "missed_interview" } });
    fireEvent.click(screen.getByRole("button", { name: "Flag as not responding" }));
    expect(await screen.findByText(/^Not responding$/, { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText(/Missed an interview/, { selector: ".note" })).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({ reason: "missed_interview" });
    fireEvent.click(screen.getByRole("button", { name: "Candidate responded" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this");
  });
});

describe("Preferred vendors", () => {
  const vendor = (extra: Partial<PreferredVendor> = {}): PreferredVendor => ({
    id: "v1", owner: { id: "u-me", name: "Test User" }, vendorName: "Acme Staffing", vendor: null, contactName: "Jo",
    contactEmail: "jo@acme.example", contactPhone: null, technology: null, clients: "Northwind", notes: null, archived: false,
    createdAt: "", updatedAt: "", rowVersion: 3, actions: { edit: true, archive: true }, ...extra,
  });

  it("adds and edits (with If-Match) a vendor", async () => {
    api.routes["GET /api/v1/preferred-vendors"] = () => ({ body: { items: [vendor()], total: 1, owners: [{ id: "u-me", name: "Test User" }], actions: { create: true } } });
    api.routes["POST /api/v1/preferred-vendors"] = (_u, body) => ({ status: 201, body: vendor({ id: "v2", ...(body as object) }) });
    api.routes["PATCH /api/v1/preferred-vendors/v1"] = (_u, body) => ({ body: vendor(body as Partial<PreferredVendor>) });
    wrap(<PreferredVendorsPage />);
    const table = await screen.findByRole("table", { name: "Preferred vendors" });
    expect(within(table).getByText("jo@acme.example")).toHaveAttribute("href", "mailto:jo@acme.example");
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));
    const dialog = await screen.findByRole("dialog", { name: "Add preferred vendor" });
    fireEvent.change(within(dialog).getByLabelText("Vendor name"), { target: { value: "Globex" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add vendor" }));
    expect(await screen.findByText("Saved Globex.")).toBeInTheDocument();
    expect(api.writes()[0]!.body).toMatchObject({ vendorName: "Globex", contactEmail: null });
    fireEvent.click(screen.getByRole("button", { name: "Edit Acme Staffing" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Acme Staffing" });
    fireEvent.change(within(edit).getByLabelText("Clients they work with (optional)"), { target: { value: "" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.headers["if-match"]).toBe('"3"');
    expect(api.writes()[1]!.body).toMatchObject({ clients: null });
  });

  it("hides Add and row actions from superiors who only read", async () => {
    api.routes["GET /api/v1/preferred-vendors"] = () => ({
      body: { items: [vendor({ owner: { id: "r1", name: "Ravi" }, actions: { edit: false, archive: false } })], total: 1, owners: [], actions: { create: false } },
    });
    wrap(<PreferredVendorsPage />);
    await screen.findByRole("table", { name: "Preferred vendors" });
    expect(screen.queryByRole("button", { name: "Add vendor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
  });
});
