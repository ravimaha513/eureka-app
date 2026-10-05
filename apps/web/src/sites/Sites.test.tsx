import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { browser } from "../sales/resumesApi";
import { visibleNav } from "../nav";
import { CompaniesPage, FacilitiesPage } from "./SitesPage";
import { PASSWORD_VISIBLE_MS, clipboard } from "./UtilitiesTab";
import type { Bill, BillsSummary, Company, Facility, Utility } from "./sitesApi";

// Companies and facilities (Phase 3b contract): list, KPIs, charts, details drawer, utilities and bills.

const LOC = { id: "loc", name: "Dallas" };
const C1 = "c0000000-0000-4000-8000-000000000001";
const F1 = "f0000000-0000-4000-8000-000000000001";
const U1 = "u0000000-0000-4000-8000-000000000001";
const B1 = "b0000000-0000-4000-8000-000000000001";

const company = (extra: Partial<Company> = {}): Company => ({
  id: C1, name: "Eureka Info Tech", location: LOC, street: "100 Main St", city: "Irving", state: "TX", zip: "75038", country: "USA",
  status: "active", incharges: [{ id: "u-ops", name: "Lena Ops" }], employeeCount: 12, rowVersion: 3, ...extra,
});
const facility = (extra: Partial<Facility> = {}): Facility => ({
  id: F1, name: "Guest House 2013", location: LOC, street: "2013 Elm St", city: "Irving", state: "TX", zip: "75039", country: "USA",
  status: "active", incharges: [], rent: "2400.00", feeFrequency: "monthly", capacity: 6, beds: 4, baths: "2.5",
  startDate: "2026-01-01", endDate: "2026-12-31", rowVersion: 2, ...extra,
});
const utility = (extra: Partial<Utility> = {}): Utility => ({
  id: U1, utilityType: "electricity", serviceProvider: "TXU Energy", accountNumber: "ACC-1001", websiteUrl: "https://www.txu.com",
  username: "eureka-ops", hasPassword: true, status: "active", notes: null, rowVersion: 1, ...extra,
});
const bill = (extra: Partial<Bill> = {}): Bill => ({
  id: B1, utility: { id: U1, utilityType: "electricity", serviceProvider: "TXU Energy" }, paymentMethod: "autopay", amount: "182.40",
  billingStart: "2026-08-01", billingEnd: "2026-08-31", dueDate: "2026-09-20", paidOn: null, status: "overdue",
  invoice: { documentId: "d1", fileName: "txu-aug.pdf" }, rowVersion: 1, ...extra,
});
const SUMMARY: BillsSummary = {
  totalBills: 3, totalAmount: "512.40", averagePerMonth: "42.70",
  byMonth: [{ month: "2026-08", amount: "182.40", count: 1 }, { month: "2026-09", amount: "330.00", count: 2 }],
  byType: [{ utilityType: "electricity", amount: "412.40", count: 2 }, { utilityType: "water", amount: "100.00", count: 1 }],
  byOwner: [{ id: C1, name: "Eureka Info Tech", amount: "512.40", count: 3 }],
};
const LOOKUPS = { technologies: [], clients: [], vendors: [], implementationPartners: [], locations: [LOC], coaches: [] };

const opsAdmin = meFor("location_ops_admin");
/** Read-only: can see companies, facilities, utilities and bills, but manage nothing and reveal nothing. */
const reader: Me = { ...opsAdmin, capabilities: ["company:read", "facility:read", "utility:read", "bill:read"] };

