import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meFor, mockApi, problem, wrap, type Handler } from "../pipeline/testkit";
import { PaymentsPage } from "./PaymentsPage";
import type { BillablePlacement, Invoice, InvoiceDetail } from "./paymentsApi";

const NONE = { edit: false, recordPayment: false, void: false };
const inv = (id: string, extra: Partial<Invoice> = {}): Invoice => ({
  id, invoiceNo: `INV-${id}`, status: "delayed", invoiceDate: "2026-08-20", termsDays: 30, expectedDate: "2026-09-19",
  timesheetSubmittedOn: "2026-08-18", periodStart: "2026-08-01", periodEnd: "2026-08-15", hours: 80,
  amount: 6400, incentiveAmount: 250, paidAmount: 0, rate: 80,
  paymentCount: 0, firstReceivedOn: null, receivedOn: null, delayDays: 14, voidedAt: null, rowVersion: 1, createdAt: "2026-08-20T10:00:00Z",
  placement: { id: `p-${id}`, status: "joined", placementType: "w2", joinedOn: "2026-06-01", isFirstPlacement: true },
  candidate: { id: `c-${id}`, name: "Asha Iyer" }, technology: "Java", client: { id: "cl1", name: "Northwind Financial" },
  implementationPartner: { id: "ip1", name: "Infosys" }, vendor: { id: "v1", name: "Apex Staffing" },
  recruiter: { id: "r1", name: "Rohit R" }, team: { id: "t1", name: "Team Rohit" }, lead: { id: "l1", name: "Lena Lead" },
  manager: { id: "m1", name: "Manu Manager" }, associateDirector: { id: "ad", name: "Ada Director" },
  actions: { edit: true, recordPayment: true, void: true },
  ...extra,
});
const I1 = inv("i1");
const I2 = inv("i2", { candidate: { id: "c-i2", name: "Divya Menon" }, status: "received", delayDays: 2, paymentCount: 1, paidAmount: 6400, receivedOn: "2026-09-21", actions: NONE });
const detail = (i: Invoice, extra: Partial<InvoiceDetail> = {}): InvoiceDetail => ({ ...i, payments: [], ...extra });
const PLC: BillablePlacement = {
  id: "p-new", status: "joined", placementType: "c2c", joinedOn: "2026-07-01", isFirstPlacement: false,
  candidate: { id: "c-new", name: "Kiran Rao" }, technology: "Java", client: { id: "cl1", name: "Northwind Financial" },
  implementationPartner: null, vendor: null, recruiter: { id: "r1", name: "Rohit R" }, team: null, rate: 75,
  invoiceCount: 0, lastInvoiceDate: null, actions: { createInvoice: true },
};

