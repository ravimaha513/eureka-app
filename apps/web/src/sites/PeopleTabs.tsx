import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserMinus } from "lucide-react";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { employmentLabel } from "../employees/employeesApi";
import { Person } from "../shell/ui";
import { Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import { localDay, siteKeys, sitesApi, sitesError, type CompanyEmployee, type Named, type SiteKind } from "./sitesApi";
import { Layer } from "./ui";

/** Debounced text for option searches. */
function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value.trim()), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** App users in charge of a company or facility. */
export function InchargesTab({ kind, ownerId, canManage }: { kind: SiteKind; ownerId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: siteKeys.incharges(kind, ownerId), queryFn: () => sitesApi.incharges(kind, ownerId) });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Named | null>(null);
  const [message, setMessage] = useState("");
  const done = (m: string) => {
    setMessage(m);
    void qc.invalidateQueries({ queryKey: siteKeys.incharges(kind, ownerId) });
    void qc.invalidateQueries({ queryKey: [kind, "list"] });
    void qc.invalidateQueries({ queryKey: siteKeys.detail(kind, ownerId), exact: true });
  };
  const items = q.data?.items ?? [];
  return (
    <div className="tabpanel">
      <div className="panelhead">
        <h3>Incharges</h3>
        {canManage && <button type="button" className="btn primary sm" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />Add incharge</button>}
      </div>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{sitesError(q.error)}</p>
        : items.length === 0 ? <p className="muted">No incharge assigned.</p>
        : (
          <ul className="peoplelist" aria-label="Incharges">
            {items.map((u) => (
              <li key={u.id}>
                <Person name={u.name}><b>{u.name}</b></Person>
                {canManage && (
                  <button type="button" className="btn sm ghost" onClick={() => setRemoving(u)} aria-label={`Remove incharge ${u.name}`}>
                    <UserMinus size={15} aria-hidden="true" />Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      {adding && (
        <Layer>
          <PickDialog title="Add incharge" label="User" submitLabel="Add incharge"
            load={(text) => sitesApi.inchargeOptions(kind, ownerId, text).then((r) => r.items.map((x) => ({ id: x.id, name: x.name })))}
            queryKey={[kind, "detail", ownerId, "incharge-options"]}
            hint="Active users holding a role at this location."
            onClose={() => setAdding(false)}
            onPick={async (u) => { await sitesApi.addIncharge(kind, ownerId, u.id); setAdding(false); done(`${u.name} is now an incharge.`); }} />
        </Layer>
      )}
      {removing && (
        <Layer>
          <ConfirmDialog title="Remove incharge" confirmLabel="Remove" danger formatError={(e) => sitesError(e)}
            action={() => sitesApi.removeIncharge(kind, ownerId, removing.id)}
            onClose={() => setRemoving(null)} onDone={() => { const n = removing.name; setRemoving(null); done(`${n} is no longer an incharge.`); }}>
            <p>Remove {removing.name} as an incharge? They keep their other access.</p>
          </ConfirmDialog>
        </Layer>
      )}
    </div>
  );
}

/** Employees working for a company (one company at a time per employee). */
export function EmployeesTab({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: siteKeys.employees(companyId), queryFn: () => sitesApi.employees(companyId) });
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<CompanyEmployee | null>(null);
  const [message, setMessage] = useState("");
  const done = (m: string) => {
    setMessage(m);
    void qc.invalidateQueries({ queryKey: siteKeys.employees(companyId) });
    void qc.invalidateQueries({ queryKey: ["companies", "list"] });
    void qc.invalidateQueries({ queryKey: ["companies", "stats"] });
  };
  const items = q.data?.items ?? [];
  const showEmail = items.some((e) => e.email);
  return (
    <div className="tabpanel">
      <div className="panelhead">
        <h3>Employees</h3>
        {canManage && <button type="button" className="btn primary sm" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />Add employee</button>}
      </div>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{sitesError(q.error, "company")}</p>
        : items.length === 0 ? <p className="muted">No employees assigned.</p>
        : (
          <div className="tablewrap roundtable"><table aria-label="Company employees">
            <thead><tr>
              <th scope="col">Employee</th>{showEmail && <th scope="col">Email</th>}<th scope="col">Start</th><th scope="col">End</th><th scope="col">Employment</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((e) => (
                <tr key={`${e.employeeId}-${e.startDate}`}>
                  <td><Person name={e.name}><b>{e.name}</b></Person></td>
                  {showEmail && <td>{e.email ?? <span className="muted">—</span>}</td>}
                  <td>{fmtDate(e.startDate)}</td>
                  <td>{e.endDate ? fmtDate(e.endDate) : <span className="muted">Current</span>}</td>
                  <td><span className={`badge emp-${e.status}`}>{employmentLabel(e.status)}</span></td>
                  <td className="rowactions">
                    {canManage && !e.endDate && (
                      <button type="button" className="btn sm ghost" onClick={() => setEnding(e)} aria-label={`Remove employee ${e.name}`}>
                        <UserMinus size={15} aria-hidden="true" />Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      {adding && (
        <Layer>
          <PickDialog title="Add employee" label="Employee" submitLabel="Add employee" withDate="Start date"
            load={(text) => sitesApi.employeeOptions(companyId, text).then((r) => r.items.map((x) => ({ id: x.employeeId, name: x.name })))}
            queryKey={["companies", "detail", companyId, "employee-options"]}
            hint="Employees of this location who don't work for another company."
            onClose={() => setAdding(false)}
            onPick={async (u, date) => { await sitesApi.addEmployee(companyId, u.id, date!); setAdding(false); done(`${u.name} added.`); }} />
        </Layer>
      )}
      {ending && (
        <Layer>
          <EndEmployeeDialog employee={ending} onClose={() => setEnding(null)}
            onEnd={async (date) => { await sitesApi.endEmployee(companyId, ending.employeeId, date); const n = ending.name; setEnding(null); done(`${n} removed from this company.`); }} />
        </Layer>
      )}
    </div>
  );
}

/** Search-and-pick dialog for a user or an employee (and a start date for employees). */
function PickDialog({ title, label, submitLabel, hint, load, queryKey, withDate, onClose, onPick }: {
  title: string; label: string; submitLabel: string; hint: string; withDate?: string;
  load: (text: string) => Promise<Named[]>; queryKey: readonly unknown[];
  onClose: () => void; onPick: (n: Named, date?: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const search = useDebounced(text);
  const q = useQuery({ queryKey: [...queryKey, search], queryFn: () => load(search) });
  const [chosen, setChosen] = useState("");
  const [date, setDate] = useState(localDay());
  const [errors, setErrors] = useState<{ pick?: string; date?: string }>({});
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, run } = useSubmit((e) => sitesError(e));
  const options = q.data ?? [];
  const id = useId();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const pick = options.find((o) => o.id === chosen);
    const errs = { pick: pick ? undefined : `Choose ${label.toLowerCase() === "user" ? "a user" : "an employee"}.`, date: withDate && !date ? "Enter the date." : undefined };
    setErrors(errs);
    if (errs.pick || errs.date) { failed(); return; }
    void run(async () => { try { await onPick(pick!, withDate ? date : undefined); } catch (err) { failed(); throw err; } });
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-s`}>Search</label>
          <input id={`${id}-s`} type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={80} data-autofocus />
        </div>
        <Field label={label} error={errors.pick} hint={hint}>
          {(p) => (
            <select {...p} value={chosen} onChange={(e) => { setChosen(e.target.value); setErrors((x) => ({ ...x, pick: undefined })); }} disabled={q.isLoading}>
              <option value="">{q.isLoading ? "Loading…" : options.length ? "Choose…" : "No matches"}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </Field>
        {withDate && <Field label={withDate} error={errors.date}>{(p) => <input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>}
        <DialogActions onCancel={onClose} submitLabel={submitLabel} busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function EndEmployeeDialog({ employee, onClose, onEnd }: { employee: CompanyEmployee; onClose: () => void; onEnd: (date: string) => Promise<void> }) {
  const [date, setDate] = useState(localDay());
  const [fieldError, setFieldError] = useState("");
  const { busy, error, run } = useSubmit((e) => sitesError(e));
  const bodyId = useId();
  return (
    <Dialog title="Remove employee" onClose={onClose} describedBy={bodyId}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        if (!date) { setFieldError("Enter the last day."); return; }
        if (date < employee.startDate) { setFieldError("The last day can't be before the start date."); return; }
        setFieldError("");
        void run(() => onEnd(date));
      }}>
        <p id={bodyId} className="dialogbody">{employee.name} stops working for this company. Their history stays.</p>
        <Field label="Last day" error={fieldError}>{(p) => <input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} data-autofocus />}</Field>
        <DialogActions onCancel={onClose} submitLabel="Remove" danger busy={busy} error={error} />
      </form>
    </Dialog>
  );
}