let api: ReturnType<typeof mockApi>;
let utilities: Utility[];
let bills: Bill[];
const base = (): Record<string, Handler> => ({
  "GET /api/v1/lookups": () => ({ body: LOOKUPS }),
  "GET /api/v1/companies": () => ({ body: { items: [company(), company({ id: "c2", name: "Endeavour Technology", status: "inactive", incharges: [], employeeCount: 0, zip: null })], nextCursor: null } }),
  "GET /api/v1/companies/stats": () => ({ body: { total: 2, active: 1, employees: 12 } }),
  "GET /api/v1/companies/bills-summary": () => ({ body: SUMMARY }),
  [`GET /api/v1/companies/${C1}`]: () => ({ body: { ...company(), notes: "Head office", createdAt: "2026-09-01T10:00:00Z", actions: { manage: true } } }),
  [`GET /api/v1/companies/${C1}/utilities`]: () => ({ body: { items: utilities } }),
  [`GET /api/v1/companies/${C1}/bills`]: () => ({ body: { items: bills } }),
  [`GET /api/v1/companies/${C1}/incharges`]: () => ({ body: { items: [{ id: "u-ops", name: "Lena Ops" }] } }),
  [`GET /api/v1/companies/${C1}/employees`]: () => ({ body: { items: [{ employeeId: "e1", name: "Asha Iyer", startDate: "2026-06-01", endDate: null, status: "on_assignment" }] } }),
  "GET /api/v1/facilities": () => ({ body: { items: [facility()], nextCursor: null } }),
  "GET /api/v1/facilities/stats": () => ({ body: { total: 1, active: 1, capacity: 6, beds: 4, monthlyRent: "2400.00" } }),
  "GET /api/v1/facilities/bills-summary": () => ({ body: { ...SUMMARY, byOwner: [{ id: F1, name: "Guest House 2013", amount: "512.40", count: 3 }] } }),
});

beforeEach(() => {
  utilities = [utility()];
  bills = [bill()];
  api = mockApi(base());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const rowOf = async (name: string) => (await screen.findByRole("button", { name: new RegExp(`^Open (company|facility) ${name}$`) })).closest("tr")!;
const openCompany = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Open company Eureka Info Tech" }));
  return screen.findByRole("dialog", { name: "Company details" });
};
const openTab = async (drawer: HTMLElement, name: string) => {
  fireEvent.click(await within(drawer).findByRole("tab", { name }));
  return within(drawer).getByRole("tabpanel");
};

describe("navigation", () => {
  it("shows Companies and Facilities under Operations for the read permissions only", () => {
    const keys = visibleNav(opsAdmin.capabilities).filter((n) => n.section === "Operations").map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining(["companies", "facilities"]));
    expect(visibleNav(meFor("recruiter").capabilities).map((n) => n.key)).not.toContain("companies");
    expect(visibleNav(["facility:read"]).map((n) => n.key)).toEqual(["facilities"]);
  });
});

