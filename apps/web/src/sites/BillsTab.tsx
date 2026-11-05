import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarDays, Download, FileUp, Plus } from "lucide-react";
import { Dialog, useSubmit } from "../ui/Dialog";
import { DOCUMENT_CONTENT_TYPES } from "@eureka/shared";
import { documentFileProblem, documentTypeOf } from "../documents/documentsApi";
import { browser, postToStorage } from "../sales/resumesApi";
import { Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import {
  MONEY_RE, PAYMENT_LABELS, PAYMENT_METHODS, billsExportUrl, fmtMoney, localDay, paymentLabel, siteKeys, sitesApi, sitesError, toMoney, utilityLabel,
  type Bill, type PaymentMethod, type SiteKind,
} from "./sitesApi";
import { BillStatusPill, IconInput, Layer } from "./ui";
import { Pager, useCursorPager } from "../ui/Pager";
import { DueDate, fmtDay } from "../payments/cells";
import "./sites.css";

const BILLS_PAGE = 25;
const INVOICE_POLL_MS = 4000;

/** The invoice file's scan state as a plain chip: Scanning, Ready, or Rejected (never downloadable). */
function InvoiceScan({ status }: { status: string | undefined }) {
  if (!status) return null;
  const [cls, text] = status === "clean" ? ["inv-clean", "Ready"] : status === "pending" ? ["inv-pending", "Scanning"] : ["inv-rejected", "Rejected"];
  return <span className={`badge ${cls}`}>{text}</span>;
}

const ACCEPT = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ...Object.keys(DOCUMENT_CONTENT_TYPES)].join(",");

const billName = (b: Bill) => `${utilityLabel(b.utility.utilityType)} bill due ${fmtDate(b.dueDate)}`;

/**
 * Bills of a company or facility: search, add, void (with a reason), and the invoice
 * file (uploaded straight to storage and scanned, like paperwork documents).
 */
