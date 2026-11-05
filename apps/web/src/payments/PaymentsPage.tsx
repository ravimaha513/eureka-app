import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { INVOICE_STATUSES, MAX_TERMS_DAYS, PAYMENT_TERMS_DAYS, expectedPaymentDate } from "@eureka/shared";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { localToday } from "../employees/employeesApi";
import { Drawer, Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import {
  fmtMoney, invoiceStatusLabel, paymentError, paymentKeys, paymentsApi,
  type BillablePlacement, type Invoice, type InvoiceDetail, type InvoiceFields, type Named,
} from "./paymentsApi";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { FilterBar } from "../ui/FilterBar";
import { Menu } from "../ui/Menu";
import { useRoutedId, useSearchParams } from "../lib/router";
import { IconInput } from "../sites/ui";
import { DueDate, ToggleGroup, fmtDay, fmtUsd, fromControl } from "./cells";
import "./payments.css";

const PAGE_SIZE = 50;

export const InvoiceStatusBadge = ({ status, delayDays }: { status: string; delayDays?: number | null }) => (
  <span className={`badge pay-${status}`}>
    {invoiceStatusLabel(status)}{status === "delayed" && delayDays ? ` · ${delayDays} ${delayDays === 1 ? "day" : "days"}` : ""}
  </span>
);

const nameOf = (r: { candidate: Named }) => r.candidate.name ?? "Name hidden";
const who = (n: Named | null) => n?.name ?? "—";

const FILTER_KEYS = ["status", "from", "to", "q"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const late = (n: number) => `${n} ${n === 1 ? "day" : "days"} late`;

/**
 * Payments / incentive dashboard (gap L1, docs/payments-api.md): one row per
 * invoice with the placement data joined, the computed expected date, status
 * and delay. Accounts raises invoices and records payments; Sales see their
 * placements' invoices by hierarchy (amounts only with rate:read).
 */
export function PaymentsPage({ me, initialOpenId = null, onOpenChange }: {
  me?: Pick<Me, "capabilities">;
  /** The open invoice from the URL (/payments/<id>), when the app routes it. */
  initialOpenId?: string | null;
  onOpenChange?: (id: string | null) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [p, setP] = useSearchParams(FILTER_KEYS);
  const status = (INVOICE_STATUSES as readonly string[]).includes(p.status) ? p.status : "";
  const { from, to } = p;
  const search = p.q;
  const [searchText, setSearchText] = useState(p.q);
  const pager = useCursorPager();
  const { page, reset } = pager;
  const set = (patch: Partial<Record<FilterKey, string>>) => { setP(patch); reset(); };
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const canEdit = can(me, "invoice:update");

  useEffect(() => {
    const t = setTimeout(() => { if (searchText.trim() !== search) set({ q: searchText.trim() }); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const period = { from: from || undefined, to: to || undefined, search: search || undefined };
  const filters = { ...period, status, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: [...paymentKeys.all, "list", filters], queryFn: () => paymentsApi.list(filters), placeholderData: keepPreviousData });
  const summary = useQuery({ queryKey: [...paymentKeys.all, "summary", period], queryFn: () => paymentsApi.summary(period) });
  const items = q.data?.items ?? [];
  const showMoney = items.some((i) => "amount" in i) || summary.data?.totals !== undefined;
  const hasFilters = Boolean(status || from || to || search);
  const n = items.length;
  const countMsg = q.isLoading || q.error ? ""
    : `${n} ${n === 1 ? "invoice" : "invoices"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;
  const done = (m: string) => { setNotice(m); void qc.invalidateQueries({ queryKey: paymentKeys.all }); };
  const s = summary.data;
  const scoped = Boolean(from || to || search);
  const cols = showMoney ? 14 : 12;
  /** A summary tile that is also the status filter (pressed while that status is shown). */
  const tile = (key: string, label: string, value: ReactNode, hint: string) => (
    <li>
      <button type="button" className="card tile pay-tile" aria-pressed={status === key} onClick={() => set({ status: status === key ? "" : key })}>
        <span className="tilelabel">{label}</span><span className="tilevalue">{value}</span><span className="tilehint">{hint}</span>
      </button>
    </li>
  );

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Payments</h1>
          <p className="sub">Vendor invoices per placement, expected payment dates and delays. The recruiter and team lead are alerted when a payment is late.</p>
        </div>
        {canEdit && (
          <div className="pageactions">
            <button type="button" className="btn primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New invoice</button>
          </div>
        )}
      </div>

      {s && (
        <ul className="tiles pay-tiles" aria-label="Payment summary">
          {showMoney && s.totals && (
            <li className="card tile pay-outstanding"><span className="tilelabel">Outstanding</span><span className="tilevalue">{fmtUsd(s.totals.outstanding)}</span>
              <span className="tilehint">{fmtUsd(s.totals.received)} received of {fmtUsd(s.totals.invoiced)} invoiced{s.amountsHidden ? ` (${s.amountsHidden} without visible amounts)` : ""}{scoped ? " · for these filters" : ""}</span></li>
          )}
          {tile("delayed", "Delayed", s.counts.delayed, s.counts.delayed ? `Longest delay ${s.maxDelayDays} ${s.maxDelayDays === 1 ? "day" : "days"}` : "Nothing overdue")}
          {tile("pending", "Pending", s.counts.pending, "Not yet due")}
          {tile("received", "Received", s.counts.received, "Fully paid")}
        </ul>
      )}

      <FilterBar label="Invoice filters" moreCount={0} activeCount={[status, from, to].filter(Boolean).length}
        hasFilters={hasFilters} onClear={() => { setSearchText(""); set({ status: "", from: "", to: "", q: "" }); }}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Candidate</label>
            <input id={`${id}-q`} type="search" placeholder="Candidate name" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
        }
        primary={
          <>
            <ToggleGroup label="Payment status" options={[["", "All"], ...INVOICE_STATUSES.map((v) => [v, invoiceStatusLabel(v)] as const)]}
              value={status} onChange={(v) => set({ status: v === status ? "" : v })} />
            <div className="field inline pay-date">
              <label htmlFor={`${id}-from`}>Invoiced from</label>
              <input id={`${id}-from`} type="date" value={from} max={to || undefined} onChange={(e) => set({ from: e.target.value })} />
            </div>
            <div className="field inline pay-date">
              <label htmlFor={`${id}-to`}>Invoiced to</label>
              <input id={`${id}-to`} type="date" value={to} min={from || undefined} onChange={(e) => set({ to: e.target.value })} />
            </div>
          </>
        }
        summaryEnd={!q.isLoading && !q.error ? <span className="muted pay-count">{n}{q.data?.nextCursor ? "+" : ""} {n === 1 ? "invoice" : "invoices"}</span> : null} />

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={paymentError(q.error)} />
        ) : (
          <table className="dtable bo-dtable paytable" aria-label="Invoices" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Candidate</th><th>Status</th><th>Invoice</th>{showMoney && <th className="num">Amount</th>}<th>Expected</th><th>Received</th>
              <th>Client / vendor</th><th>Recruiter / TL</th><th className="p2">Manager / AD</th>
              {showMoney && <th className="p3 num">Rate / part</th>}<th className="p3">Joined</th><th className="p3">Timesheet</th><th className="p3 num">Hours</th>
              <th className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((r) => {
                const settled = r.status === "received" || r.status === "void";
                return (
                  <tr key={r.id} className="rowopen" onClick={(e) => { if (!fromControl(e)) setOpenId(r.id); }}>
                    <td className="c-primary"><b>{nameOf(r)}</b><span className="block">{r.technology ?? ""}</span></td>
                    <td className="c-badge" data-label="Status"><InvoiceStatusBadge status={r.status} delayDays={r.delayDays} />
                      {r.status === "received" && r.delayDays ? <span className="block">{late(r.delayDays)}</span> : null}</td>
                    <td data-label="Invoice">{r.invoiceNo ?? <span className="muted">No number</span>}<span className="block">{fmtDay(r.invoiceDate)} · Net {r.termsDays}</span></td>
                    {showMoney && <td className="num" data-label="Amount">{"amount" in r ? fmtUsd(r.amount) : <span className="muted">Hidden</span>}</td>}
                    <td data-label="Expected"><DueDate on={r.expectedDate} done={settled} lateWord="late" /></td>
                    <td data-label="Received">{r.receivedOn ? fmtDay(r.receivedOn) : r.paymentCount ? <span className="muted">Part paid</span> : "—"}
                      {"paidAmount" in r && r.paymentCount > 0 && <span className="block">{fmtUsd(r.paidAmount)}</span>}</td>
                    <td data-label="Client">{r.client.name}{r.implementationPartner && <span className="block">via {r.implementationPartner.name}</span>}
                      <span className="block">{r.vendor?.name ?? "No vendor"}</span></td>
                    <td data-label="Recruiter">{r.recruiter.name ?? "—"}<span className="block">TL {who(r.lead)}</span></td>
                    <td className="p2" data-label="Manager">{who(r.manager)}<span className="block">AD {who(r.associateDirector)}</span></td>
                    {showMoney && <td className="p3 num" data-label="Rate">{"rate" in r ? <>{r.rate === null || r.rate === undefined ? "—" : `${fmtUsd(r.rate)}/h`}<span className="block">{r.incentiveAmount !== null && r.incentiveAmount !== undefined ? `Part ${fmtUsd(r.incentiveAmount)}` : ""}</span></> : <span className="muted">Hidden</span>}</td>}
                    <td className="p3" data-label="Joined">{fmtDay(r.placement.joinedOn)}</td>
                    <td className="p3" data-label="Timesheet">{fmtDay(r.timesheetSubmittedOn)}</td>
                    <td className="p3 num" data-label="Hours">{r.hours ?? "—"}</td>
                    <td className="c-act">
                      <button type="button" className="btn sm" onClick={() => setOpenId(r.id)} aria-label={`Open invoice for ${nameOf(r)}`}>Open</button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={cols} className="empty">{hasFilters ? "No invoices match these filters." : "No invoices yet. Accounts raises invoices on joined placements."}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Invoice pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>

      {openId && <InvoiceDrawer id={openId} initial={items.find((i) => i.id === openId) ?? null} onClose={() => setOpenId(null)} onNotice={done} />}
      {creating && <InvoiceDialog onClose={() => setCreating(false)} onDone={(m) => { setCreating(false); done(m); }} />}
    </>
  );
}

type Action = "edit" | "pay" | "void" | { voidPayment: string };

function InvoiceDrawer({ id, initial, onClose, onNotice }: {
  id: string; initial: Invoice | null; onClose: () => void; onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const hid = useId();
  const q = useQuery({ queryKey: paymentKeys.detail(id), queryFn: () => paymentsApi.get(id), placeholderData: initial ? { ...initial, payments: [] } as InvoiceDetail : undefined });
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const r = q.data;
  const full = Boolean(r && !q.isPlaceholderData);
  const done = (m: string) => {
    setAction(null); setMessage(m); onNotice(m);
    void qc.invalidateQueries({ queryKey: paymentKeys.all });
  };
  const money = r ? "amount" in r : false;
  const due = r && money && r.amount !== null && r.amount !== undefined ? Math.max(0, Math.round(((r.amount ?? 0) - (r.paidAmount ?? 0)) * 100) / 100) : null;

  return (
    <>
      <Drawer title={r ? `Invoice for ${nameOf(r)}` : "Invoice"} onClose={onClose} suspended={action !== null} wide closeLabel="Close invoice details">
        {q.isLoading && !r ? <Loading /> : !r ? (
          <p className="error" role="alert">{paymentError(q.error)}</p>
        ) : (
          <>
            {/* Action strip: status, what is still due and the next step (Record payment) before the facts. */}
            <div className="actionstrip pay-strip">
              <div className="as-status">
                <InvoiceStatusBadge status={r.status} delayDays={r.delayDays} />
                <span className="as-note">
                  Expected <DueDate on={r.expectedDate} done={r.status === "received" || r.status === "void"} lateWord="late" />
                  {due !== null && due > 0 && <> · <b className="pay-due">{fmtUsd(due)}</b> still due</>}
                </span>
              </div>
              {(r.actions.edit || r.actions.recordPayment || r.actions.void) && (
                <div className="as-actions" role="group" aria-label="Actions">
                  {r.actions.recordPayment && <button type="button" className="btn primary" onClick={() => setAction("pay")}>Record payment…</button>}
                  {r.actions.edit && <button type="button" className="btn" onClick={() => setAction("edit")}>Edit invoice…</button>}
                  <Menu label={`More actions for the invoice of ${nameOf(r)}`} text="More"
                    items={[r.actions.void && { label: "Void invoice…", danger: true, onSelect: () => setAction("void") }]} />
                </div>
              )}
            </div>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>

            <section className="bo-group" aria-labelledby={`${hid}-inv`}>
              <h3 id={`${hid}-inv`}>Invoice</h3>
              <dl className="bo-facts">
                <div><dt>Invoice</dt><dd>{r.invoiceNo ?? "No number"} · {fmtDay(r.invoiceDate)}</dd></div>
                <div><dt>Payment terms</dt><dd>Net {r.termsDays}</dd></div>
                <div><dt>Expected payment</dt><dd>{fmtDay(r.expectedDate)}</dd></div>
                <div><dt>Delay</dt><dd>{r.delayDays === null ? "—" : `${r.delayDays} ${r.delayDays === 1 ? "day" : "days"}`}</dd></div>
                {money && <>
                  <div><dt>Invoice amount</dt><dd>{fmtUsd(r.amount)}</dd></div>
                  <div><dt>Incentive part</dt><dd>{fmtUsd(r.incentiveAmount)}</dd></div>
                  <div><dt>Received</dt><dd>{fmtUsd(r.paidAmount)}{r.receivedOn ? ` on ${fmtDay(r.receivedOn)}` : ""}</dd></div>
                </>}
                {!money && <div><dt>Received</dt><dd>{r.receivedOn ? fmtDay(r.receivedOn) : r.paymentCount ? "Partly" : "Not yet"}</dd></div>}
              </dl>
            </section>

            <section className="bo-group" aria-labelledby={`${hid}-pl`}>
              <h3 id={`${hid}-pl`}>Placement</h3>
              <dl className="bo-facts">
                <div><dt>Candidate</dt><dd>{nameOf(r)}{r.technology ? ` · ${r.technology}` : ""}</dd></div>
                <div><dt>Client</dt><dd>{r.client.name}{r.implementationPartner ? ` (via ${r.implementationPartner.name})` : ""}</dd></div>
                <div><dt>Vendor</dt><dd>{who(r.vendor)}</dd></div>
                {money && <div><dt>Rate</dt><dd>{r.rate === null || r.rate === undefined ? "—" : `${fmtUsd(r.rate)}/h`}</dd></div>}
                <div><dt>Joined</dt><dd>{fmtDay(r.placement.joinedOn)}</dd></div>
                <div><dt>Timesheet to Accounts</dt><dd>{fmtDay(r.timesheetSubmittedOn)}</dd></div>
                <div><dt>Billing period</dt><dd>{r.periodStart || r.periodEnd ? `${fmtDay(r.periodStart)} – ${fmtDay(r.periodEnd)}` : "—"}</dd></div>
                <div><dt>Hours billed</dt><dd>{r.hours ?? "—"}</dd></div>
              </dl>
            </section>

            <section className="bo-group" aria-labelledby={`${hid}-pp`}>
              <h3 id={`${hid}-pp`}>People</h3>
              <dl className="bo-facts">
                <div><dt>Recruiter</dt><dd>{who(r.recruiter)}</dd></div>
                <div><dt>Team lead</dt><dd>{who(r.lead)}{r.team?.name ? ` · ${r.team.name}` : ""}</dd></div>
                <div><dt>Manager</dt><dd>{who(r.manager)}</dd></div>
                <div><dt>Associate director</dt><dd>{who(r.associateDirector)}</dd></div>
              </dl>
            </section>

            <section className="manageblock" aria-labelledby={`${hid}-p`}>
              <h3 id={`${hid}-p`}>Payments received</h3>
              {!full ? <p className="muted">Loading payments…</p> : r.payments.length === 0 ? <p className="muted">No payment recorded yet.</p> : (
                <div className="tablewrap"><table className="mini" aria-labelledby={`${hid}-p`}>
                  <thead><tr><th>Received</th>{money && <th>Amount</th>}<th>Recorded</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {r.payments.map((p) => (
                      <tr key={p.id} className={p.voidedAt ? "muted" : undefined}>
                        <td>{fmtDate(p.receivedOn)}{p.voidedAt && <>{" "}<span className="badge pay-void">Void</span></>}</td>
                        {money && <td>{fmtMoney(p.amount)}</td>}
                        <td>{fmtDate(p.recordedAt)}{p.recordedBy ? ` by ${p.recordedBy}` : ""}</td>
                        <td className="rowactions">
                          {p.actions.void && <button type="button" className="btn sm" onClick={() => setAction({ voidPayment: p.id })}
                            aria-label={`Void payment received ${fmtDate(p.receivedOn)}`}>Void</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>
          </>
        )}
      </Drawer>

      {r && action === "edit" && <InvoiceDialog invoice={r} onClose={() => setAction(null)} onDone={done} />}
      {r && action === "pay" && <PaymentDialog invoice={r} due={due} onClose={() => setAction(null)} onDone={done} />}
      {r && action === "void" && (
        <ConfirmDialog title="Void this invoice?" confirmLabel="Void invoice" danger onClose={() => setAction(null)}
          onDone={() => done("Invoice voided.")} action={() => paymentsApi.void(r.id, r.rowVersion)} formatError={paymentError}>
          A voided invoice leaves the dashboard and gets no delay alerts. Its number can be used again. This can't be undone.
        </ConfirmDialog>
      )}
      {r && action !== null && typeof action === "object" && (
        <ConfirmDialog title="Void this payment?" confirmLabel="Void payment" danger onClose={() => setAction(null)}
          onDone={() => done("Payment voided.")} action={() => paymentsApi.voidPayment(r.id, action.voidPayment)} formatError={paymentError}>
          Use this for a payment recorded in error. The invoice's status and delay are worked out again without it.
        </ConfirmDialog>
      )}
    </>
  );
}

const toNum = (v: string) => (v.trim() === "" ? null : Number(v));
const moneyOk = (v: number | null, min = 0) => v === null || (Number.isFinite(v) && v >= min && Math.round(v * 100) === v * 100);

/** New invoice (with a placement picker) or edit an existing one. */
function InvoiceDialog({ invoice, onClose, onDone }: { invoice?: InvoiceDetail; onClose: () => void; onDone: (m: string) => void }) {
  const today = localToday();
  const editing = invoice !== undefined;
  const pid = useId();
  const [placement, setPlacement] = useState<BillablePlacement | null>(null);
  const [pSearch, setPSearch] = useState("");
  const [pSearchQ, setPSearchQ] = useState("");
  const [invoiceNo, setInvoiceNo] = useState(invoice?.invoiceNo ?? "");
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? today);
  const [terms, setTerms] = useState(String(invoice?.termsDays ?? 30));
  const [timesheet, setTimesheet] = useState(invoice?.timesheetSubmittedOn ?? "");
  const [periodStart, setPeriodStart] = useState(invoice?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(invoice?.periodEnd ?? "");
  const [hours, setHours] = useState(invoice?.hours?.toString() ?? "");
  const [amount, setAmount] = useState(invoice?.amount?.toString() ?? "");
  const [incentive, setIncentive] = useState(invoice?.incentiveAmount?.toString() ?? "");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const key = useRef(paymentsApi.newKey());
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(paymentError);
  const showMoney = !editing || "amount" in invoice;

  useEffect(() => {
    const t = setTimeout(() => setPSearchQ(pSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [pSearch]);
  const picker = useQuery({
    queryKey: [...paymentKeys.all, "placements", pSearchQ], enabled: !editing,
    queryFn: () => paymentsApi.placements({ search: pSearchQ || undefined }),
  });
  const choices = (picker.data?.items ?? []).filter((p) => p.actions.createInvoice);
  const termsN = Number(terms);
  const expected = useMemo(() => (invoiceDate && Number.isInteger(termsN) && termsN >= 0 && termsN <= MAX_TERMS_DAYS
    ? expectedPaymentDate(invoiceDate, termsN) : null), [invoiceDate, termsN]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!editing && !placement) e.placement = "Choose the placement to invoice.";
    if (!invoiceDate) e.invoiceDate = "Enter the invoice date.";
    else if (invoiceDate > today) e.invoiceDate = "The invoice date can't be in the future.";
    if (!Number.isInteger(termsN) || termsN < 0 || termsN > MAX_TERMS_DAYS) e.terms = `Terms are 0 to ${MAX_TERMS_DAYS} days.`;
    if (timesheet && timesheet > today) e.timesheet = "The timesheet date can't be in the future.";
    if (periodStart && periodEnd && periodEnd < periodStart) e.periodEnd = "The period must end on or after its start.";
    const h = toNum(hours), a = toNum(amount), inc = toNum(incentive);
    if (h !== null && (!moneyOk(h) || h <= 0 || h > 5000)) e.hours = "Hours are more than 0 and at most 5,000, with up to two decimals.";
    if (showMoney && a !== null && (!moneyOk(a) || a <= 0)) e.amount = "Enter an amount greater than zero with up to two decimals.";
    if (showMoney && inc !== null && !moneyOk(inc)) e.incentive = "Enter zero or more with up to two decimals.";
    return e;
  };

  const body = (): InvoiceFields => ({
    invoiceNo: invoiceNo.trim() || null, invoiceDate, termsDays: termsN, timesheetSubmittedOn: timesheet || null,
    periodStart: periodStart || null, periodEnd: periodEnd || null, hours: toNum(hours),
    ...(showMoney ? { amount: toNum(amount), incentiveAmount: toNum(incentive) } : {}),
  });

  return (
    <Dialog title={editing ? "Edit invoice" : "New invoice"} onClose={onClose} wide>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        const e = validate();
        setErrs(e);
        if (Object.keys(e).length) { failed(); return; }
        void submit.run(async () => {
          if (editing) {
            const b = body();
            // Send only what changed.
            const cur: Record<string, unknown> = {
              invoiceNo: invoice.invoiceNo, invoiceDate: invoice.invoiceDate, termsDays: invoice.termsDays,
              timesheetSubmittedOn: invoice.timesheetSubmittedOn, periodStart: invoice.periodStart, periodEnd: invoice.periodEnd,
              hours: invoice.hours, amount: invoice.amount ?? null, incentiveAmount: invoice.incentiveAmount ?? null,
            };
            const changed = Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== cur[k]));
            if (Object.keys(changed).length === 0) { onDone("Nothing changed."); return; }
            await paymentsApi.update(invoice.id, invoice.rowVersion, changed);
            onDone("Invoice saved.");
          } else {
            await paymentsApi.create({ placementId: placement!.id, ...body() }, key.current);
            onDone(`Invoice raised for ${placement!.candidate.name ?? "the placement"}.`);
          }
        }).then(() => failed());
      }}>
        {!editing && (
          <fieldset className="spanall pay-fieldset">
            <legend>Placement</legend>
            <label className="field">Search joined placements
              <input type="search" value={pSearch} maxLength={80} onChange={(e) => setPSearch(e.target.value)} data-autofocus />
            </label>
            {picker.isLoading ? <p className="muted">Loading placements…</p> : choices.length === 0 ? (
              <p className="muted">No joined placement matches.</p>
            ) : (
              <label className="field">Placement
                <select value={placement?.id ?? ""} aria-invalid={errs.placement ? true : undefined} aria-describedby={errs.placement ? `${pid}-err` : undefined}
                  onChange={(e) => setPlacement(choices.find((p) => p.id === e.target.value) ?? null)}>
                  <option value="">Choose…</option>
                  {choices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.candidate.name ?? "Name hidden"} · ${p.client.name ?? ""} · joined ${fmtDate(p.joinedOn)}${p.invoiceCount ? ` · ${p.invoiceCount} invoice${p.invoiceCount === 1 ? "" : "s"}` : ""}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {errs.placement && <small id={`${pid}-err`} className="error fielderr">{errs.placement}</small>}
          </fieldset>
        )}
        <div className="formgrid cols2 paygrid">
          <Field label="Timesheet sent to Accounts" error={errs.timesheet} hint="After client approval.">
            {(p) => <input {...p} type="date" value={timesheet} max={today} onChange={(e) => setTimesheet(e.target.value)} />}
          </Field>
          <Field label="Billing period start">
            {(p) => <input {...p} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />}
          </Field>
          <Field label="Billing period end" error={errs.periodEnd}>
            {(p) => <input {...p} type="date" value={periodEnd} min={periodStart || undefined} onChange={(e) => setPeriodEnd(e.target.value)} />}
          </Field>
          <Field label="Hours billed" error={errs.hours}>
            {(p) => <input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />}
          </Field>
          {showMoney && (
            <>
              <Field label="Invoice amount (USD)" error={errs.amount}>
                {(p) => <IconInput prefix="$"><input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={amount} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setAmount(e.target.value)} /></IconInput>}
              </Field>
              <Field label="Incentive part (USD)" error={errs.incentive}>
                {(p) => <IconInput prefix="$"><input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={incentive} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setIncentive(e.target.value)} /></IconInput>}
              </Field>
            </>
          )}
          <Field label="Invoice number" hint="Optional; unique among live invoices.">
            {(p) => <input {...p} value={invoiceNo} maxLength={60} onChange={(e) => setInvoiceNo(e.target.value)} data-autofocus={editing || undefined} />}
          </Field>
          <Field label="Invoice date" error={errs.invoiceDate}>
            {(p) => <input {...p} type="date" value={invoiceDate} max={today} onChange={(e) => setInvoiceDate(e.target.value)} />}
          </Field>
          <Field label="Payment terms (days)" error={errs.terms} hint={expected ? `Expected payment ${fmtDate(expected)}` : undefined}>
            {(p) => (
              <>
                <input {...p} type="number" min={0} max={MAX_TERMS_DAYS} step={1} list="pay-terms" value={terms} onChange={(e) => setTerms(e.target.value)} />
                <datalist id="pay-terms">{PAYMENT_TERMS_DAYS.map((d) => <option key={d} value={d}>Net {d}</option>)}</datalist>
              </>
            )}
          </Field>
        </div>
        {placement && placement.rate !== undefined && <p className="muted">Placement rate {placement.rate === null ? "not set" : `${fmtMoney(placement.rate)}/h`}.</p>}
        <DialogActions onCancel={onClose} submitLabel={editing ? "Save invoice" : "Raise invoice"} busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

function PaymentDialog({ invoice, due, onClose, onDone }: { invoice: InvoiceDetail; due: number | null; onClose: () => void; onDone: (m: string) => void }) {
  const today = localToday();
  const [receivedOn, setReceivedOn] = useState(today);
  const [amount, setAmount] = useState(due !== null && due > 0 ? String(due) : "");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const key = useRef(paymentsApi.newKey());
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(paymentError);
  return (
    <Dialog title={`Record a payment for ${nameOf(invoice)}`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        const e: Record<string, string> = {};
        const a = toNum(amount);
        if (!receivedOn) e.receivedOn = "Enter the date the payment was received.";
        else if (receivedOn > today) e.receivedOn = "The payment date can't be in the future.";
        else if (receivedOn < invoice.invoiceDate) e.receivedOn = "The payment date can't be before the invoice date.";
        if (a === null || !moneyOk(a) || a <= 0) e.amount = "Enter an amount greater than zero with up to two decimals.";
        else if (due !== null && a > due) e.amount = `At most ${fmtMoney(due)} is still due.`;
        setErrs(e);
        if (Object.keys(e).length) { failed(); return; }
        void submit.run(async () => {
          const r = await paymentsApi.recordPayment(invoice.id, { receivedOn, amount: a! }, key.current);
          onDone(r.firstPayment ? "Payment recorded. This was the placement's first payment: the recruiter, team lead and manager are notified." : "Payment recorded.");
        }).then(() => failed());
      }}>
        <p className="dialogbody">Invoice {invoice.invoiceNo ?? "without number"} of {fmtDate(invoice.invoiceDate)}, expected {fmtDate(invoice.expectedDate)}.
          {due !== null ? ` Still due: ${fmtMoney(due)}.` : ""}</p>
        <Field label="Received on" error={errs.receivedOn}>
          {(p) => <input {...p} type="date" value={receivedOn} min={invoice.invoiceDate} max={today} onChange={(e) => setReceivedOn(e.target.value)} data-autofocus />}
        </Field>
        <Field label="Amount received (USD)" error={errs.amount}>
          {(p) => <IconInput prefix="$"><input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={amount} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setAmount(e.target.value)} /></IconInput>}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Record payment" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
