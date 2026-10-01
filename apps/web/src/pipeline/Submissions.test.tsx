import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmissionsPage } from "./SubmissionsPage";
import { dayBoundary } from "./pipelineApi";
import { COACH, LOOKUPS, UUID, meFor, mockApi, problem, sub, wrap, type Handler } from "./testkit";

const RECRUITER = meFor("recruiter");
const S1 = sub("s1");
const S2 = sub("s2", {
  candidateName: "Divya Menon", jobTitle: "Data Engineer", status: "selected",
  actions: { transition: [], createInterview: false, createPlacement: true },
});

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/submissions": (u) => ({ body: { items: u.searchParams.get("cursor") ? [S2] : [S1, S2], nextCursor: u.searchParams.get("cursor") ? null : "123.abc" } }),
  "GET /api/v1/submissions/s1": () => ({ body: S1 }),
  "GET /api/v1/submissions/s2": () => ({ body: S2 }),
  "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
});
beforeEach(() => { api = mockApi(base()); });
afterEach(() => vi.restoreAllMocks());

const lastList = () => api.gets("/api/v1/submissions").at(-1)!.url.searchParams;
const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;
const openDrawer = async (name: string) => {
  fireEvent.click(within(await rowOf(name)).getByRole("button", { name: /^Open submission of / }));
  return screen.findByRole("dialog", { name: new RegExp(`^${name}`) });
};

