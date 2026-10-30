import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateSubmissions } from "./CandidateSubmissions";
import { LOOKUPS, mockApi, sub, wrap } from "./testkit";

const CAND = "c1";
const S1 = sub("s1", { jobTitle: "Java Developer", client: "Meta", status: "interview_scheduled", interviewCount: 2, lastInterviewAt: "2026-10-20T15:00:00Z" });
const S2 = sub("s2", { jobTitle: "Data Engineer", client: "Intuit", status: "rejected", interviewCount: 0, lastInterviewAt: null });
const SUMMARY = {
  total: 2, interviewed: 1,
  byStatus: { submitted: 0, under_review: 0, interview_requested: 0, interview_scheduled: 1, interview_completed: 0, selected: 0, rejected: 1, withdrawn: 0 },
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/submissions": (u) => ({ body: { items: u.searchParams.get("interviewed") === "true" ? [S1] : [S1, S2], nextCursor: null } }),
    "GET /api/v1/submissions/summary": () => ({ body: SUMMARY }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
  });
});
afterEach(() => vi.restoreAllMocks());

const lastList = () => api.gets("/api/v1/submissions").at(-1)!.url.searchParams;

describe("Candidate submissions tab", () => {
  it("scopes to the candidate, shows totals, counts per status and interviews per row", async () => {
    wrap(<CandidateSubmissions candidateId={CAND} />);
    const row = (await screen.findByText("Java Developer", { selector: "b" })).closest("tr")!;
    expect(within(row).getByText("2 interviews")).toBeInTheDocument();
    expect(lastList().get("candidateId")).toBe(CAND);
    expect(api.gets("/api/v1/submissions/summary").at(-1)!.url.searchParams.get("candidateId")).toBe(CAND);

    const totals = await screen.findByRole("group", { name: "Submission totals" });
    expect(within(totals).getByRole("button", { name: /1\s*Got an interview/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: /Rejected\s*1/ })).toBeInTheDocument();
  });

  it("filters to submissions that got an interview and searches job or client", async () => {
    wrap(<CandidateSubmissions candidateId={CAND} />);
    await screen.findByText("Data Engineer", { selector: "b" });
    fireEvent.click(within(await screen.findByRole("group", { name: "Submission totals" })).getByRole("button", { name: /Got an interview/ }));
    await waitFor(() => expect(lastList().get("interviewed")).toBe("true"));
    await waitFor(() => expect(screen.queryByText("Data Engineer", { selector: "b" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Interview")).toHaveValue("true");

    fireEvent.change(screen.getByLabelText("Job or client"), { target: { value: "meta" } });
    await waitFor(() => expect(lastList().get("search")).toBe("meta"));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(lastList().get("interviewed")).toBeNull();
      expect(lastList().get("search")).toBeNull(); // after the search debounce
    });
  });
});
