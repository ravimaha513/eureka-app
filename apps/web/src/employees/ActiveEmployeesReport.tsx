import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLookups } from "../lookups";
import { employeeKeys, employeesApi, employmentError, localToday } from "./employeesApi";

/** "2026-10" → "October 2026". */
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/**
 * Reports > Active employees (0150): distinct employees with an assignment
 * running in a calendar month, for the assignments the user can see, in
 * total, per client and per payroll company; optionally one client.
 */
export function ActiveEmployeesReport() {
  const id = useId();
  const lookups = useLookups();
  const [month, setMonth] = useState(localToday().slice(0, 7));
  const [clientId, setClientId] = useState("");
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const q = useQuery({
    queryKey: employeeKeys.active(month, clientId),
    queryFn: () => employeesApi.activeEmployees(month, clientId || undefined),
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  const clients = lookups.data?.clients ?? [];
  const d = q.data;

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Active employees</h2>
      <p className="sub">Employees on an assignment on any day of the month, for the placements you can see.</p>
      <form className="filters" aria-label="Active employees filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-m`}>Month</label>
            <input id={`${id}-m`} type="month" value={month} onChange={(e) => setMonth(e.target.value)}
              aria-invalid={!valid || undefined} aria-describedby={!valid ? `${id}-mx` : undefined} />
          </div>
          {clients.length > 0 && (
            <label className="field inline">Client
              <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {!valid && <p id={`${id}-mx`} className="error">Choose a month.</p>}
      </form>

      {valid && (q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{employmentError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : d ? (
        <div aria-busy={q.isFetching || undefined}>
          <ul className="tiles">
            <li className="tile card"><span className="tilelabel">Active employees</span><span className="tilevalue">{d.total}</span>
              <span className="tilehint">{monthLabel(d.month)}</span></li>
          </ul>
          <div className="card tablewrap">
            <table aria-label="Active employees by client">
              <thead><tr><th>Client</th><th>Employees</th></tr></thead>
              <tbody>
                {d.byClient.map((g) => <tr key={g.client?.id ?? "none"}><td>{g.client?.name ?? <span className="muted">Not visible to you</span>}</td><td>{g.count}</td></tr>)}
                {d.byClient.length === 0 && <tr><td colSpan={2} className="empty">No employees on assignment in this month.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.byCompany.length > 0 && (
            <div className="card tablewrap">
              <table aria-label="Active employees by payroll company">
                <thead><tr><th>Payroll company</th><th>Employees</th></tr></thead>
                <tbody>
                  {d.byCompany.map((g) => <tr key={g.company?.id ?? "none"}><td>{g.company?.name ?? "Not set"}</td><td>{g.count}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null)}
    </section>
  );
}