describe("Submissions list", () => {
  it("lists submissions with status chips and no rate column when rates are withheld", async () => {
    wrap(<SubmissionsPage me={RECRUITER} />);
    const row = await rowOf("Asha Iyer");
    expect(within(row).getByText("Submitted")).toHaveClass("badge");
    expect(within(await rowOf("Divya Menon")).getByText("Selected")).toHaveClass("badge", "st-selected");
    expect(screen.queryByRole("columnheader", { name: "Rate" })).not.toBeInTheDocument();
    expect(screen.getByText("2 submissions on page 1, more on the next page.")).toBeInTheDocument();
  });

  it("shows the rate column only when the API returns rates", async () => {
    api.routes["GET /api/v1/submissions"] = () => ({ body: { items: [{ ...S1, rate: 65 }, S2], nextCursor: null } });
    wrap(<SubmissionsPage me={RECRUITER} />);
    expect(await screen.findByRole("columnheader", { name: "Rate" })).toBeInTheDocument();
    expect(within(await rowOf("Asha Iyer")).getByText("$65.00/hr")).toBeInTheDocument();
  });

  it("filters by status chip and date range, resetting to page 1", async () => {
    wrap(<SubmissionsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastList().get("cursor")).toBe("123.abc"));

    const chips = screen.getByRole("group", { name: "Status" });
    fireEvent.click(within(chips).getByRole("button", { name: "Interview scheduled" }));
    expect(within(chips).getByRole("button", { name: "Interview scheduled" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(lastList().get("status")).toBe("interview_scheduled"));
    expect(lastList().get("cursor")).toBeNull();

    fireEvent.change(screen.getByLabelText("Submitted from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Submitted through"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect(lastList().get("to")).toBe(dayBoundary("2026-09-30", true)));
    expect(lastList().get("from")).toBe(dayBoundary("2026-09-01"));

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect([...lastList().keys()]).toEqual(["limit"]));
  });

  it("refuses an inverted date range without querying", async () => {
    wrap(<SubmissionsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    const before = api.gets("/api/v1/submissions").length;
    fireEvent.change(screen.getByLabelText("Submitted from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("Submitted through"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("must be on or after");
    expect(screen.getByLabelText("Submitted through")).toHaveAttribute("aria-invalid", "true");
    expect(api.gets("/api/v1/submissions").slice(before).some((c) => c.url.searchParams.get("from") === dayBoundary("2026-09-10") && c.url.searchParams.has("to"))).toBe(false);
  });

  it("searches candidates by name and filters submissions by the one picked", async () => {
    api.routes["GET /api/v1/candidates"] = () => ({ body: { items: [{ id: "cand-9", name: "Asha Iyer", team: { id: "t1", name: "Team Rohit" } }], nextCursor: null } });
    wrap(<SubmissionsPage me={RECRUITER} />);
    await rowOf("Asha Iyer");
    fireEvent.change(screen.getByLabelText("Candidate search"), { target: { value: "asha" } });
    const option = await screen.findByRole("option", { name: "Asha Iyer · Team Rohit" });
    expect(api.gets("/api/v1/candidates").at(-1)!.url.searchParams.get("search")).toBe("asha");
    fireEvent.change(screen.getByLabelText("Candidate"), { target: { value: (option as HTMLOptionElement).value } });
    await waitFor(() => expect(lastList().get("candidateId")).toBe("cand-9"));
  });

  it("hides candidate search without candidate:read", async () => {
    wrap(<SubmissionsPage me={{ capabilities: ["submission:read"] }} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByLabelText("Candidate search")).not.toBeInTheDocument();
  });
});

describe("Submission detail", () => {
  it("offers exactly the transitions in actions and moves the submission forward", async () => {
    let status = "submitted";
    api.routes["GET /api/v1/submissions/s1"] = () => ({ body: { ...S1, status } });
    api.routes["PATCH /api/v1/submissions/s1/status"] = (_u, b) => { status = (b as { to: string }).to; return { body: { id: "s1", status } }; };
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    const group = within(drawer).getByRole("group", { name: "Change status" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Move to Under review", "Reject…", "Withdraw…"]);
    expect(within(drawer).getByRole("button", { name: "Schedule interview" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Create placement" })).not.toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: "Move to Under review" }));
    await waitFor(() => expect(within(drawer).getByRole("status")).toHaveTextContent("Status changed to Under review."));
    expect(api.writes()[0]).toMatchObject({ method: "PATCH", path: "/api/v1/submissions/s1/status", body: { to: "under_review" } });
    expect(api.writes()[0]!.headers["x-csrf-token"]).toBe("tok");
    await waitFor(() => expect(within(drawer).getAllByText("Under review").length).toBeGreaterThan(0));
  });

  it("hides every action when the API sends no actions", async () => {
    const { actions: _drop, ...bare } = S1;
    api.routes["GET /api/v1/submissions"] = () => ({ body: { items: [bare], nextCursor: null } });
    api.routes["GET /api/v1/submissions/s1"] = () => ({ body: bare });
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    expect(within(drawer).getByText("Senior Java Developer")).toBeInTheDocument();
    expect(within(drawer).queryByRole("heading", { name: "Next steps" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /Move to|Reject|Withdraw|Schedule|Create placement/ })).not.toBeInTheDocument();
  });

  it("maps an invalid_transition refusal to plain language", async () => {
    api.routes["PATCH /api/v1/submissions/s1/status"] = () => problem(422, { detail: "invalid_transition" });
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Move to Under review" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("That status change isn't allowed from the current status.");
  });

  it("asks for a rejection reason; Escape closes only the prompt", async () => {
    api.routes["PATCH /api/v1/submissions/s1/status"] = (_u, b) => ({ body: { id: "s1", status: (b as { to: string }).to } });
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    const reject = within(drawer).getByRole("button", { name: "Reject…" });
    reject.focus();
    fireEvent.click(reject);
    let dlg = screen.getByRole("dialog", { name: "Reject this submission?" });
    expect(within(dlg).getByLabelText("Rejection reason")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Reject this submission?" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /^Asha Iyer/ })).toBeInTheDocument();
    expect(reject).toHaveFocus();

    fireEvent.click(reject);
    dlg = screen.getByRole("dialog", { name: "Reject this submission?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject submission" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Rejection reason")).toHaveAccessibleDescription(expect.stringContaining("Give a rejection reason."));
    fireEvent.change(within(dlg).getByLabelText("Rejection reason"), { target: { value: "  Client chose an internal candidate " } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject submission" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reject this submission?" })).not.toBeInTheDocument());
    expect(api.writes()[0]!.body).toEqual({ to: "rejected", rejectionReason: "Client chose an internal candidate" });
    expect(within(screen.getByRole("dialog", { name: /^Asha Iyer/ })).getByRole("status")).toHaveTextContent("Submission rejected.");
  });

  it("confirms before withdrawing", async () => {
    api.routes["PATCH /api/v1/submissions/s1/status"] = () => ({ body: { id: "s1", status: "withdrawn" } });
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Withdraw…" }));
    const dlg = screen.getByRole("dialog", { name: "Withdraw this submission?" });
    expect(api.writes()).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(api.writes()[0]!.body).toEqual({ to: "withdrawn" }));
  });

  it("schedules an interview with a coach from the lookups and maps a conflict", async () => {
    let n = 0;
    api.routes["POST /api/v1/interviews"] = () => (++n === 1 ? problem(409, { detail: "interview_conflict" }) : { status: 201, body: { id: "i1" } });
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Asha Iyer");
    fireEvent.click(within(drawer).getByRole("button", { name: "Schedule interview" }));
    const dlg = screen.getByRole("dialog", { name: "Schedule interview · Asha Iyer" });
    await within(dlg).findByRole("option", { name: "Coach One" });
    fireEvent.change(within(dlg).getByLabelText("Round"), { target: { value: "Technical 1" } });
    fireEvent.change(within(dlg).getByLabelText("Start"), { target: { value: "2026-10-01T11:00" } });
    fireEvent.change(within(dlg).getByLabelText("End"), { target: { value: "2026-10-01T10:00" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
    expect(within(dlg).getByLabelText("End")).toHaveAccessibleDescription("End must be after start.");
    expect(api.writes()).toHaveLength(0);

    fireEvent.change(within(dlg).getByLabelText("End"), { target: { value: "2026-10-01T12:00" } });
    fireEvent.change(within(dlg).getByLabelText("Coach (optional)"), { target: { value: COACH } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("overlaps another interview");
    expect(api.writes()[0]!.body).toEqual({
      submissionId: "s1", round: "Technical 1", startsAt: new Date("2026-10-01T11:00").toISOString(),
      endsAt: new Date("2026-10-01T12:00").toISOString(), coachId: COACH, inviteReceived: false,
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Schedule interview/ })).not.toBeInTheDocument());
    expect(within(drawer).getByRole("status")).toHaveTextContent("Interview scheduled.");
  });
});

describe("Create placement", () => {
  const openCreate = async () => {
    wrap(<SubmissionsPage me={RECRUITER} />);
    const drawer = await openDrawer("Divya Menon");
    expect(within(drawer).queryByRole("group", { name: "Change status" })).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Create placement" }));
    return { drawer, dlg: screen.getByRole("dialog", { name: "Create placement · Divya Menon" }) };
  };
  const fillRequired = (dlg: HTMLElement) => {
    fireEvent.change(within(dlg).getByLabelText("Placement type"), { target: { value: "w2" } });
    fireEvent.change(within(dlg).getByLabelText("Work mode"), { target: { value: "remote" } });
    fireEvent.change(within(dlg).getByLabelText("Tentative start date"), { target: { value: "2026-10-20" } });
  };

  it("validates, edits contacts, sends an Idempotency-Key and reports a first placement", async () => {
    api.routes["POST /api/v1/placements"] = () => ({ status: 201, body: { id: "p9", isFirstPlacement: true } });
    const { drawer, dlg } = await openCreate();
    expect(within(dlg).getByLabelText("Placement type")).toHaveFocus();
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(dlg).getByLabelText("Placement type")).toHaveAccessibleDescription("Choose the placement type.");
    expect(within(dlg).getByLabelText("Tentative start date")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(within(dlg).getByLabelText("Placement type")).toHaveFocus());

    fillRequired(dlg);
    fireEvent.change(within(dlg).getByLabelText("Project city (optional)"), { target: { value: " Austin " } });
    fireEvent.change(within(dlg).getByLabelText("Rate per hour (optional)"), { target: { value: "72.5" } });

    fireEvent.click(within(dlg).getByRole("button", { name: "Add contact" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Add contact" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Add contact" }));
    const c1 = within(dlg).getByRole("group", { name: "Contact 1" });
    const c2 = within(dlg).getByRole("group", { name: "Contact 2" });
    fireEvent.change(within(c1).getByLabelText("Kind"), { target: { value: "invoicing_poc" } });
    fireEvent.change(within(c1).getByLabelText("Name"), { target: { value: "Pat Lee" } });
    fireEvent.change(within(c1).getByLabelText("Email (optional)"), { target: { value: "not-an-email" } });
    fireEvent.change(within(c2).getByLabelText("Name"), { target: { value: "Sam Roy" } });
    fireEvent.change(within(c2).getByLabelText("Phone (optional)"), { target: { value: "+1 469 555 0100" } });
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Contact 3" })).getByRole("button", { name: "Remove contact 3" }));
    expect(within(dlg).queryByRole("group", { name: "Contact 3" })).not.toBeInTheDocument();

    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    expect(api.writes()).toHaveLength(0);
    expect(within(c1).getByLabelText("Email (optional)")).toHaveAccessibleDescription("Enter a valid email or leave it empty.");
    await waitFor(() => expect(within(c1).getByLabelText("Email (optional)")).toHaveFocus());
    fireEvent.change(within(c1).getByLabelText("Email (optional)"), { target: { value: "pat@vendor.example" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Create placement/ })).not.toBeInTheDocument());
    const w = api.writes()[0]!;
    expect(w.path).toBe("/api/v1/placements");
    expect(w.headers["Idempotency-Key"]).toMatch(UUID);
    expect(w.body).toEqual({
      submissionId: "s2", placementType: "w2", workMode: "remote", tentativeStart: "2026-10-20", rate: 72.5, projectCity: "Austin",
      contacts: [
        { kind: "invoicing_poc", name: "Pat Lee", email: "pat@vendor.example" },
        { kind: "vendor_poc", name: "Sam Roy", phone: "+1 469 555 0100" },
      ],
    });
    expect(within(drawer).getByRole("status")).toHaveTextContent("Placement created for Divya Menon. This is their first placement.");
  });

  it("omits the rate when left empty", async () => {
    api.routes["POST /api/v1/placements"] = () => ({ status: 201, body: { id: "p9", isFirstPlacement: false } });
    const { dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ submissionId: "s2", placementType: "w2", workMode: "remote", tentativeStart: "2026-10-20" });
  });

  it("keeps the key across a network retry and mints a new one after a 4xx answer", async () => {
    let n = 0;
    api.routes["POST /api/v1/placements"] = () => {
      n += 1;
      if (n === 1) return "network";
      if (n === 2) return problem(422, { detail: "idempotency_key_reused" });
      return { status: 201, body: { id: "p9", isFirstPlacement: false } };
    };
    const { dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Failed to fetch");
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    await waitFor(() => expect(within(dlg).getByRole("alert")).toHaveTextContent("This form changed after an earlier attempt"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    await waitFor(() => expect(api.writes()).toHaveLength(3));
    const [k1, k2, k3] = api.writes().map((w) => w.headers["Idempotency-Key"]);
    expect(k1).toMatch(UUID);
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k1);
  });

  it("uses a different key each time the dialog opens", async () => {
    api.routes["POST /api/v1/placements"] = () => problem(500, { detail: "boom" });
    const { drawer, dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    await within(dlg).findByRole("alert");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Create placement" }));
    const again = screen.getByRole("dialog", { name: "Create placement · Divya Menon" });
    fillRequired(again);
    fireEvent.click(within(again).getByRole("button", { name: "Create placement" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[0]!.headers["Idempotency-Key"]).not.toBe(api.writes()[1]!.headers["Idempotency-Key"]);
  });

  it("explains placement_exists and stops further attempts", async () => {
    api.routes["POST /api/v1/placements"] = () => problem(409, { detail: "placement_exists" });
    const { dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("already has an active placement");
    expect(within(dlg).getByRole("button", { name: "Create placement" })).toBeDisabled();
  });

  it("explains submission_not_selected", async () => {
    api.routes["POST /api/v1/placements"] = () => problem(422, { detail: "submission_not_selected" });
    const { dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("only be created from a submission marked Selected");
  });

  it("maps 422 field errors from the server", async () => {
    api.routes["POST /api/v1/placements"] = () => problem(422, { errors: [{ path: "tentativeStart", message: "Invalid date" }] });
    const { dlg } = await openCreate();
    fillRequired(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Create placement" }));
    await waitFor(() => expect(within(dlg).getByLabelText("Tentative start date")).toHaveAttribute("aria-invalid", "true"));
    expect(within(dlg).getByLabelText("Tentative start date")).toHaveAccessibleDescription("Invalid date");
  });
});
