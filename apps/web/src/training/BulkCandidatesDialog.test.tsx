import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, wrap } from "../pipeline/testkit";
import { BulkCandidatesDialog } from "./BulkCandidatesDialog";

const sheets = vi.hoisted(() => ({ data: [] as { sheet: string; data: unknown[][] }[] }));
vi.mock("read-excel-file/browser", () => ({ default: async () => sheets.data }));

const HEAD = ["First Name", "Last Name", "Phone", "Personal Email"];
const ASHA = { firstName: "Asha", lastName: "Iyer", phone: "+14695550001", email: "asha@example.com" };
const BULK = "POST /api/v1/batches/b1/candidates/bulk";
const report = (extra: object, rows = [{ ...ASHA, row: 1, status: "ok" }]) => ({
  dryRun: true, committed: false, created: 0, failed: 0, rows, ...extra,
});
const TEAMS = { items: [{ id: "t1", name: "Team Rohit", lead: "Rohit" }], defaultTeamId: "t1" };

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "GET /api/v1/candidate-create-teams": () => ({ body: TEAMS }),
    [BULK]: (_u, body) => ({ body: (body as { dryRun: boolean }).dryRun ? report({}) : report({ dryRun: false, committed: true, created: 1 }) }),
  });
});
const open = (onDone = vi.fn()) => {
  wrap(<BulkCandidatesDialog batch={{ id: "b1", name: "Java November" }} onClose={vi.fn()} onDone={onDone} />);
  return screen.getByRole("dialog", { name: "Add candidates to Java November" });
};
const choose = async (dlg: HTMLElement) => {
  const input = within(dlg).getByLabelText("Excel file");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { files: [new File(["x"], "c.xlsx")] } });
};

describe("BulkCandidatesDialog", () => {
  it("previews the file with no team by default, then creates with the same rows", async () => {
    sheets.data = [{ sheet: "Instructions", data: [["help"]] }, { sheet: "Candidates", data: [HEAD, ["Asha", "Iyer", "+14695550001", "asha@example.com"], [null, null, null, null]] }];
    const onDone = vi.fn();
    const dlg = open(onDone);
    const create = within(dlg).getByRole("button", { name: "Create candidates" });
    expect(create).toBeDisabled();
    await choose(dlg);
    expect(await within(dlg).findByText("All 1 rows are valid and ready to add.")).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({ dryRun: true, teamId: null, rows: [ASHA] });
    expect(within(dlg).getByRole("row", { name: /Asha/ })).toHaveTextContent("OK");
    fireEvent.click(within(dlg).getByRole("button", { name: "Create 1 candidate" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(1));
    expect(api.writes()[1]!.body).toEqual({ dryRun: false, teamId: null, rows: [ASHA] });
  });

  it("shows why rows fail and keeps Create disabled", async () => {
    sheets.data = [{ sheet: "Candidates", data: [HEAD, ["Asha", "Iyer", "+14695550001", "asha@example.com"]] }];
    api = mockApi({
      "GET /api/v1/candidate-create-teams": () => ({ body: TEAMS }),
      [BULK]: () => ({ body: report({ failed: 1 }, [{ ...ASHA, row: 1, status: "error", error: "duplicate_email" } as never]) }),
    });
    const dlg = open();
    await choose(dlg);
    expect(await within(dlg).findByText("Another candidate already has this email.")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Create candidates" })).toBeDisabled();
  });

  it("refuses a file without the template's columns, without calling the server", async () => {
    sheets.data = [{ sheet: "Candidates", data: [["Name", "Email"], ["Asha", "asha@example.com"]] }];
    const dlg = open();
    await choose(dlg);
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("First Name, Last Name, Phone and Personal Email");
    expect(api.writes()).toEqual([]);
  });

  it("offers No team yet first and re-checks the file when a team is picked", async () => {
    sheets.data = [{ sheet: "Candidates", data: [HEAD, ["Asha", "Iyer", "+14695550001", "asha@example.com"]] }];
    api = mockApi({
      "GET /api/v1/candidate-create-teams": () => ({ body: { items: [{ id: "t1", name: "A", lead: null }, { id: "t2", name: "B", lead: null }], defaultTeamId: "t1" } }),
      [BULK]: () => ({ body: report({}) }),
    });
    const dlg = open();
    const team = await within(dlg).findByRole("combobox", { name: "Team" });
    expect(team).toHaveValue("none");
    expect(within(team).getAllByRole("option").map((o) => o.textContent)).toEqual(["No team yet", "A", "B"]);
    await choose(dlg);
    await within(dlg).findByText("All 1 rows are valid and ready to add.");
    fireEvent.change(team, { target: { value: "t2" } });
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toEqual({ dryRun: true, teamId: "t2", rows: [ASHA] });
  });
});
