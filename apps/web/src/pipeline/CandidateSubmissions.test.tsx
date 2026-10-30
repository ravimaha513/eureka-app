import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateSubmissions } from "./CandidateSubmissions";
import { LOOKUPS, mockApi, sub, wrap } from "./testkit";

const CAND = "c1";
const iv = (stage: string, round: string, result: string, startsAt: string, callStatus = "completed") => ({ stage, round, result, callStatus, startsAt });
const S1 = sub("s1", {
  jobTitle: "Java Developer", client: "Meta", status: "selected", interviewCount: 2, lastInterviewAt: "2026-10-20T15:00:00Z",
  interviews: [iv("screening", "Initial Screening", "cleared", "2026-10-10T15:00:00Z"), iv("l1", "Technical Round 1", "cleared", "2026-10-20T15:00:00Z")] as never,
  placementStatus: "confirmed",
});
const S2 = sub("s2", {
  jobTitle: "Data Engineer", client: "Intuit", status: "rejected", interviewCount: 0, lastInterviewAt: null,
  interviews: [iv("l1", "L1", "rejected", "2026-10-11T15:00:00Z")] as never, placementStatus: null,
});
const zero = { held: 0, cleared: 0 };
const SUMMARY = {
  total: 1000, interviewed: 5,
  byStatus: { submitted: 990, under_review: 0, interview_requested: 0, interview_scheduled: 0, interview_completed: 0, selected: 1, rejected: 9, withdrawn: 0 },
  funnel: {
    submitted: 1000, interviewed: 5, selected: 1, placed: 1,
    stages: { screening: { held: 3, cleared: 2 }, l1: { held: 2, cleared: 1 }, l2: zero, l3: zero, final: zero, other: { held: 1, cleared: 0 } },
  },
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/submissions": (u) => ({ body: { items: u.searchParams.get("stage") === "placed" ? [S1] : [S1, S2], nextCursor: null } }),
    "GET /api/v1/submissions/summary": () => ({ body: SUMMARY }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
  });
});
afterEach(() => vi.restoreAllMocks());

const lastList = () => api.gets("/api/v1/submissions").at(-1)!.url.searchParams;

describe("Candidate submissions tab", () => {
  it("shows the funnel, status counts and each submission's interview trail", async () => {
    wrap(<CandidateSubmissions candidateId={CAND} />);
    const row = (await screen.findByText("Java Developer", { selector: "b" })).closest("tr")!;
    const trail = within(row).getByRole("list", { name: "Interview rounds" });
    expect(within(trail).getAllByRole("listitem").map((li) => li.textContent!.replace(/ \(.*\)$/, ""))).toEqual(["Screening ✓", "L1 ✓", "Placed · Confirmed"]);
    expect(lastList().get("candidateId")).toBe(CAND);
    expect(api.gets("/api/v1/submissions/summary").at(-1)!.url.searchParams.get("candidateId")).toBe(CAND);

    const funnel = await screen.findByRole("region", { name: "Submission funnel" });
    expect(within(funnel).getByRole("button", { name: /^1000\s*Submitted/ })).toBeInTheDocument();
    expect(within(funnel).getByRole("button", { name: /^5\s*Got an interview\s*0\.5% of Submitted/ })).toBeInTheDocument();
    expect(within(funnel).getByRole("button", { name: /^2\s*L1\s*67% of Screening\s*1 cleared/ })).toBeInTheDocument();
    expect(within(funnel).getByText(/1 submission with other rounds/)).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: /Rejected\s*9/ })).toBeInTheDocument();
  });

  it("funnel steps and the Interview select filter by stage; search and clear", async () => {
    wrap(<CandidateSubmissions candidateId={CAND} />);
    await screen.findByText("Data Engineer", { selector: "b" });
    const funnel = await screen.findByRole("region", { name: "Submission funnel" });
    fireEvent.click(within(funnel).getByRole("button", { name: /Placed/ }));
    await waitFor(() => expect(lastList().get("stage")).toBe("placed"));
    await waitFor(() => expect(screen.queryByText("Data Engineer", { selector: "b" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Interview")).toHaveValue("stage:placed");

    fireEvent.change(screen.getByLabelText("Interview"), { target: { value: "true" } });
    await waitFor(() => expect(lastList().get("interviewed")).toBe("true"));
    expect(lastList().get("stage")).toBeNull();

    fireEvent.change(screen.getByLabelText("Job or client"), { target: { value: "meta" } });
    await waitFor(() => expect(lastList().get("search")).toBe("meta"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(lastList().get("interviewed")).toBeNull();
      expect(lastList().get("search")).toBeNull(); // after the search debounce
    });
  });
});
