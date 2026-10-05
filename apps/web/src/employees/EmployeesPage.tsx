import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "../api";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { useLookups } from "../lookups";
import { StatusChips } from "../pipeline/ui";
import { Drawer, Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import {
  EMPLOYEE_STATUSES, END_REASONS, EXIT_REASONS, employeeKeys, employeesApi, employmentError, employmentLabel, localToday,
  type Employee, type EmployeeDetail, type HistoryEntry,
} from "./employeesApi";

const PAGE_SIZE = 50;
const SOON_DAYS = 30;

export const EmployeeStatus = ({ status }: { status: string }) => <span className={`badge emp-${status}`}>{employmentLabel(status)}</span>;

const nameOf = (e: Pick<Employee, "candidate">) => e.candidate.name ?? "Name hidden";

/** Employees (FR-EMP): list with filters and a drawer with assignment history and lifecycle actions. */
export function EmployeesPage(_: { me?: Pick<Me, "capabilities"> }) {
  const id = useId();
  const lookups = useLookups();
  const [status, setStatus] = useState("");
  const [locationId, setLocationId] = useState("");
  const [clientId, setClientId] = useState("");
  const [soon, setSoon] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);

  // Name search applies after a short pause (one request per typed word, not per key).
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const filters = {
    status, locationId, clientId, endingWithinDays: soon ? SOON_DAYS : undefined, search, cursor: cursors[page] ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...employeeKeys.all, "list", filters],
    queryFn: () => employeesApi.list(filters),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const hasFilters = Boolean(status || locationId || clientId || soon || search);
  const n = items.length;
  const countMsg = q.isLoading || q.error ? ""
    : `${n} ${n === 1 ? "employee" : "employees"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;
  const locations = lookups.data?.locations ?? [];
  const clients = lookups.data?.clients ?? [];

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Employees</h1>
        <p className="sub">People placed through Eureka: on assignment, on the bench, or exited. Open an employee for their assignments and history.</p>
      </div>

      <form className="filters" role="search" aria-label="Employee filters" onSubmit={(e) => e.preventDefault()}>
        <StatusChips label="Status" statuses={EMPLOYEE_STATUSES} value={status} onChange={(v) => { setStatus(v); reset(); }} />
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Name</label>
            <input id={`${id}-q`} type="search" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <label className="field inline">Location
            <select value={locationId} onChange={(e) => { setLocationId(e.target.value); reset(); }}>
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          {clients.length > 0 && (
            <label className="field inline">Current client
              <select value={clientId} onChange={(e) => { setClientId(e.target.value); reset(); }}>
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={soon} onChange={(e) => { setSoon(e.target.checked); reset(); }} />
            {" "}Ending within {SOON_DAYS} days
          </label>
          {hasFilters && (
            <button type="button" className="btn" onClick={() => {
              setStatus(""); setLocationId(""); setClientId(""); setSoon(false); setSearchText(""); setSearch(""); reset();
            }}>Clear filters</button>
          )}
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{employmentError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <div className="tablewrap"><table aria-label="Employees" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Employee</th><th>Status</th><th>Current client</th><th>Assignment</th><th>Planned end</th><th>Location / team</th>
              <th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((e) => {
                const a = e.assignment;
                const open = a !== null && a.endDate === null;
                return (
                  <tr key={e.id}>
                    <td><b>{nameOf(e)}</b><span className="block muted">Since {fmtDate(e.employeeSince)}</span></td>
                    <td><EmployeeStatus status={e.status} /><span className="block muted">{fmtDate(e.statusSince)}</span></td>
                    <td>{open && a.client ? a.client.name : <span className="muted">—</span>}</td>
                    <td>{a ? <>No. {a.assignmentNo}<span className="block muted">{fmtDate(a.startDate)} – {a.endDate ? fmtDate(a.endDate) : "ongoing"}</span></> : <span className="muted">—</span>}</td>
                    <td>{open && a.plannedEndDate ? fmtDate(a.plannedEndDate) : <span className="muted">—</span>}</td>
                    <td>{e.location?.name ?? "—"}<span className="block muted">{e.team?.name ?? ""}</span></td>
                    <td className="rowactions">
                      <button type="button" className="btn sm" onClick={() => setOpenId(e.id)} aria-label={`Open employee ${nameOf(e)}`}>Open</button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={7} className="empty">{hasFilters ? "No employees match these filters." : "No employees yet. A person becomes an employee when their placement is marked Joined."}</td></tr>
              )}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <nav className="pager" aria-label="Employee pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>

      {openId && <EmployeeDrawer id={openId} initial={items.find((e) => e.id === openId) ?? null} onClose={() => setOpenId(null)} onNotice={setNotice} />}
    </>
  );
}

type Action = "end" | "planned" | "exit" | "market";

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
  const [message, setMessage] = useState("");
  const e = q.data;
  const full = Boolean(e && !q.isPlaceholderData);
  const a = e?.assignment ?? null;
  const open = a !== null && a.endDate === null;
  const done = (m: string) => {
    setAction(null); setMessage(m); onNotice(m);
    void qc.invalidateQueries({ queryKey: employeeKeys.all });
  };
  const acts = e?.actions;
  const any = acts && (acts.endAssignment || acts.setEndDate || acts.exit || acts.returnToMarket);

  return (
    <>
      <Drawer title={e ? nameOf(e) : "Employee"} onClose={onClose} suspended={action !== null} wide closeLabel="Close employee details">
        {q.isLoading && !e ? <p className="empty">Loading…</p> : !e ? (
          <p className="error" role="alert">{employmentError(q.error)}</p>
        ) : (
          <>
            <p><EmployeeStatus status={e.status} /></p>
            <dl className="facts">
              <dt>Employee since</dt><dd>{fmtDate(e.employeeSince)}</dd>
              <dt>Status since</dt><dd>{fmtDate(e.statusSince)}</dd>
              {e.exitedOn && <><dt>Exited</dt><dd>{fmtDate(e.exitedOn)}{e.exitReason && ` · ${employmentLabel(e.exitReason)}`}</dd></>}
              <dt>Location</dt><dd>{e.location?.name ?? "—"}</dd>
              <dt>Team</dt><dd>{e.team?.name ?? "—"}</dd>
              {a && <><dt>Current client</dt><dd>{open && a.client ? a.client.name : "None"}</dd></>}
              {open && <><dt>Planned end</dt><dd>{a.plannedEndDate ? fmtDate(a.plannedEndDate) : "Not set"}</dd></>}
            </dl>

            <p role="status" aria-live="polite" className="livemsg">{message}</p>

            {any && (
              <section className="manageblock" aria-labelledby={`${hid}-act`}>
                <h3 id={`${hid}-act`}>Actions</h3>
                <div className="rowactions" role="group" aria-labelledby={`${hid}-act`}>
                  {acts.setEndDate && <button type="button" className="btn sm" onClick={() => setAction("planned")}>{a?.plannedEndDate ? "Extend or change end date…" : "Set planned end date…"}</button>}
                  {acts.endAssignment && <button type="button" className="btn sm danger" onClick={() => setAction("end")}>End assignment (project exit)…</button>}
                  {acts.returnToMarket && <button type="button" className="btn sm" onClick={() => setAction("market")}>Reassign: return to marketing…</button>}
                  {acts.exit && <button type="button" className="btn sm danger" onClick={() => setAction("exit")}>Record exit…</button>}
                </div>
                {e.status === "bench" && !acts.returnToMarket && acts.exit && (
                  <small className="hint">Returning to marketing isn't offered after a failed background check, or once Sales has moved the candidate.</small>
                )}
              </section>
            )}

            <section className="manageblock" aria-labelledby={`${hid}-as`}>
              <h3 id={`${hid}-as`}>Assignments</h3>
              {!full ? <p className="muted">Loading assignments…</p> : e.assignments.length === 0 ? (
                <p className="muted">No assignment you can see.</p>
              ) : (
                <div className="tablewrap"><table className="mini" aria-labelledby={`${hid}-as`}>
                  <thead><tr><th>No.</th><th>Client</th><th>Started</th><th>Ended</th><th>Planned end</th><th>Reason</th></tr></thead>
                  <tbody>
                    {e.assignments.map((x) => (
                      <tr key={x.id}>
                        <td>{x.assignmentNo}</td>
                        <td>{x.client.name}{x.isFirstPlacement && <>{" "}<span className="badge first">First placement</span></>}</td>
                        <td>{fmtDate(x.startDate)}</td>
                        <td>{x.endDate ? fmtDate(x.endDate) : "Ongoing"}</td>
                        <td>{x.plannedEndDate && !x.endDate ? fmtDate(x.plannedEndDate) : "—"}</td>
                        <td>{x.endReason ? employmentLabel(x.endReason) : "—"}</td>
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
