import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { INVOICE_STATUSES, MAX_TERMS_DAYS, PAYMENT_TERMS_DAYS, expectedPaymentDate } from "@eureka/shared";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { localToday } from "../employees/employeesApi";
import { Drawer, Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import {
  fmtMoney, invoiceStatusLabel, paymentError, paymentKeys, paymentsApi,
  type BillablePlacement, type Invoice, type InvoiceDetail, type InvoiceFields, type Named,
} from "./paymentsApi";

const PAGE_SIZE = 50;

export const InvoiceStatusBadge = ({ status, delayDays }: { status: string; delayDays?: number | null }) => (
  <span className={`badge pay-${status}`}>
    {invoiceStatusLabel(status)}{status === "delayed" && delayDays ? ` · ${delayDays} ${delayDays === 1 ? "day" : "days"}` : ""}
  </span>
);

const nameOf = (r: { candidate: Named }) => r.candidate.name ?? "Name hidden";
const who = (n: Named | null) => n?.name ?? "—";

/**
 * Payments / incentive dashboard (gap L1, docs/payments-api.md): one row per
 * invoice with the placement data joined, the computed expected date, status
 * and delay. Accounts raises invoices and records payments; Sales see their
 * placements' invoices by hierarchy (amounts only with rate:read).
 */
export function PaymentsPage({ me }: { me?: Pick<Me, "capabilities"> }) {
  const id = useId();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  const canEdit = can(me, "invoice:update");

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const period = { from: from || undefined, to: to || undefined, search: search || undefined };
  const filters = { ...period, status, cursor: cursors[page] ?? "", limit: PAGE_SIZE };
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

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Payments</h1>
          <p className="sub">Vendor invoices per placement, expected payment dates and delays. The recruiter and team lead are alerted when a payment is late.</p>
        </div>
        {canEdit && (
          <button type="button" className="btn primary push" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> New invoice</button>
        )}
      </div>

      {s && (
        <ul className="tiles" aria-label="Payment summary">
          <li className="card tile"><span className="tilelabel">Pending</span><span className="tilevalue">{s.counts.pending}</span><span className="tilehint">Not yet due</span></li>
          <li className="card tile"><span className="tilelabel">Delayed</span><span className="tilevalue">{s.counts.delayed}</span>
            <span className="tilehint">{s.counts.delayed ? `Longest delay ${s.maxDelayDays} ${s.maxDelayDays === 1 ? "day" : "days"}` : "Nothing overdue"}</span></li>
          <li className="card tile"><span className="tilelabel">Received</span><span className="tilevalue">{s.counts.received}</span><span className="tilehint">Fully paid</span></li>
          {s.totals && (
            <li className="card tile"><span className="tilelabel">Outstanding</span><span className="tilevalue">{fmtMoney(s.totals.outstanding)}</span>
              <span className="tilehint">{fmtMoney(s.totals.received)} received of {fmtMoney(s.totals.invoiced)} invoiced{s.amountsHidden ? ` (${s.amountsHidden} without visible amounts)` : ""}</span></li>
          )}
        </ul>
      )}

      <form className="filters" role="search" aria-label="Invoice filters" onSubmit={(e) => e.preventDefault()}>
        <div className="chipfilter">
          <span id={`${id}-st`} className="chiplabel">Payment status</span>
          <div className="tabs wrap" role="group" aria-labelledby={`${id}-st`}>
            <button type="button" className="tab" aria-pressed={status === ""} onClick={() => { setStatus(""); reset(); }}>All</button>
            {INVOICE_STATUSES.map((v) => (
              <button key={v} type="button" className="tab" aria-pressed={status === v} onClick={() => { setStatus(status === v ? "" : v); reset(); }}>
                {invoiceStatusLabel(v)}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Candidate</label>
            <input id={`${id}-q`} type="search" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-from`}>Invoiced from</label>
            <input id={`${id}-from`} type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); reset(); }} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>to</label>
            <input id={`${id}-to`} type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); reset(); }} />
          </div>
          {hasFilters && (
            <button type="button" className="btn" onClick={() => { setStatus(""); setFrom(""); setTo(""); setSearchText(""); setSearch(""); reset(); }}>Clear filters</button>
          )}
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{paymentError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <div className="tablewrap"><table aria-label="Invoices" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Candidate</th><th>Client / vendor</th>{showMoney && <th>Rate / part</th>}<th>Joined</th><th>Timesheet</th>
              <th>Invoice</th><th>Expected</th><th>Status</th><th>Received</th><th>Hours</th><th>Recruiter / TL</th><th>Manager / AD</th>
              <th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td><b>{nameOf(r)}</b><span className="block muted">{r.technology ?? ""}</span></td>
                  <td>{r.client.name}{r.implementationPartner && <span className="block muted">via {r.implementationPartner.name}</span>}
                    <span className="block muted">{r.vendor?.name ?? "No vendor"}</span></td>
                  {showMoney && <td>{"rate" in r ? <>{r.rate === null || r.rate === undefined ? "—" : `${fmtMoney(r.rate)}/h`}<span className="block muted">{r.incentiveAmount !== null && r.incentiveAmount !== undefined ? `Part ${fmtMoney(r.incentiveAmount)}` : ""}</span></> : <span className="muted">Hidden</span>}</td>}
                  <td>{fmtDate(r.placement.joinedOn)}</td>
                  <td>{fmtDate(r.timesheetSubmittedOn)}</td>
                  <td>{r.invoiceNo ?? <span className="muted">No number</span>}<span className="block muted">{fmtDate(r.invoiceDate)} · Net {r.termsDays}</span>
                    {"amount" in r && r.amount !== null && <span className="block muted">{fmtMoney(r.amount)}</span>}</td>
                  <td>{fmtDate(r.expectedDate)}</td>
                  <td><InvoiceStatusBadge status={r.status} delayDays={r.delayDays} />
                    {r.status === "received" && r.delayDays ? <span className="block muted">{r.delayDays} {r.delayDays === 1 ? "day" : "days"} late</span> : null}</td>
                  <td>{r.receivedOn ? fmtDate(r.receivedOn) : r.paymentCount ? <span className="muted">Part paid</span> : "—"}
                    {"paidAmount" in r && r.paymentCount > 0 && <span className="block muted">{fmtMoney(r.paidAmount)}</span>}</td>
                  <td>{r.hours ?? "—"}</td>
                  <td>{r.recruiter.name ?? "—"}<span className="block muted">TL {who(r.lead)}</span></td>
                  <td>{who(r.manager)}<span className="block muted">AD {who(r.associateDirector)}</span></td>
                  <td className="rowactions">
                    <button type="button" className="btn sm" onClick={() => setOpenId(r.id)} aria-label={`Open invoice for ${nameOf(r)}`}>Open</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={showMoney ? 13 : 12} className="empty">{hasFilters ? "No invoices match these filters." : "No invoices yet. Accounts raises invoices on joined placements."}</td></tr>
              )}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <nav className="pager" aria-label="Invoice pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
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
        {q.isLoading && !r ? <p className="empty">Loading…</p> : !r ? (
          <p className="error" role="alert">{paymentError(q.error)}</p>
        ) : (
          <>
            <p><InvoiceStatusBadge status={r.status} delayDays={r.delayDays} /></p>
            <dl className="facts">
              <dt>Candidate</dt><dd>{nameOf(r)}{r.technology ? ` · ${r.technology}` : ""}</dd>
              <dt>Client</dt><dd>{r.client.name}{r.implementationPartner ? ` (via ${r.implementationPartner.name})` : ""}</dd>
              <dt>Vendor</dt><dd>{who(r.vendor)}</dd>
              {money && <><dt>Rate</dt><dd>{r.rate === null || r.rate === undefined ? "—" : `${fmtMoney(r.rate)}/h`}</dd></>}
              <dt>Joined</dt><dd>{fmtDate(r.placement.joinedOn)}</dd>
              <dt>Timesheet to Accounts</dt><dd>{fmtDate(r.timesheetSubmittedOn)}</dd>
              <dt>Billing period</dt><dd>{r.periodStart || r.periodEnd ? `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}` : "—"}</dd>
              <dt>Invoice</dt><dd>{r.invoiceNo ?? "No number"} · {fmtDate(r.invoiceDate)}</dd>
              <dt>Payment terms</dt><dd>Net {r.termsDays}</dd>
              <dt>Expected payment</dt><dd>{fmtDate(r.expectedDate)}</dd>
              <dt>Delay</dt><dd>{r.delayDays === null ? "—" : `${r.delayDays} ${r.delayDays === 1 ? "day" : "days"}`}</dd>
              <dt>Hours billed</dt><dd>{r.hours ?? "—"}</dd>
              {money && <>
                <dt>Invoice amount</dt><dd>{fmtMoney(r.amount)}</dd>
                <dt>Incentive part</dt><dd>{fmtMoney(r.incentiveAmount)}</dd>
                <dt>Received</dt><dd>{fmtMoney(r.paidAmount)}{r.receivedOn ? ` on ${fmtDate(r.receivedOn)}` : ""}</dd>
              </>}
              {!money && <><dt>Received</dt><dd>{r.receivedOn ? fmtDate(r.receivedOn) : r.paymentCount ? "Partly" : "Not yet"}</dd></>}
              <dt>Recruiter</dt><dd>{who(r.recruiter)}</dd>
              <dt>Team lead</dt><dd>{who(r.lead)}{r.team?.name ? ` · ${r.team.name}` : ""}</dd>
              <dt>Manager</dt><dd>{who(r.manager)}</dd>
              <dt>Associate director</dt><dd>{who(r.associateDirector)}</dd>
            </dl>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>

            {(r.actions.edit || r.actions.recordPayment || r.actions.void) && (
              <section className="manageblock" aria-labelledby={`${hid}-act`}>
                <h3 id={`${hid}-act`}>Actions</h3>
                <div className="rowactions" role="group" aria-labelledby={`${hid}-act`}>
                  {r.actions.recordPayment && <button type="button" className="btn sm primary" onClick={() => setAction("pay")}>Record payment…</button>}
                  {r.actions.edit && <button type="button" className="btn sm" onClick={() => setAction("edit")}>Edit invoice…</button>}
                  {r.actions.void && <button type="button" className="btn sm danger" onClick={() => setAction("void")}>Void invoice…</button>}
                </div>
              </section>
            )}

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
          <fieldset className="field spanall">
            <legend>Placement</legend>
            <label className="field">Search joined placements
              <input type="search" value={pSearch} maxLength={80} onChange={(e) => setPSearch(e.target.value)} data-autofocus />
            </label>
            {picker.isLoading ? <p className="muted">Loading placements…</p> : choices.length === 0 ? (
              <p className="muted">No joined placement matches.</p>
            ) : (
              <label className="field">Placement
                <select value={placement?.id ?? ""} aria-invalid={errs.placement ? true : undefined}
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
            {errs.placement && <small className="error fielderr">{errs.placement}</small>}
          </fieldset>
        )}
        <div className="formgrid cols2 paygrid">
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
                {(p) => <input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
              <Field label="Incentive part (USD)" error={errs.incentive}>
                {(p) => <input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={incentive} onChange={(e) => setIncentive(e.target.value)} />}
              </Field>
            </>
          )}
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
          {(p) => <input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Record payment" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