describe("Companies list", () => {
  it("renders KPI cards, the list with icon, state, zip, incharge, employees and status, and the export link", async () => {
    wrap(<CompaniesPage me={opsAdmin} />);
    const r1 = await rowOf("Eureka Info Tech");
    expect(within(r1).getByText("TX")).toBeInTheDocument();
    expect(within(r1).getByText("75038")).toBeInTheDocument();
    expect(within(r1).getByText("Lena Ops")).toBeInTheDocument();
    expect(within(r1).getByText("12")).toBeInTheDocument();
    expect(within(r1).getByText("Active")).toHaveClass("badge", "active");
    const r2 = await rowOf("Endeavour Technology");
    expect(within(r2).getByText("Inactive")).toHaveClass("badge", "inactive");

    const kpis = screen.getByRole("region", { name: "Companies at a glance" });
    await waitFor(() => expect(within(kpis).getByText("Total companies").closest("li")).toHaveTextContent("2"));
    expect(within(kpis).getByText("Employees assigned").closest("li")).toHaveTextContent("12");
    await waitFor(() => expect(within(kpis).getByText("Bills, last 12 months").closest("li")).toHaveTextContent("$512.40"));

    const list = screen.getByRole("region", { name: "Companies List" });
    expect(within(list).getByRole("link", { name: "Export companies as CSV" })).toHaveAttribute("href", "/api/v1/companies/export.csv");
    expect(screen.getByRole("button", { name: "Add company" })).toBeInTheDocument();
    expect(within(r1).getByRole("button", { name: "Edit company Eureka Info Tech" })).toBeInTheDocument();
    expect(screen.getByText("2 companies on page 1.")).toBeInTheDocument();
  });

  it("searches by name after a pause and pages with the cursor", async () => {
    api.routes["GET /api/v1/companies"] = (url) => ({ body: { items: [company()], nextCursor: url.searchParams.get("cursor") ? null : "next1" } });
    wrap(<CompaniesPage me={opsAdmin} />);
    await rowOf("Eureka Info Tech");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search companies" }), { target: { value: "Eure" } });
    await waitFor(() => expect(api.gets("/api/v1/companies").at(-1)!.url.searchParams.get("q")).toBe("Eure"));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.gets("/api/v1/companies").at(-1)!.url.searchParams.get("cursor")).toBe("next1"));
    expect(await screen.findByText("Page 2")).toBeInTheDocument();
  });

  it("without manage permission there is no Add, no Edit and no add or reveal in the drawer", async () => {
    api.routes[`GET /api/v1/companies/${C1}`] = () => ({ body: { ...company(), notes: null, createdAt: "2026-09-01T10:00:00Z", actions: { manage: false } } });
    wrap(<CompaniesPage me={reader} />);
    const r1 = await rowOf("Eureka Info Tech");
    expect(screen.queryByRole("button", { name: "Add company" })).toBeNull();
    expect(within(r1).queryByRole("button", { name: /Edit/ })).toBeNull();
    const drawer = await openCompany();
    await within(drawer).findByText("Added"); // the full record has loaded
    expect(within(drawer).queryByRole("button", { name: /Edit company/ })).toBeNull();
    let panel = await openTab(drawer, "Incharges");
    await within(panel).findByText("Lena Ops");
    expect(within(panel).queryByRole("button", { name: "Add incharge" })).toBeNull();
    panel = await openTab(drawer, "Utilities");
    await within(panel).findByText("TXU Energy");
    expect(within(panel).queryByRole("button", { name: "Add utility" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Reveal password/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Edit utility/ })).toBeNull();
    panel = await openTab(drawer, "Bills");
    await within(panel).findByRole("table", { name: "Bills" });
    expect(within(panel).queryByRole("button", { name: "Add bill" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Void/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Upload invoice/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: /^Download invoice/ })).toBeInTheDocument();
  });

  it("renders the bill charts with text alternatives and the totals by company", async () => {
    wrap(<CompaniesPage me={opsAdmin} />);
    const trend = await screen.findByRole("img", { name: /^Bills by month: Amount \$512\.40 in total/ });
    expect(trend).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Utility bills by type: Electricity $412.40, Water $100.00" })).toBeInTheDocument();
    const totals = screen.getByRole("table", { name: "Bills total by company" });
    const row = within(totals).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Eureka Info Tech");
    expect(row).toHaveTextContent("$512.40");
    const q = api.gets("/api/v1/companies/bills-summary")[0]!.url.searchParams;
    expect(q.get("from")).toMatch(/^\d{4}-\d{2}-01$/);
    expect(q.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get("tz")).toBeTruthy();
  });

  it("opens the details drawer with header, address and pill tabs; employees are listed", async () => {
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    expect(within(drawer).getByText("Eureka Info Tech", { selector: "b" })).toBeInTheDocument();
    expect(within(drawer).getAllByText("100 Main St, Irving, TX 75038, USA")[0]!.closest(".addr")).toBeInTheDocument();
    expect(within(drawer).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Employees", "Incharges", "Utilities", "Bills"]);
    expect(await within(drawer).findByText("Head office")).toBeInTheDocument();
    const panel = await openTab(drawer, "Employees");
    expect(await within(panel).findByText("Asha Iyer")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove employee Asha Iyer" })).toBeInTheDocument();
  });

  it("edits a company with If-Match from the list", async () => {
    api.routes[`PATCH /api/v1/companies/${C1}`] = () => ({ body: company({ rowVersion: 4 }) });
    wrap(<CompaniesPage me={opsAdmin} />);
    fireEvent.click(within(await rowOf("Eureka Info Tech")).getByRole("button", { name: "Edit company Eureka Info Tech" }));
    // The form shows once the full record (notes, row version) has loaded.
    expect(await screen.findByLabelText("Company name")).toHaveValue("Eureka Info Tech");
    const dialog = screen.getByRole("dialog", { name: "Edit company" });
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "inactive" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Eureka Info Tech saved.")).toBeInTheDocument();
    const patch = api.writes().find((c) => c.method === "PATCH")!;
    expect(patch.headers["if-match"]).toBe('"3"');
    expect(patch.body).toMatchObject({ name: "Eureka Info Tech", status: "inactive", notes: "Head office", locationId: "loc" });
  });
});