let api: ReturnType<typeof mockApi>;
const base = (): Record<string, Handler> => ({
  "GET /api/v1/invoices": () => ({ body: { items: [I1, I2], nextCursor: null } }),
  "GET /api/v1/invoices/summary": () => ({ body: { counts: { pending: 3, delayed: 1, received: 1 }, maxDelayDays: 14, totals: { invoiced: 12800, received: 6400, outstanding: 6400 }, amountsHidden: 0 } }),
  "GET /api/v1/invoices/placements": () => ({ body: { items: [PLC] } }),
  "GET /api/v1/invoices/i1": () => ({ body: detail(I1) }),
  "GET /api/v1/invoices/i2": () => ({ body: detail(I2, { payments: [{ id: "pay1", receivedOn: "2026-09-21", amount: 6400, recordedBy: "Acct", recordedAt: "2026-09-21T12:00:00Z", voidedAt: null, actions: { void: false } }] }) }),
});
beforeEach(() => {
  api = mockApi(base());
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-03T12:00:00") });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const rowOf = async (name: string) => (await screen.findByText(name, { selector: "b" })).closest("tr")!;

describe("Payments dashboard", () => {
  it("shows the summary and one row per invoice with joined placement data, dates, status and people", async () => {
    wrap(<PaymentsPage me={meFor("accounts")} />);
    const tiles = await screen.findByRole("list", { name: "Payment summary" });
    expect(within(tiles).getByText("Outstanding")).toBeInTheDocument();
    expect(within(tiles).getByText("$6,400.00")).toBeInTheDocument();
    expect(within(tiles).getByText("Longest delay 14 days")).toBeInTheDocument();
    const r1 = await rowOf("Asha Iyer");
    expect(within(r1).getByText("Delayed · 14 days")).toHaveClass("badge", "pay-delayed");
    expect(within(r1).getByText("Northwind Financial")).toBeInTheDocument();
    expect(within(r1).getByText("via Infosys")).toBeInTheDocument();
    expect(within(r1).getByText("Apex Staffing")).toBeInTheDocument();
    expect(within(r1).getByText("$80.00/h")).toBeInTheDocument();
    expect(within(r1).getByText("Part $250.00")).toBeInTheDocument();
    expect(within(r1).getByText(/Net 30/)).toBeInTheDocument();
    expect(within(r1).getByText("TL Lena Lead")).toBeInTheDocument();
    expect(within(r1).getByText("AD Ada Director")).toBeInTheDocument();
    const r2 = await rowOf("Divya Menon");
    expect(within(r2).getByText("Received")).toHaveClass("pay-received");
    expect(within(r2).getByText("2 days late")).toBeInTheDocument();
  });

  it("filters by status and candidate name", async () => {
    wrap(<PaymentsPage me={meFor("accounts")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: "Delayed" }));
    await waitFor(() => expect(api.gets("/api/v1/invoices").at(-1)!.url.searchParams.get("status")).toBe("delayed"));
    fireEvent.change(screen.getByLabelText("Candidate"), { target: { value: "Asha" } });
    await waitFor(() => expect(api.gets("/api/v1/invoices").at(-1)!.url.searchParams.get("search")).toBe("Asha"));
    expect(api.gets("/api/v1/invoices/summary").at(-1)!.url.searchParams.get("search")).toBe("Asha");
  });

  it("Sales without money see no rate column and no New invoice button", async () => {
    const strip = ({ amount: _a, incentiveAmount: _i, paidAmount: _p, rate: _r, ...rest }: Invoice) => rest as Invoice;
    api.routes["GET /api/v1/invoices"] = () => ({ body: { items: [strip({ ...I1, actions: NONE })], nextCursor: null } });
    api.routes["GET /api/v1/invoices/summary"] = () => ({ body: { counts: { pending: 0, delayed: 1, received: 0 }, maxDelayDays: 14 } });
    wrap(<PaymentsPage me={meFor("recruiter")} />);
    await rowOf("Asha Iyer");
    expect(screen.queryByRole("columnheader", { name: "Rate / part" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New invoice/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Outstanding")).not.toBeInTheDocument();
  });

  it("raises an invoice on a joined placement with an Idempotency-Key and shows the expected date", async () => {
    let sent: { body: unknown; headers: Record<string, string> } | null = null;
    api.routes["POST /api/v1/invoices"] = (_u, body, headers) => { sent = { body, headers }; return { status: 201, body: { id: "i9", rowVersion: 1 } }; };
    wrap(<PaymentsPage me={meFor("accounts")} />);
    await rowOf("Asha Iyer");
    fireEvent.click(screen.getByRole("button", { name: /New invoice/ }));
    const dlg = await screen.findByRole("dialog", { name: "New invoice" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Raise invoice" }));
    expect(await within(dlg).findByText("Choose the placement to invoice.")).toBeInTheDocument();
    fireEvent.change(await within(dlg).findByRole("combobox", { name: "Placement" }), { target: { value: "p-new" } });
    fireEvent.change(within(dlg).getByLabelText("Invoice date"), { target: { value: "2026-10-01" } });
    fireEvent.change(within(dlg).getByLabelText("Payment terms (days)"), { target: { value: "45" } });
    expect(within(dlg).getByText(/Expected payment Nov 15, 2026/)).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Invoice amount (USD)"), { target: { value: "6000.5" } });
    fireEvent.change(within(dlg).getByLabelText("Invoice number"), { target: { value: "INV-77" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Raise invoice" }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.body).toMatchObject({ placementId: "p-new", invoiceNo: "INV-77", invoiceDate: "2026-10-01", termsDays: 45, amount: 6000.5, hours: null });
    expect(sent!.headers["idempotency-key"]).toMatch(/\S+/);
    expect(await screen.findByText("Invoice raised for Kiran Rao.")).toBeInTheDocument();
  });

  it("records a payment from the drawer, defaulting to the amount still due, and explains a refusal", async () => {
    const posts: unknown[] = [];
    api.routes["POST /api/v1/invoices/i1/payments"] = (_u, body) => {
      posts.push(body);
      return posts.length === 1 ? problem(422, { detail: "overpayment" }) : { status: 201, body: { id: "pay9", invoiceId: "i1", firstPayment: true } };
    };
    wrap(<PaymentsPage me={meFor("accounts")} />);
    fireEvent.click(within(await rowOf("Asha Iyer")).getByRole("button", { name: "Open invoice for Asha Iyer" }));
    const drawer = await screen.findByRole("dialog", { name: "Invoice for Asha Iyer" });
    expect(within(drawer).getByText("Ada Director")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Record payment…" }));
    const dlg = await screen.findByRole("dialog", { name: "Record a payment for Asha Iyer" });
    expect(within(dlg).getByLabelText("Amount received (USD)")).toHaveValue(6400);
    fireEvent.click(within(dlg).getByRole("button", { name: "Record payment" }));
    expect(await within(dlg).findByText("That payment is more than the amount still due on the invoice.")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Record payment" }));
    expect(await screen.findAllByText(/first payment: the recruiter, team lead and manager are notified/)).not.toHaveLength(0);
    expect(posts[1]).toEqual({ receivedOn: "2026-10-03", amount: 6400 });
    const keys = api.writes().filter((w) => w.path === "/api/v1/invoices/i1/payments").map((w) => w.headers["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
  });

  it("edits an invoice with If-Match, sending only the changed fields", async () => {
    let sent: { body: unknown; headers: Record<string, string> } | null = null;
    api.routes["PATCH /api/v1/invoices/i1"] = (_u, body, headers) => { sent = { body, headers }; return { body: { id: "i1", rowVersion: 2 } }; };
    wrap(<PaymentsPage me={meFor("accounts")} />);
    fireEvent.click(within(await rowOf("Asha Iyer")).getByRole("button", { name: "Open invoice for Asha Iyer" }));
    const drawer = await screen.findByRole("dialog", { name: "Invoice for Asha Iyer" });
    fireEvent.click(await within(drawer).findByRole("button", { name: "Edit invoice…" }));
    const dlg = await screen.findByRole("dialog", { name: "Edit invoice" });
    fireEvent.change(within(dlg).getByLabelText("Payment terms (days)"), { target: { value: "60" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save invoice" }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.body).toEqual({ termsDays: 60 });
    expect(sent!.headers["if-match"]).toBe('"1"');
  });
});
