import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Interview } from "../interviews/InterviewsPage";
import { SubmissionDrawer } from "./SubmissionsPage";
import { nextRoundName } from "./SubmissionRounds";
import { LOOKUPS, UUID, mockApi, sub, wrap } from "./testkit";

const S1 = sub("s1", { status: "interview_scheduled", actions: {
  transition: ["interview_completed", "rejected", "withdrawn"], createInterview: true, createPlacement: false, clearAndPlace: true, placeBlocked: null,
} });
const round = (id: string, name: string, extra: Partial<Interview> = {}): Interview => ({
  id, submissionId: "s1", candidate: { id: "c-s1", name: "Asha Iyer" }, recruiter: { id: "u-me", name: "Test User" },
  team: null, location: null, client: null, round: name, startsAt: "2026-10-30T15:00:00Z", endsAt: "2026-10-30T16:00:00Z",
  coach: null, inviteReceived: true, callStatus: "completed", cleared: false, consentCaptured: false,
  otterUrl: null, recordingUrl: null, systemName: null, editableFields: ["callStatus", "result", "round"], feedbackKinds: [],
  result: "pending", resultAt: null, submissionStatus: "interview_scheduled", placement: null, ...extra,
});

let api: ReturnType<typeof mockApi>;
let rounds: Interview[];
beforeEach(() => {
  rounds = [round("i1", "Initial", { result: "cleared" }), round("i2", "L1", { result: "cleared" }), round("i3", "Manager", { rowVersion: 7 })];
  api = mockApi({
    "GET /api/v1/submissions/s1": () => ({ body: S1 }),
    "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
    "GET /api/v1/interviews": () => ({ body: { items: rounds, nextCursor: null } }),
  });
});
afterEach(() => vi.restoreAllMocks());

const open = async () => {
  wrap(<SubmissionDrawer id="s1" initial={null} onClose={() => undefined} onNotice={() => undefined} />);
  const drawer = await screen.findByRole("dialog", { name: /^Asha Iyer/ });
  await within(drawer).findByText("Round 3 · Manager");
  return drawer;
};
const resultGroup = (drawer: HTMLElement, name: string) => within(drawer).getByRole("group", { name: `Result of ${name}` });