export function BillsTab({ kind, ownerId, canManage }: { kind: SiteKind; ownerId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Bill | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<Bill | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const pager = useCursorPager();
  useEffect(() => { pager.reset(); }, [search]);
  const q = useQuery({
    queryKey: [...siteKeys.bills(kind, ownerId, search), pager.cursor ?? ""],
    queryFn: () => sitesApi.bills(kind, ownerId, { q: search, limit: BILLS_PAGE, cursor: pager.cursor ?? undefined }),
    placeholderData: keepPreviousData,
    // While an uploaded invoice is being scanned, look again until it is ready or rejected.
    refetchInterval: (query) => (query.state.data?.items.some((b) => b.invoice?.status === "pending") ? INVOICE_POLL_MS : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [kind, "detail", ownerId, "bills"] });
    void qc.invalidateQueries({ queryKey: [kind, "bills-summary"] });
  };

  const pickInvoice = (b: Bill) => {
    uploadFor.current = b;
    setError(""); setMessage("");
    if (fileInput.current) { fileInput.current.value = ""; fileInput.current.click(); }
  };

  const upload = async (file: File | undefined) => {
    const b = uploadFor.current;
    if (!b || !file) return;
    const problem = documentFileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(b.id);
    try {
      const r = await sitesApi.startInvoice(b.id, { fileName: file.name, contentType: documentTypeOf(file)!, size: file.size });
      setProgress(`Uploading the invoice for the ${billName(b)}…`);
      await postToStorage(r.upload, file);
      setProgress("");
      setMessage(`Invoice uploaded for the ${billName(b)}. It can be downloaded once the malware scan passes.`);
      refresh();
    } catch (err) {
      setProgress("");
      setMessage("");
      setError(sitesError(err, "bill"));
    } finally {
      setBusy(null);
      uploadFor.current = null;
    }
  };

  const download = async (b: Bill) => {
    setError(""); setMessage(""); setBusy(b.id);
    try {
      const { url } = await sitesApi.invoiceLink(b.id);
      browser.download(url);
      setMessage(`Opening the invoice of the ${billName(b)}.`);
    } catch (err) {
      setError(err && (err as { status?: number }).status === 409 ? "The invoice is still being scanned, or did not pass the scan." : sitesError(err, "bill"));
    } finally {
      setBusy(null);
    }
  };

  const items = q.data?.items ?? [];
  return (
    <div className="tabpanel">
      <div className="panelhead si-billshead">
        <h3>Bills</h3>
        <div className="field inline si-billsearch">
          <label htmlFor={`${id}-q`} className="sr-only">Search bills</label>
          <input id={`${id}-q`} type="search" placeholder="Search bills" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} />
        </div>
        <a className="btn sm" href={billsExportUrl(kind, ownerId, search)} download><Download size={15} aria-hidden="true" />{search ? "Export matches" : "Export"}<span className="sr-only"> bills as CSV</span></a>
        {canManage && <button type="button" className="btn primary sm" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />Add bill</button>}
      </div>
      {/* Progress is information, not success: a neutral banner while the file goes up. */}
      <p aria-live="polite" aria-atomic="true" className="livemsg info">{progress}</p>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{progress ? "" : message}</p>
      {error && <p className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}
      <input ref={fileInput} type="file" accept={ACCEPT} hidden aria-hidden="true" tabIndex={-1} data-testid="invoice-file"
        onChange={(e) => void upload(e.target.files?.[0])} />
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{sitesError(q.error, "bill")}</p>
        : items.length === 0 ? <p className="muted">{search ? "No bills match this search." : "No bills yet."}</p>
        : (
          <div className="tablewrap roundtable listcard"><table className="dtable bo-dtable si-bills" aria-label="Bills" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th scope="col">Utility</th><th scope="col">Status</th><th scope="col" className="num">Amount</th>
              <th scope="col">Period</th><th scope="col">Due</th><th scope="col">Payment</th>
              <th scope="col">Invoice</th><th scope="col" className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((b) => {
                const name = billName(b);
                const scan = b.invoice?.status;
                const ready = b.invoice !== null && (!scan || scan === "clean");
                return (
                  <tr key={b.id}>
                    <td className="c-primary"><b>{utilityLabel(b.utility.utilityType)}</b><span className="block">{b.utility.serviceProvider}</span></td>
                    <td className="c-badge" data-label="Status"><BillStatusPill status={b.status} /></td>
                    <td className="num" data-label="Amount">{fmtMoney(b.amount)}</td>
                    <td data-label="Period"><span className="si-period">{fmtDay(b.billingStart)} – {fmtDay(b.billingEnd)}</span></td>
                    <td data-label="Due"><DueDate on={b.dueDate} done={b.status === "paid"} />{b.paidOn && <span className="block">Paid {fmtDay(b.paidOn)}</span>}</td>
                    <td data-label="Payment">{paymentLabel(b.paymentMethod)}</td>
                    <td data-label="Invoice">
                      {busy === b.id && uploadFor.current?.id === b.id ? <span className="badge inv-pending">Uploading…</span>
                        : b.invoice ? <><InvoiceScan status={scan} /><span className="block filename" title={b.invoice.fileName}>{b.invoice.fileName}</span></>
                        : <span className="muted">None</span>}
                    </td>
                    <td className="c-act">
                      {canManage && (
                        <button type="button" className="iconbtn sm" disabled={busy !== null} aria-busy={busy === b.id || undefined}
                          onClick={() => pickInvoice(b)} aria-label={`Upload invoice for ${name}`} title="Upload invoice"><FileUp size={15} aria-hidden="true" /></button>
                      )}
                      {ready && (
                        <button type="button" className="iconbtn sm" disabled={busy !== null}
                          onClick={() => void download(b)} aria-label={`Download invoice for ${name}`} title="Download invoice"><Download size={15} aria-hidden="true" /></button>
                      )}
                      {canManage && (
                        <button type="button" className="iconbtn sm danger" onClick={() => setVoiding(b)} aria-label={`Void ${name}`} title="Void bill"><Ban size={15} aria-hidden="true" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      {(pager.page > 0 || q.data?.nextCursor) && (
        <div className="listfoot">
          <p className="muted">{items.length} {items.length === 1 ? "bill" : "bills"} on page {pager.page + 1}, newest first.</p>
          <Pager pager={pager} label="Bill pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
        </div>
      )}

      {adding && (
        <Layer>
          <BillDialog kind={kind} ownerId={ownerId} onClose={() => setAdding(false)}
            onSaved={(m) => { setAdding(false); setMessage(m); refresh(); }} />
        </Layer>
      )}
      {voiding && (
        <Layer>
          <VoidDialog bill={voiding} onClose={() => setVoiding(null)}
            onDone={(m) => {
              // Drop the voided bill from every cached search of this owner at once, so a refetch
              // racing the debounced search cannot show it again; then refetch for the totals.
              const gone = voiding.id;
              qc.setQueriesData<{ items: Bill[] }>({ queryKey: [kind, "detail", ownerId, "bills"] },
                (d) => (d ? { ...d, items: d.items.filter((b) => b.id !== gone) } : d));
              setVoiding(null); setMessage(m); refresh();
            }} />
        </Layer>
      )}
    </div>
  );
}

type Values = { utilityId: string; paymentMethod: PaymentMethod | ""; amount: string; billingStart: string; billingEnd: string; dueDate: string; paidOn: string };
type Errors = Partial<Record<keyof Values, string>>;
const EMPTY: Values = { utilityId: "", paymentMethod: "", amount: "", billingStart: "", billingEnd: "", dueDate: "", paidOn: "" };

export function validateBill(v: Values): Errors {
  const e: Errors = {};
  if (!v.utilityId) e.utilityId = "Choose the utility.";
  if (!v.paymentMethod) e.paymentMethod = "Choose the payment method.";
  if (!MONEY_RE.test(v.amount.trim()) || Number(v.amount) <= 0) e.amount = "Enter an amount above 0, with up to 2 decimals.";
  if (!v.billingStart) e.billingStart = "Enter the billing start date.";
  if (!v.billingEnd) e.billingEnd = "Enter the billing end date.";
  else if (v.billingStart && v.billingEnd < v.billingStart) e.billingEnd = "The billing end can't be before the start.";
  if (!v.dueDate) e.dueDate = "Enter the due date.";
  if (v.paidOn && v.paidOn > localDay()) e.paidOn = "The paid date can't be in the future.";
  return e;
}

function BillDialog({ kind, ownerId, onClose, onSaved }: { kind: SiteKind; ownerId: string; onClose: () => void; onSaved: (m: string) => void }) {
  const utilities = useQuery({ queryKey: siteKeys.utilities(kind, ownerId), queryFn: () => sitesApi.utilities(kind, ownerId) });
  const [v, setV] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, setError, run } = useSubmit((e) => sitesError(e, "bill"));
  const set = <K extends keyof Values>(key: K) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };
  const options = (utilities.data?.items ?? []).filter((u) => u.status === "active");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateBill(v);
    setErrors(errs);
    if (Object.keys(errs).length) { setError(""); failed(); return; }
    void run(async () => {
      try {
        await sitesApi.createBill(kind, ownerId, {
          utilityId: v.utilityId, paymentMethod: v.paymentMethod as PaymentMethod, amount: toMoney(v.amount.trim()),
          billingStart: v.billingStart, billingEnd: v.billingEnd, dueDate: v.dueDate, ...(v.paidOn ? { paidOn: v.paidOn } : {}),
        });
        onSaved("Bill added.");
      } catch (err) {
        failed();
        throw err;
      }
    });
  };

  const date = (key: keyof Values, label: string, hint?: string) => (
    <Field label={label} error={errors[key]} hint={hint}>
      {(p) => <IconInput icon={CalendarDays}><input {...p} type="date" value={v[key]} onChange={set(key)} /></IconInput>}
    </Field>
  );

  return (
    <Dialog title="Add bill" onClose={onClose} className="wide">
      <form ref={formRef} onSubmit={submit} noValidate>
        <div className="formgrid cols2">
          <Field label="Utility" error={errors.utilityId} hint={!utilities.isLoading && options.length === 0 ? "Add a utility first." : undefined}>
            {(p) => (
              <select {...p} value={v.utilityId} onChange={set("utilityId")} disabled={utilities.isLoading} data-autofocus>
                <option value="">{utilities.isLoading ? "Loading…" : "Choose…"}</option>
                {options.map((u) => <option key={u.id} value={u.id}>{utilityLabel(u.utilityType)} · {u.serviceProvider}</option>)}
              </select>
            )}
          </Field>
          <Field label="Payment method" error={errors.paymentMethod}>
            {(p) => (
              <select {...p} value={v.paymentMethod} onChange={set("paymentMethod")}>
                <option value="">Choose…</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Amount" error={errors.amount}>
            {(p) => <IconInput prefix="$"><input {...p} value={v.amount} onChange={set("amount")} inputMode="decimal" placeholder="0.00" /></IconInput>}
          </Field>
          {date("dueDate", "Due date")}
          {date("billingStart", "Billing start")}
          {date("billingEnd", "Billing end")}
          {date("paidOn", "Paid on", "Optional. Leave empty while the bill is unpaid.")}
        </div>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => { setV(EMPTY); setErrors({}); setError(""); }}>Reset</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>{busy ? "Working…" : "Add bill"}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Voiding is the UI's "delete": the bill leaves lists and totals; the reason is kept. */
function VoidDialog({ bill, onClose, onDone }: { bill: Bill; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState("");
  const bodyId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, run } = useSubmit((e) => sitesError(e, "bill"));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = reason.trim();
    if (!r || r.length > 500) { setFieldError(r ? "Use at most 500 characters." : "Give a reason for voiding this bill."); failed(); return; }
    setFieldError("");
    void run(async () => {
      try { await sitesApi.voidBill(bill.id, r); onDone(`The ${billName(bill)} was voided.`); }
      catch (err) { failed(); throw err; }
    });
  };
  return (
    <Dialog title="Void bill" onClose={onClose} describedBy={bodyId}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <div id={bodyId} className="dialogbody">
          <p>Void the {billName(bill)} for {fmtMoney(bill.amount)}? It leaves the bill list and the totals. This can't be undone.</p>
        </div>
        <Field label="Reason" error={fieldError}>
          {(p) => <textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setFieldError(""); }} data-autofocus />}
        </Field>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn danger" disabled={busy} aria-busy={busy || undefined}>{busy ? "Working…" : "Void bill"}</button>
        </div>
      </form>
    </Dialog>
  );
}