describe("Facilities", () => {
  it("lists rent, capacity and lease, and the facility KPIs", async () => {
    wrap(<FacilitiesPage me={opsAdmin} />);
    const r = await rowOf("Guest House 2013");
    expect(r).toHaveTextContent("$2,400.00/mo");
    expect(r).toHaveTextContent("4 beds");
    const kpis = screen.getByRole("region", { name: "Facilities at a glance" });
    await waitFor(() => expect(within(kpis).getByText("Monthly rent").closest("li")).toHaveTextContent("$2,400.00"));
    expect(screen.getByRole("link", { name: "Export facilities as CSV" })).toHaveAttribute("href", "/api/v1/facilities/export.csv");
  });

  it("validates the Add facility form before sending, then sends a clean body", async () => {
    api.routes["POST /api/v1/facilities"] = () => ({ status: 201, body: facility({ id: "f-new", name: "Guest House 2020" }) });
    wrap(<FacilitiesPage me={opsAdmin} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add facility" }));
    const dialog = await screen.findByRole("dialog", { name: "Add facility" });
    await waitFor(() => expect(within(dialog).getByLabelText("Location")).toHaveValue("loc"));
    fireEvent.change(within(dialog).getByLabelText("Owner email"), { target: { value: "not-an-email" } });
    fireEvent.change(within(dialog).getByLabelText("Rent"), { target: { value: "12.345" } });
    fireEvent.change(within(dialog).getByLabelText("Capacity"), { target: { value: "-1" } });
    fireEvent.change(within(dialog).getByLabelText("Baths"), { target: { value: "two" } });
    fireEvent.change(within(dialog).getByLabelText("Lease start"), { target: { value: "2026-11-01" } });
    fireEvent.change(within(dialog).getByLabelText("Lease end"), { target: { value: "2026-10-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add facility" }));
    expect(await within(dialog).findByText("Enter the facility name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an email address like name@example.com.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an amount of 0 or more, with up to 2 decimals.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter a whole number of 0 or more.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter a number like 2 or 2.5.")).toBeInTheDocument();
    expect(within(dialog).getByText("The end date can't be before the start date.")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Facility name")).toHaveFocus());
    expect(api.writes()).toHaveLength(0);

    // Reset clears the form.
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(within(dialog).getByLabelText("Owner email")).toHaveValue("");
    expect(within(dialog).queryByText("Enter the facility name.")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Facility name"), { target: { value: " Guest House 2020 " } });
    fireEvent.change(within(dialog).getByLabelText("Zip code"), { target: { value: "75039" } });
    fireEvent.change(within(dialog).getByLabelText("Owner email"), { target: { value: "owner@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Rent"), { target: { value: "2400" } });
    fireEvent.change(within(dialog).getByLabelText("Fee frequency"), { target: { value: "weekly" } });
    fireEvent.change(within(dialog).getByLabelText("Capacity"), { target: { value: "8" } });
    fireEvent.change(within(dialog).getByLabelText("Baths"), { target: { value: "1.5" } });
    fireEvent.change(within(dialog).getByLabelText("Lease start"), { target: { value: "2026-10-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add facility" }));
    expect(await screen.findByText("Guest House 2020 added.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.writes()[0]!.body).toEqual({
      locationId: "loc", name: "Guest House 2020", zip: "75039", country: "USA", ownerEmail: "owner@example.com",
      rent: "2400.00", feeFrequency: "weekly", capacity: 8, baths: 1.5, startDate: "2026-10-01",
    });
  });

  it("shows a duplicate name from the server in the dialog", async () => {
    api.routes["POST /api/v1/facilities"] = () => problem(409, { detail: "name_taken" });
    wrap(<FacilitiesPage me={opsAdmin} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add facility" }));
    const dialog = await screen.findByRole("dialog", { name: "Add facility" });
    await waitFor(() => expect(within(dialog).getByLabelText("Location")).toHaveValue("loc"));
    fireEvent.change(within(dialog).getByLabelText("Facility name"), { target: { value: "Guest House 2013" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add facility" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists in this location");
  });

  it("hides Add facility and Edit without facility:manage", async () => {
    wrap(<FacilitiesPage me={reader} />);
    const r = await rowOf("Guest House 2013");
    expect(screen.queryByRole("button", { name: "Add facility" })).toBeNull();
    expect(within(r).queryByRole("button", { name: /Edit/ })).toBeNull();
  });
});

describe("Utilities", () => {
  it("adds a utility; the password goes to the server but is never shown in the list", async () => {
    api.routes[`POST /api/v1/companies/${C1}/utilities`] = (_u, body) => {
      utilities = [...utilities, utility({ id: "u2", utilityType: "water", serviceProvider: "City of Irving", hasPassword: true, accountNumber: null, username: null, websiteUrl: null })];
      return { status: 201, body: { ...(body as object), id: "u2" } };
    };
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Utilities");
    const table = await within(panel).findByRole("table", { name: "Utilities" });
    expect(within(table).getByLabelText("Password hidden")).toHaveTextContent("••••••••");

    fireEvent.click(within(panel).getByRole("button", { name: "Add utility" }));
    const dialog = await screen.findByRole("dialog", { name: "Add utility" });
    expect(within(dialog).getByLabelText("Account number")).toHaveFocus();
    fireEvent.change(within(dialog).getByLabelText("Website URL"), { target: { value: "http://insecure.example" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit" }));
    expect(await within(dialog).findByText("Choose the utility type.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the service provider.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter a web address starting with https://.")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Utility type"), { target: { value: "water" } });
    fireEvent.change(within(dialog).getByLabelText("Service provider"), { target: { value: "City of Irving" } });
    fireEvent.change(within(dialog).getByLabelText("Website URL"), { target: { value: "https://irving.example/pay" } });
    const pw = within(dialog).getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    fireEvent.change(pw, { target: { value: "S3cret-Water!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide password" }));
    expect(pw).toHaveAttribute("type", "password");
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit" }));

    expect(await within(drawer).findByText("Utility added.")).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({ utilityType: "water", serviceProvider: "City of Irving", websiteUrl: "https://irving.example/pay", password: "S3cret-Water!" });
    await within(drawer).findByText("City of Irving");
    expect(document.body).not.toHaveTextContent("S3cret-Water!");
    expect(within(drawer).getAllByLabelText("Password hidden")).toHaveLength(2);
  });

  it("a dialog opened from the drawer takes focus and Escape; closing it returns focus to its button", async () => {
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Utilities");
    const add = await within(panel).findByRole("button", { name: "Add utility" });
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole("dialog", { name: "Add utility" });
    await waitFor(() => expect(within(dialog).getByLabelText("Account number")).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add utility" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Company details" })).toBeInTheDocument();
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("Reveal runs the step-up first, shows the password for 30 seconds with a copy button, then hides it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stepped = false;
    api.routes[`POST /api/v1/utilities/${U1}/reveal-password`] = () => stepped ? { body: { password: "Pa55-Electric" } } : problem(403, { detail: "step_up_required" });
    api.routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "dev", ttlMinutes: 10 } });
    api.routes["POST /api/auth/step-up/dev"] = () => { stepped = true; return { body: { active: true, expiresAt: "2026-10-05T10:10:00Z" } }; };
    const copied = vi.spyOn(clipboard, "write").mockResolvedValue(undefined);
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Utilities");
    fireEvent.click(await within(panel).findByRole("button", { name: "Reveal password for Electricity" }));

    const stepUp = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(stepUp).toHaveTextContent("show utility portal passwords");
    expect(document.body).not.toHaveTextContent("Pa55-Electric");
    fireEvent.click(await within(stepUp).findByRole("button", { name: "Confirm (development)" }));

    expect(await within(drawer).findByText("Pa55-Electric")).toBeInTheDocument();
    const order = api.writes().map((c) => c.path);
    expect(order).toEqual([`/api/v1/utilities/${U1}/reveal-password`, "/api/auth/step-up/dev", `/api/v1/utilities/${U1}/reveal-password`]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Copy password for Electricity" }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith("Pa55-Electric"));
    expect(await within(drawer).findByText("Electricity password copied.")).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(PASSWORD_VISIBLE_MS - 1000); });
    expect(within(drawer).getByText("Pa55-Electric")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(within(drawer).queryByText("Pa55-Electric")).toBeNull();
    expect(within(drawer).getByRole("button", { name: "Reveal password for Electricity" })).toBeInTheDocument();
  });

  it("edits a utility: an empty password keeps it, the checkbox clears it", async () => {
    api.routes[`PATCH /api/v1/utilities/${U1}`] = () => ({ body: utility({ rowVersion: 2 }) });
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Utilities");
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit utility Electricity" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit utility" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(drawer).findByText("Utility saved.");
    const first = api.writes()[0]!;
    expect(first.headers["if-match"]).toBe('"1"');
    expect(first.body).not.toHaveProperty("password");

    fireEvent.click(within(panel).getByRole("button", { name: "Edit utility Electricity" }));
    dialog = await screen.findByRole("dialog", { name: "Edit utility" });
    fireEvent.click(within(dialog).getByLabelText("Remove the stored password"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toMatchObject({ password: null });
  });
});

describe("Bills", () => {
  it("lists bills with status pills and invoice, and links the CSV export", async () => {
    bills = [bill(), bill({ id: "b2", status: "paid", paidOn: "2026-09-10", invoice: null, amount: "330.00", paymentMethod: "card" })];
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Bills");
    const rows = within(await within(panel).findByRole("table", { name: "Bills" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Electricity");
    expect(rows[0]).toHaveTextContent("Autopay");
    expect(rows[0]).toHaveTextContent("$182.40");
    expect(within(rows[0]!).getByText("Overdue")).toHaveClass("badge", "bill-overdue");
    expect(rows[0]).toHaveTextContent("txu-aug.pdf");
    expect(within(rows[1]!).getByText("Paid")).toHaveClass("badge", "bill-paid");
    expect(within(panel).getByRole("link", { name: "Export bills as CSV" })).toHaveAttribute("href", `/api/v1/companies/${C1}/bills/export.csv`);

    fireEvent.change(within(panel).getByRole("searchbox", { name: "Search bills" }), { target: { value: "TXU" } });
    await waitFor(() => expect(api.gets(`/api/v1/companies/${C1}/bills`).at(-1)!.url.searchParams.get("q")).toBe("TXU"));
  });

  it("adds a bill after validation", async () => {
    api.routes[`POST /api/v1/companies/${C1}/bills`] = () => ({ status: 201, body: bill({ id: "b9" }) });
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Bills");
    fireEvent.click(await within(panel).findByRole("button", { name: "Add bill" }));
    const dialog = await screen.findByRole("dialog", { name: "Add bill" });
    await within(dialog).findByRole("option", { name: "Electricity · TXU Energy" });
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "0" } });
    fireEvent.change(within(dialog).getByLabelText("Billing start"), { target: { value: "2026-09-01" } });
    fireEvent.change(within(dialog).getByLabelText("Billing end"), { target: { value: "2026-08-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add bill" }));
    expect(await within(dialog).findByText("Choose the utility.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an amount above 0, with up to 2 decimals.")).toBeInTheDocument();
    expect(within(dialog).getByText("The billing end can't be before the start.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the due date.")).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Utility"), { target: { value: U1 } });
    fireEvent.change(within(dialog).getByLabelText("Payment method"), { target: { value: "ach" } });
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "99.5" } });
    fireEvent.change(within(dialog).getByLabelText("Billing end"), { target: { value: "2026-09-30" } });
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-10-20" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add bill" }));
    expect(await within(drawer).findByText("Bill added.")).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({
      utilityId: U1, paymentMethod: "ach", amount: "99.50", billingStart: "2026-09-01", billingEnd: "2026-09-30", dueDate: "2026-10-20",
    });
  });

  it("voids a bill with a reason after confirmation", async () => {
    api.routes[`POST /api/v1/bills/${B1}/void`] = () => { bills = []; return { body: {} }; };
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Bills");
    fireEvent.click(await within(panel).findByRole("button", { name: /^Void Electricity bill due/ }));
    const dialog = await screen.findByRole("dialog", { name: "Void bill" });
    expect(dialog).toHaveTextContent("$182.40");
    fireEvent.click(within(dialog).getByRole("button", { name: "Void bill" }));
    expect(await within(dialog).findByText("Give a reason for voiding this bill.")).toBeInTheDocument();
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Entered twice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Void bill" }));
    expect(await within(drawer).findByText(/was voided\./)).toBeInTheDocument();
    expect(api.writes()[0]).toMatchObject({ path: `/api/v1/bills/${B1}/void`, body: { reason: "Entered twice" } });
    expect(await within(panel).findByText("No bills yet.")).toBeInTheDocument();
  });

  it("uploads an invoice straight to storage and downloads a scanned one", async () => {
    api.routes[`POST /api/v1/bills/${B1}/invoice`] = () => ({ body: { documentId: "d2", upload: { url: "/storage-upload", fields: { key: "k1" }, expiresAt: "2026-10-05T10:02:00Z" } } });
    api.routes["POST /storage-upload"] = () => ({ status: 204 });
    api.routes[`GET /api/v1/bills/${B1}/invoice`] = () => ({ body: { url: "https://files.example/inv.pdf", expiresAt: "2026-10-05T10:05:00Z" } });
    const dl = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    wrap(<CompaniesPage me={opsAdmin} />);
    const drawer = await openCompany();
    const panel = await openTab(drawer, "Bills");
    fireEvent.click(await within(panel).findByRole("button", { name: /^Upload invoice for Electricity bill/ }));
    const input = within(panel).getByTestId("invoice-file") as HTMLInputElement;
    const file = new File(["%PDF-1.7"], "txu-sep.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await within(drawer).findByText(/Invoice uploaded for the Electricity bill/)).toBeInTheDocument();
    expect(api.writes()[0]!.body).toEqual({ fileName: "txu-sep.pdf", contentType: "application/pdf", size: file.size });
    expect(api.writes()[1]!.path).toBe("/storage-upload");
    const form = api.writes()[1]!.body as FormData;
    expect(form.get("key")).toBe("k1");
    expect(form.get("file")).toBeInstanceOf(File);

    fireEvent.click(within(panel).getByRole("button", { name: /^Download invoice for Electricity bill/ }));
    await waitFor(() => expect(dl).toHaveBeenCalledWith("https://files.example/inv.pdf"));
  });
});
