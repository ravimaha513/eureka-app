import { useEffect, useId, useRef, useState } from "react";
import { Download, Mail, Phone } from "lucide-react";
import { Person } from "../shell/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveBlob } from "../lib/download";
import { can, type Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { useLookups } from "../lookups";
import { Drawer, Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import {
  EMPLOYEE_STATUSES, END_REASONS, EXIT_REASONS, employeeKeys, employeesApi, employmentError, employmentLabel, localToday,
  type Employee, type EmployeeDetail, type EmploymentChanges, type HistoryEntry,
} from "./employeesApi";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { RecordLink } from "../ui/RecordLink";
import { useRoutedId, useSearchParams } from "../lib/router";
import { DueDate, ToggleGroup, fmtDay, fmtUsd, fromControl } from "../payments/cells";
import "./employeesPage.css";

const PAGE_SIZE = 50;
const SOON_DAYS = 30;

export const EmployeeStatus = ({ status }: { status: string }) => <span className={`badge emp-${status}`}>{employmentLabel(status)}</span>;

const nameOf = (e: Pick<Employee, "candidate">) => e.candidate.name ?? "Name hidden";

/** Employees (FR-EMP): list with filters and a drawer with assignment history and lifecycle actions. */
/** Email and phone with icons; masked values are not links (EM-C1). */
function Contact({ e }: { e: Employee }) {
  const c = e.contact;
  if (!c || (!c.email && !c.phone)) return <span className="muted">—</span>;
  const masked = c.masked;
  return (
    <span className="contactcell">
      {c.email && (masked ? <span className="contactlink" title="Hidden: outside your contact permission"><Mail size={14} aria-hidden="true" />{c.email}</span>
        : <a className="contactlink" href={`mailto:${c.email}`}><Mail size={14} aria-hidden="true" />{c.email}</a>)}
      {c.phone && (masked ? <span className="contactlink" title="Hidden: outside your contact permission"><Phone size={14} aria-hidden="true" />{c.phone}</span>
        : <a className="contactlink" href={`tel:${c.phone}`}><Phone size={14} aria-hidden="true" />{c.phone}</a>)}
      {masked && <span className="sr-only">Contact details hidden</span>}
    </span>
  );
}

const FILTER_KEYS = ["status", "loc", "client", "current", "vendor", "payroll", "soon", "q"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function EmployeesPage({ me, initialOpenId = null, onOpenChange }: {
  me?: Pick<Me, "capabilities">;
  /** The open employee from the URL (/employees/<id>), when the app routes it. */
  initialOpenId?: string | null;
  onOpenChange?: (id: string | null) => void;
}) {
  const id = useId();
  const lookups = useLookups();
  const [p, setP] = useSearchParams(FILTER_KEYS);
  const status = (EMPLOYEE_STATUSES as readonly string[]).includes(p.status) ? p.status : "";
  const soon = p.soon === "1";
  const currentOnly = p.current === "1";
  const [searchText, setSearchText] = useState(p.q);
  const search = p.q;
  const pager = useCursorPager();
  const { page, reset } = pager;
  const set = (patch: Partial<Record<FilterKey, string>>) => { setP(patch); reset(); };
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const [notice, setNotice] = useState("");

  // Name search applies after a short pause (one request per typed word, not per key).
  useEffect(() => {
    const t = setTimeout(() => { if (searchText.trim() !== search) set({ q: searchText.trim() }); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // 0150: the client, vendor and payroll company filters match any assignment (employment history), unless "current only".
  const clientMatch = p.client && currentOnly ? ("current" as const) : undefined;
  const exportFilters = {
    status, locationId: p.loc, clientId: p.client, clientMatch, vendorId: p.vendor, payrollCompanyId: p.payroll,
    endingWithinDays: soon ? SOON_DAYS : undefined, search,
  };
  const filters = { ...exportFilters, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const companies = useQuery({ queryKey: employeeKeys.payrollCompanies, queryFn: employeesApi.payrollCompanies, staleTime: 10 * 60_000 });
  const q = useQuery({
    queryKey: [...employeeKeys.all, "list", filters],
    queryFn: () => employeesApi.list(filters),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const hasFilters = Boolean(status || p.loc || p.client || p.vendor || p.payroll || soon || search);
  const n = items.length;
  const countMsg = q.isLoading || q.error ? ""
    : `${n} ${n === 1 ? "employee" : "employees"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;
  const locations = lookups.data?.locations ?? [];
  const clients = lookups.data?.clients ?? [];
  const vendors = lookups.data?.vendors ?? [];
  const companyList = companies.data?.items ?? [];
  const canExport = can(me, "report:export");
  const exportRun = useMutation({
    mutationFn: () => employeesApi.exportEmployees(exportFilters),
    onSuccess: (r) => {
      saveBlob(r.blob, r.filename);
      setNotice(`Exported ${r.rows} ${r.rows === 1 ? "employee" : "employees"}${r.truncated ? " (capped: narrow the filters for the rest)" : ""}.`);
    },
  });
  const nameIn = (list: { id: string; name: string }[], v: string) => list.find((x) => x.id === v)?.name ?? v;
  const chips: FilterChip[] = [];
  if (p.client) chips.push({ key: "client", label: `Client: ${nameIn(clients, p.client)}${currentOnly ? " (current)" : ""}`, onRemove: () => set({ client: "", current: "" }) });
  if (p.vendor) chips.push({ key: "vendor", label: `Vendor: ${nameIn(vendors, p.vendor)}`, onRemove: () => set({ vendor: "" }) });
  if (p.payroll) chips.push({ key: "payroll", label: `Payroll: ${nameIn(companyList, p.payroll)}`, onRemove: () => set({ payroll: "" }) });
  const sel = (key: FilterKey, label: string, any: string, list: { id: string; name: string }[]) => (
    <div className="field inline">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <select id={`${id}-${key}`} value={p[key]} onChange={(e) => set(key === "client" ? { client: e.target.value, current: "" } : { [key]: e.target.value })}>
        <option value="">{any}</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Employees</h1>
          <p className="sub">People placed through Eureka: on assignment, on the bench, or exited. Open an employee for their assignments and history.</p>
        </div>
        {canExport && (
          <div className="pageactions">
            <button type="button" className="btn" disabled={exportRun.isPending} aria-busy={exportRun.isPending || undefined}
              onClick={() => exportRun.mutate()}><Download size={15} aria-hidden="true" /><span className="btnlabel">{exportRun.isPending ? "Exporting…" : "Export CSV"}</span></button>
          </div>
        )}
      </div>

      <FilterBar label="Employee filters" chips={chips} moreCount={chips.length}
        activeCount={chips.length + (status ? 1 : 0) + (soon ? 1 : 0) + (p.loc ? 1 : 0)}
        hasFilters={hasFilters} onClear={() => { setSearchText(""); set({ status: "", loc: "", client: "", current: "", vendor: "", payroll: "", soon: "", q: "" }); }}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Name</label>
            <input id={`${id}-q`} type="search" placeholder="Employee name" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
        }
        primary={
          <>
            <ToggleGroup label="Status" options={[["", "All"], ...EMPLOYEE_STATUSES.map((s) => [s, employmentLabel(s)] as const)]}
              value={status} onChange={(v) => set({ status: v === status ? "" : v })} />
            <label className="check em-soon"><input type="checkbox" checked={soon} onChange={(e) => set({ soon: e.target.checked ? "1" : "" })} />
              {" "}Ending within {SOON_DAYS} days</label>
            {sel("loc", "Location", "All locations", locations)}
          </>
        }
        more={
          <>
            {clients.length > 0 && sel("client", "Client", "All clients", clients)}
            {p.client && (
              <label className="check">
                <input type="checkbox" checked={currentOnly} onChange={(e) => set({ current: e.target.checked ? "1" : "" })} />
                {" "}Current assignment only
              </label>
            )}
            {vendors.length > 0 && sel("vendor", "Vendor", "All vendors", vendors)}
            {companyList.length > 0 && sel("payroll", "Payroll company", "All companies", companyList)}
          </>
        }
        summaryEnd={!q.isLoading && !q.error ? <span className="muted em-count">{n}{q.data?.nextCursor ? "+" : ""} {n === 1 ? "employee" : "employees"}</span> : null} />
      {exportRun.error && <p className="error" role="alert">{employmentError(exportRun.error)}</p>}

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={employmentError(q.error)} />
        ) : (
          <table className="dtable bo-dtable emtable" aria-label="Employees" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Employee</th><th>Status</th><th>Client · assignment</th><th>Dates</th><th>Lead / recruiter</th>
              <th className="p2">Location / team</th><th className="em-contact">Contact</th>
              <th className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((e) => {
                const a = e.assignment;
                const open = a !== null && a.endDate === null;
                return (
                  <tr key={e.id} className="rowopen" onClick={(ev) => { if (!fromControl(ev)) setOpenId(e.id); }}>
                    <td className="c-primary"><Person name={nameOf(e)}>
                      <RecordLink kind="employee" id={e.id} onOpen={setOpenId}><b>{nameOf(e)}</b></RecordLink>
                      <span className="block muted">Since {fmtDate(e.employeeSince)}</span></Person></td>
                    <td className="c-badge" data-label="Status"><EmployeeStatus status={e.status} /><span className="block muted em-since">{fmtDate(e.statusSince)}</span></td>
                    <td data-label="Client">{open && a.client ? a.client.name : <span className="muted">—</span>}
                      {a && <span className="block muted">No. {a.assignmentNo}</span>}</td>
                    <td data-label="Dates">{a ? <>
                      <span className="em-range">{fmtDay(a.startDate)} → {a.endDate ? fmtDay(a.endDate) : "ongoing"}</span>
                      {open && a.plannedEndDate && <span className="block">Planned end <DueDate on={a.plannedEndDate} soonDays={SOON_DAYS} lateWord="past" /></span>}
                    </> : <span className="muted">—</span>}</td>
                    <td data-label="Lead">{e.lead?.name ?? <span className="muted">—</span>}
                      <span className="block muted">{e.recruiter?.name ? `Recruiter: ${e.recruiter.name}` : "No recruiter"}</span></td>
                    <td className="p2" data-label="Location">{e.location?.name ?? "—"}<span className="block muted">{e.team?.name ?? ""}</span></td>
                    <td className="em-contact" data-label="Contact"><Contact e={e} /></td>
                    <td className="c-act">
                      <button type="button" className="btn sm" onClick={() => setOpenId(e.id)} aria-label={`Open employee ${nameOf(e)}`}>Open</button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={8} className="empty">{hasFilters ? "No employees match these filters." : "No employees yet. A person becomes an employee when their placement is marked Joined."}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Employee pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>

      {openId && <EmployeeDrawer id={openId} initial={items.find((e) => e.id === openId) ?? null} onClose={() => setOpenId(null)} onNotice={setNotice} />}
    </>
  );
}

type Action = "end" | "planned" | "exit" | "market" | "team";

function historyText(h: HistoryEntry): string {
  switch (h.kind) {
    case "started": return h.fromStatus === "exited" ? "Rejoined on a new assignment" : "Assignment started";
    case "end_date_set": return h.previousOn ? `Planned end moved from ${fmtDate(h.previousOn)} to ${fmtDate(h.effectiveOn)}` : `Planned end set to ${fmtDate(h.effectiveOn)}`;
    case "ended": return `Assignment ended${h.reason ? ` (${employmentLabel(h.reason)})` : ""}`;
    case "exited": return `Left the company${h.reason ? ` (${employmentLabel(h.reason)})` : ""}`;
    case "returned_to_market": return "Returned to marketing for a new placement";
    default: return employmentLabel(h.kind);
  }
}

function EmployeeDrawer({ id, initial, onClose, onNotice }: {
  id: string; initial: Employee | null; onClose: () => void; onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const hid = useId();
  const q = useQuery({ queryKey: employeeKeys.detail(id), queryFn: () => employeesApi.get(id), placeholderData: initial ? { ...initial, assignments: [], history: [] } as EmployeeDetail : undefined });
  const [action, setAction] = useState<Action | null>(null);
  const [editing, setEditing] = useState<EmployeeDetail["assignments"][number] | null>(null);
  const [message, setMessage] = useState("");
  const e = q.data;
  const full = Boolean(e && !q.isPlaceholderData);
  const a = e?.assignment ?? null;
  const open = a !== null && a.endDate === null;
  const done = (m: string) => {
    setAction(null); setEditing(null); setMessage(m); onNotice(m);
    void qc.invalidateQueries({ queryKey: employeeKeys.all });
  };
  const acts = e?.actions;
  const any = acts && (acts.endAssignment || acts.setEndDate || acts.exit || acts.returnToMarket || acts.assignTeam);
  const showRate = Boolean(e?.assignments.some((x) => "payRate" in x));

  return (
    <>
      <Drawer title={e ? nameOf(e) : "Employee"} onClose={onClose} suspended={action !== null || editing !== null} wide closeLabel="Close employee details">
        {q.isLoading && !e ? <Loading /> : !e ? (
          <p className="error" role="alert">{employmentError(q.error)}</p>
        ) : (
          <>
            {/* Action strip: status and the next step first, then the facts. Destructive steps sit last, in danger style. */}
            <div className="actionstrip em-strip">
              <div className="as-status">
                <EmployeeStatus status={e.status} />
                <span className="as-note">
                  {open && a.client ? <>{a.client.name} · No. {a.assignmentNo}{a.plannedEndDate ? <> · ends <DueDate on={a.plannedEndDate} soonDays={SOON_DAYS} lateWord="past" /></> : " · no planned end"}</>
                    : e.exitedOn ? `Exited ${fmtDay(e.exitedOn)}` : `Since ${fmtDay(e.statusSince)}`}
                </span>
              </div>
              {any && (
                <div className="as-actions" role="group" aria-label="Actions">
                  {acts.setEndDate && <button type="button" className="btn primary" onClick={() => setAction("planned")}>{a?.plannedEndDate ? "Extend or change end date…" : "Set planned end date…"}</button>}
                  {acts.returnToMarket && <button type="button" className={`btn${acts.setEndDate ? "" : " primary"}`} onClick={() => setAction("market")}>Return to marketing…</button>}
                  {acts.assignTeam && <button type="button" className="btn" onClick={() => setAction("team")}>Assign a team…</button>}
                  {acts.endAssignment && <button type="button" className="btn danger" onClick={() => setAction("end")}>End assignment…</button>}
                  {acts.exit && <button type="button" className="btn danger" onClick={() => setAction("exit")}>Record exit…</button>}
                </div>
              )}
            </div>
            {any && e.status === "bench" && !acts.returnToMarket && acts.exit && (
              <small className="hint">Returning to marketing isn't offered after a failed background check, or once Sales has moved the candidate.</small>
            )}

            <p role="status" aria-live="polite" className="livemsg">{message}</p>

            <dl className="bo-facts">
              <div><dt>Employee since</dt><dd>{fmtDay(e.employeeSince)}</dd></div>
              <div><dt>Status since</dt><dd>{fmtDay(e.statusSince)}</dd></div>
              {e.exitedOn && <div><dt>Exited</dt><dd>{fmtDay(e.exitedOn)}{e.exitReason && ` · ${employmentLabel(e.exitReason)}`}</dd></div>}
              {a && <div><dt>Current client</dt><dd>{open && a.client ? a.client.name : "None"}</dd></div>}
              {open && <div><dt>Planned end</dt><dd>{a.plannedEndDate ? fmtDay(a.plannedEndDate) : "Not set"}</dd></div>}
              <div><dt>Location</dt><dd>{e.location?.name ?? "—"}</dd></div>
              <div><dt>Team</dt><dd>{e.team?.name ?? "—"}</dd></div>
              <div><dt>Lead</dt><dd>{e.lead?.name ?? "—"}</dd></div>
              <div><dt>Recruiter</dt><dd>{e.recruiter?.name ?? "—"}</dd></div>
            </dl>

            <section className="manageblock" aria-labelledby={`${hid}-as`}>
              <h3 id={`${hid}-as`}>Assignments</h3>
              {!full ? <p className="muted">Loading assignments…</p> : e.assignments.length === 0 ? (
                <p className="muted">No assignment you can see.</p>
              ) : (
                // Seven columns that fit the drawer: employment fields stack in one cell instead of five clipped ones.
                <div className="tablewrap"><table className="mini dtable bo-dtable em-assign" aria-labelledby={`${hid}-as`}>
                  <thead><tr>
                    <th>Client · vendor</th><th>Dates</th><th>Employment</th>{showRate && <th className="num">Pay rate</th>}
                    {acts?.editEmployment && <th className="c-act"><span className="sr-only">Edit</span></th>}
                  </tr></thead>
                  <tbody>
                    {e.assignments.map((x) => (
                      <tr key={x.id}>
                        <td className="c-primary"><b>No. {x.assignmentNo} · {x.client.name}</b>
                          {x.isFirstPlacement && <>{" "}<span className="badge first">First placement</span></>}
                          <span className="block">{x.vendor?.name ?? "No vendor"}</span></td>
                        <td data-label="Dates">
                          <span className="em-range">{fmtDay(x.startDate)} → {x.endDate ? fmtDay(x.endDate) : <span>Ongoing</span>}</span>
                          {x.plannedEndDate && !x.endDate && <span className="block">Planned end {fmtDay(x.plannedEndDate)}</span>}
                          {x.endReason && <span className="block">{employmentLabel(x.endReason)}</span>}
                        </td>
                        <td data-label="Employment">
                          <span className="em-emp">{x.payrollCompany?.name ?? <span className="muted">No payroll company</span>}</span>
                          <span className="block">E-Verify {x.everifyDate ? fmtDay(x.everifyDate) : "—"}</span>
                          <span className="block">Onboarded {x.onboardedDate ? fmtDay(x.onboardedDate) : "—"}</span>
                        </td>
                        {showRate && <td className="num" data-label="Pay rate">{"payRate" in x ? (typeof x.payRate === "number" ? `${fmtUsd(x.payRate)}/h` : "—") : <span className="muted">Hidden</span>}</td>}
                        {acts?.editEmployment && (
                          <td className="c-act">
                            <button type="button" className="btn sm" onClick={() => setEditing(x)} aria-label={`Edit employment details of assignment ${x.assignmentNo}`}>Edit</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>

            <section className="manageblock" aria-labelledby={`${hid}-h`}>
              <h3 id={`${hid}-h`}>History</h3>
              {!full ? <p className="muted">Loading history…</p> : e.history.length === 0 ? <p className="muted">No history yet.</p> : (
                <ol className="timeline" aria-labelledby={`${hid}-h`}>
                  {e.history.map((h) => (
                    <li key={h.id}>
                      <b>{historyText(h)}</b>
                      <span className="block muted">
                        {h.effectiveOn && h.kind !== "end_date_set" ? `${fmtDate(h.effectiveOn)} · ` : ""}recorded {fmtDate(h.at)}{h.actor ? ` by ${h.actor}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </Drawer>

      {e && a && action === "end" && <EndDialog name={nameOf(e)} assignmentId={a.id} onClose={() => setAction(null)} onDone={() => done("Assignment ended. The employee is on the bench.")} />}
      {e && a && action === "planned" && <PlannedEndDialog name={nameOf(e)} assignmentId={a.id} current={a.plannedEndDate} onClose={() => setAction(null)} onDone={(d) => done(`Planned end date set to ${fmtDate(d)}.`)} />}
      {e && action === "exit" && <ExitDialog name={nameOf(e)} personId={e.id} onClose={() => setAction(null)} onDone={() => done("Exit recorded.")} />}
      {e && action === "team" && <TeamDialog name={nameOf(e)} personId={e.id} current={e.team?.id ?? null} onClose={() => setAction(null)}
        onDone={(t) => done(`Assigned to ${t ?? "the team"}. The team's lead and manager are notified; the lead assigns a recruiter.`)} />}
      {e && editing && <EmploymentDialog name={nameOf(e)} assignment={editing} onClose={() => setEditing(null)}
        onDone={() => done(`Employment details of assignment ${editing.assignmentNo} saved.`)} />}
      {e && action === "market" && <MarketDialog name={nameOf(e)} personId={e.id} onClose={() => setAction(null)} onDone={() => done("Returned to marketing. Sales can now place them again.")} />}
    </>
  );
}

function DateAndReason({ dateLabel, date, setDate, reasons, reason, setReason, dateError, max, min }: {
  dateLabel: string; date: string; setDate: (v: string) => void; reasons?: readonly string[]; reason?: string; setReason?: (v: string) => void;
  dateError: string; max?: string; min?: string;
}) {
  return (
    <>
      <Field label={dateLabel} error={dateError}>
        {(p) => <input {...p} type="date" value={date} max={max} min={min} onChange={(e) => setDate(e.target.value)} data-autofocus />}
      </Field>
      {reasons && setReason && (
        <label className="field">Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r} value={r}>{employmentLabel(r)}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

function EndDialog({ name, assignmentId, onClose, onDone }: { name: string; assignmentId: string; onClose: () => void; onDone: () => void }) {
  const today = localToday();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<string>(END_REASONS[0]);
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(employmentError);
  return (
    <Dialog title={`End the assignment of ${name}?`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (!date) { setErr("Choose the last day of the assignment."); failed(); return; }
        if (date > today) { setErr("The end date can't be in the future. Set a planned end date instead."); failed(); return; }
        setErr("");
        void submit.run(async () => { await employeesApi.endAssignment(assignmentId, date, reason); onDone(); }).then(() => failed());
      }}>
        <p className="dialogbody">Records the project exit. The employee moves to the bench and the candidate returns to the Hot List as Bench; HR, Accounts, Immigration, the BU Head and the CEO are notified.</p>
        <DateAndReason dateLabel="Last day" date={date} setDate={setDate} reasons={END_REASONS} reason={reason} setReason={setReason} dateError={err} max={today} />
        <DialogActions onCancel={onClose} submitLabel="End assignment" danger busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

function PlannedEndDialog({ name, assignmentId, current, onClose, onDone }: {
  name: string; assignmentId: string; current: string | null; onClose: () => void; onDone: (d: string) => void;
}) {
  const today = localToday();
  const [date, setDate] = useState(current ?? "");
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(employmentError);
  return (
    <Dialog title={`${current ? "Change" : "Set"} the planned end date for ${name}`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (!date) { setErr("Choose a date."); failed(); return; }
        if (date < today) { setErr("The planned end date must be today or later."); failed(); return; }
        if (date === current) { setErr("That is already the planned end date."); failed(); return; }
        setErr("");
        void submit.run(async () => { await employeesApi.setPlannedEnd(assignmentId, date); onDone(date); }).then(() => failed());
      }}>
        <p className="dialogbody">{current ? `Currently ${fmtDate(current)}. ` : ""}HR and Accounts get an "ending soon" notice before this date.</p>
        <DateAndReason dateLabel="Planned end date" date={date} setDate={setDate} dateError={err} min={today} />
        <DialogActions onCancel={onClose} submitLabel="Save end date" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

function ExitDialog({ name, personId, onClose, onDone }: { name: string; personId: string; onClose: () => void; onDone: () => void }) {
  const today = localToday();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<string>(EXIT_REASONS[0]);
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(employmentError);
  return (
    <Dialog title={`Record that ${name} left the company?`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (!date) { setErr("Choose the exit date."); failed(); return; }
        if (date > today) { setErr("The exit date can't be in the future."); failed(); return; }
        setErr("");
        void submit.run(async () => { await employeesApi.exit(personId, date, reason); onDone(); }).then(() => failed());
      }}>
        <p className="dialogbody">The employee's status becomes Exited. The candidate's marketing status is not changed here.</p>
        <DateAndReason dateLabel="Exit date" date={date} setDate={setDate} reasons={EXIT_REASONS} reason={reason} setReason={setReason} dateError={err} max={today} />
        <DialogActions onCancel={onClose} submitLabel="Record exit" danger busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

function MarketDialog({ name, personId, onClose, onDone }: { name: string; personId: string; onClose: () => void; onDone: () => void }) {
  return (
    <ConfirmDialog title={`Return ${name} to marketing?`} confirmLabel="Return to marketing" onClose={onClose} onDone={onDone}
      action={() => employeesApi.returnToMarket(personId)} formatError={employmentError}>
      The candidate moves from Bench to Active so Sales can submit and place them again. The new placement opens the next
      assignment when it is marked Joined.
    </ConfirmDialog>
  );
}

/** 0150, leaving a project: HR/Accounts put the benched employee's candidate in a Sales team. */
function TeamDialog({ name, personId, current, onClose, onDone }: {
  name: string; personId: string; current: string | null; onClose: () => void; onDone: (team: string | null) => void;
}) {
  const teams = useQuery({ queryKey: employeeKeys.teams, queryFn: employeesApi.teams, staleTime: 5 * 60_000 });
  const [teamId, setTeamId] = useState("");
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(employmentError);
  const items = teams.data?.items ?? [];
  return (
    <Dialog title={`Assign ${name} to a team`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        if (!teamId) { setErr("Choose a team."); failed(); return; }
        if (teamId === current) { setErr("The candidate is already in this team."); failed(); return; }
        setErr("");
        const label = items.find((t) => t.id === teamId)?.name ?? null;
        void submit.run(async () => { await employeesApi.assignTeam(personId, teamId); onDone(label); }).then(() => failed());
      }}>
        <p className="dialogbody">The candidate moves to this Sales team for marketing. Their recruiter is cleared so the team's lead can assign one; the lead and their manager are notified.</p>
        <Field label="Team" error={err || (teams.error ? employmentError(teams.error) : "")}>
          {(p) => (
            <select {...p} value={teamId} onChange={(e) => setTeamId(e.target.value)} data-autofocus disabled={teams.isLoading}>
              <option value="">{teams.isLoading ? "Loading teams…" : "Choose a team"}</option>
              {items.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.lead.name ? ` (lead: ${t.lead.name})` : ""}{t.id === current ? " (current)" : ""}</option>
              ))}
            </select>
          )}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Assign team" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

/** 0150: payroll company, E-Verify and onboarded dates, and (with rate access) the pay rate of one assignment. */
function EmploymentDialog({ name, assignment, onClose, onDone }: {
  name: string; assignment: EmployeeDetail["assignments"][number]; onClose: () => void; onDone: () => void;
}) {
  const companies = useQuery({ queryKey: employeeKeys.payrollCompanies, queryFn: employeesApi.payrollCompanies, staleTime: 10 * 60_000 });
  const rateEditable = "payRate" in assignment;
  const initial = {
    company: assignment.payrollCompany?.id ?? "", everify: assignment.everifyDate ?? "", onboarded: assignment.onboardedDate ?? "",
    rate: typeof assignment.payRate === "number" ? String(assignment.payRate) : "",
  };
  const [company, setCompany] = useState(initial.company);
  const [everify, setEverify] = useState(initial.everify);
  const [onboarded, setOnboarded] = useState(initial.onboarded);
  const [rate, setRate] = useState(initial.rate);
  const [rateErr, setRateErr] = useState("");
  const [formErr, setFormErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(employmentError);
  // Active companies, plus the current one even if it was made inactive since.
  const options = (companies.data?.items ?? []).filter((c) => c.status === "active" || c.id === initial.company);
  return (
    <Dialog title={`Employment details: ${name}, assignment ${assignment.assignmentNo}`} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        const changes: EmploymentChanges = {};
        if (company !== initial.company) changes.payrollCompanyId = company || null;
        if (everify !== initial.everify) changes.everifyDate = everify || null;
        if (onboarded !== initial.onboarded) changes.onboardedDate = onboarded || null;
        if (rateEditable && rate.trim() !== initial.rate) {
          const n = rate.trim() === "" ? null : Number(rate);
          if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 1000 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6)) {
            setRateErr("Enter an hourly rate above 0 and up to 1,000, with at most two decimals."); failed(); return;
          }
          changes.payRate = n;
        }
        setRateErr("");
        if (Object.keys(changes).length === 0) { setFormErr("Nothing changed."); failed(); return; }
        setFormErr("");
        void submit.run(async () => { await employeesApi.setEmployment(assignment.id, changes); onDone(); }).then(() => failed());
      }}>
        <p className="dialogbody">{assignment.client.name} · started {fmtDate(assignment.startDate)}{assignment.endDate ? `, ended ${fmtDate(assignment.endDate)}` : ""}.</p>
        <label className="field">Payroll company
          <select value={company} onChange={(e) => setCompany(e.target.value)} data-autofocus>
            <option value="">Not set</option>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== "active" ? " (inactive)" : ""}</option>)}
          </select>
        </label>
        <Field label="E-Verify date">{(p) => <input {...p} type="date" value={everify} onChange={(e) => setEverify(e.target.value)} />}</Field>
        <Field label="Onboarded date">{(p) => <input {...p} type="date" value={onboarded} onChange={(e) => setOnboarded(e.target.value)} />}</Field>
        {rateEditable && (
          <Field label="Pay rate (USD per hour)" error={rateErr} hint="Visible only to people who may see rates.">
            {(p) => <input {...p} type="number" inputMode="decimal" min="0.01" max="1000" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />}
          </Field>
        )}
        {formErr && <p className="error" role="alert">{formErr}</p>}
        <DialogActions onCancel={onClose} submitLabel="Save details" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