describe("Submission drawer: interview rounds", () => {
  it("lists every round in order and offers a placement from any held round", async () => {
    const drawer = await open();
    expect(api.gets("/api/v1/interviews")[0]!.url.searchParams.get("submissionId")).toBe("s1");
    expect(within(drawer).getAllByText(/^Round \d · /).map((e) => e.textContent)).toEqual(["Round 1 · Initial", "Round 2 · L1", "Round 3 · Manager"]);
    expect(within(resultGroup(drawer, "Initial")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reset to pending", "Create placement"]);
    expect(within(resultGroup(drawer, "Manager")).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Mark cleared", "Mark rejected…", "Clear and place"]);
    expect(within(drawer).getByRole("button", { name: "Schedule next round" })).toBeInTheDocument();
  });

  it("marks a round cleared", async () => {
    api.routes["PATCH /api/v1/interviews/i3"] = (_u, b) => ({ body: { ...rounds[2], ...(b as object) } });
    const drawer = await open();
    fireEvent.click(within(resultGroup(drawer, "Manager")).getByRole("button", { name: "Mark cleared" }));
    await waitFor(() => expect(api.writes()).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/v1/interviews/i3", body: { result: "cleared" }, headers: expect.objectContaining({ "if-match": "\"7\"" }) })]));
  });

  it("Clear and place: clears the round and selects the submission, then creates the placement", async () => {
    api.routes["POST /api/v1/interviews/i3/clear-and-select"] = () => ({ status: 201, body: { interviewId: "i3", result: "cleared", submissionId: "s1", submissionStatus: "selected" } });
    api.routes["POST /api/v1/placements"] = () => ({ status: 201, body: { id: "p1", isFirstPlacement: true } });
    const drawer = await open();
    fireEvent.click(within(resultGroup(drawer, "Manager")).getByRole("button", { name: "Clear and place" }));
    const dlg = screen.getByRole("dialog", { name: "Clear Manager and create placement · Asha Iyer" });
    fireEvent.change(within(dlg).getByLabelText("Placement type"), { target: { value: "c2c" } });
    fireEvent.change(within(dlg).getByLabelText("Work mode"), { target: { value: "hybrid" } });
    fireEvent.change(within(dlg).getByLabelText("Tentative start date"), { target: { value: "2026-11-17" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Clear and create placement" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /create placement/ })).not.toBeInTheDocument());
    expect(api.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["POST /api/v1/interviews/i3/clear-and-select", "POST /api/v1/placements"]);
    expect(api.writes()[1]!.headers["Idempotency-Key"]).toMatch(UUID);
    expect(within(drawer).getByRole("status")).toHaveTextContent("Placement created for Asha Iyer. This is their first placement.");
  });

  it("can only clear the round and mark Selected, leaving the placement for later", async () => {
    api.routes["POST /api/v1/interviews/i3/clear-and-select"] = () => ({ status: 201, body: {} });
    const drawer = await open();
    fireEvent.click(within(resultGroup(drawer, "Manager")).getByRole("button", { name: "Clear and place" }));
    fireEvent.click(screen.getByRole("button", { name: "Only clear the round and mark Selected" }));
    await waitFor(() => expect(within(drawer).getByRole("status")).toHaveTextContent("Round cleared and submission moved to Selected."));
    expect(api.writes().map((w) => w.path)).toEqual(["/api/v1/interviews/i3/clear-and-select"]);
    expect(api.writes()[0]!.headers["if-match"]).toBe("\"7\"");
  });

  it("rejecting a round can also reject the submission, with a reason", async () => {
    api.routes["PATCH /api/v1/interviews/i3"] = () => ({ body: { ...rounds[2], result: "rejected" } });
    api.routes["PATCH /api/v1/submissions/s1/status"] = () => ({ body: { id: "s1", status: "rejected" } });
    const drawer = await open();
    fireEvent.click(within(resultGroup(drawer, "Manager")).getByRole("button", { name: "Mark rejected…" }));
    const dlg = screen.getByRole("dialog", { name: "Mark Manager rejected?" });
    expect(within(dlg).getByRole("checkbox", { name: /Also reject the submission/ })).toBeChecked();
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject round and submission" }));
    expect(within(dlg).getByLabelText("Rejection reason")).toHaveAccessibleDescription("Give a rejection reason for the submission.");
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText("Rejection reason"), { target: { value: "Client hired internally" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject round and submission" }));
    await waitFor(() => expect(api.writes().map((w) => [w.path, w.body])).toEqual([
      ["/api/v1/interviews/i3", { result: "rejected" }],
      ["/api/v1/submissions/s1/status", { to: "rejected", rejectionReason: "Client hired internally" }],
    ]));
  });

  it("no Clear and place after a rejected round, nor without the hint", async () => {
    rounds[1] = round("i2", "L1", { result: "rejected" });
    const drawer = await open();
    expect(within(resultGroup(drawer, "Manager")).queryByRole("button", { name: "Clear and place" })).not.toBeInTheDocument();
  });

  it("explains why there's no placement action while the candidate is in another placement", async () => {
    api.routes["GET /api/v1/submissions/s1"] = () => ({ body: { ...S1, actions: { ...S1.actions!, clearAndPlace: false, placeBlocked: "confirmation" } } });
    const drawer = await open();
    expect(within(drawer).queryByRole("button", { name: /Clear and place|Create placement/ })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/can't be placed from this submission while their status is Confirmation \(another placement is in progress\)/)).toBeInTheDocument();
  });

  it("suggests the next round name", () => {
    expect(nextRoundName("L1")).toBe("L2");
    expect(nextRoundName("Technical 9")).toBe("Technical 10");
    expect(nextRoundName("initial round")).toBe("");
    expect(nextRoundName(undefined)).toBe("");
  });
});
