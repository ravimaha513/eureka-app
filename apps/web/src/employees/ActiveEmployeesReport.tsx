import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLookups } from "../lookups";
import { employeeKeys, employeesApi, employmentError, localToday } from "./employeesApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import "../dashboard/insights.css";
import "../dashboard/reports.css";

/** "2026-10" → "October 2026". */
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/**
 * Reports > Active employees (0150): distinct employees with an assignment
 * running in a calendar month, for the assignments the user can see, in
 * total, per client and per payroll company; optionally one client.
 * Its own section with its own month and client filters (separate from the period above it).
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
    <section className="rep-block rep-active" aria-labelledby={`${id}-h`}>
      <div className="ins-head">
        <h2 id={`${id}-h`}>Active employees{d && <span className="rep-range">{monthLabel(d.month)}</span>}</h2>
      </div>
      <p className="sub rep-intro">Employees on an assignment on any day of the month, for the placements you can see. These filters apply to this section only.</p>
      <form className="ins-period rep-filters" aria-label="Active employees filters" onSubmit={(e) => e.preventDefault()}>
        <div className="ins-dates">
          <div className="field inline">
            <label htmlFor={`${id}-m`}>Month</label>
            <input id={`${id}-m`} type="month" value={month} onChange={(e) => setMonth(e.target.value)}
              aria-invalid={!valid || undefined} aria-describedby={!valid ? `${id}-mx` : undefined} />
          </div>
          {clients.length > 0 && (
            <div className="field inline">
              <label htmlFor={`${id}-c`}>Client</label>
              <select id={`${id}-c`} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {!valid && <p id={`${id}-mx`} className="error rep-msg">Choose a month.</p>}
      </form>

      {valid && (q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={employmentError(q.error)} />
      ) : d ? (
        <div className="rep-body" aria-busy={q.isFetching || undefined}>
          <ul className="ins-tiles rep-tiles" aria-label="Active employees totals">
            <li><span className="tilelabel">Active employees</span><span className="tilevalue">{d.total}</span>
              <span className="ins-sub">{monthLabel(d.month)}</span></li>
          </ul>
          <div className="rep-pair">
            <section className="rep-table" aria-labelledby={`${id}-cl`}>
              <h3 id={`${id}-cl`}>By client</h3>
              <div className="card tablewrap listcard">
                <table className="rep-compact" aria-label="Active employees by client">
                  <thead><tr><th scope="col">Client</th><th scope="col" className="num">Employees</th></tr></thead>
                  <tbody>
                    {d.byClient.map((g) => (
                      <tr key={g.client?.id ?? "none"}>
                        <td className="c-primary">{g.client ? <b>{g.client.name}</b> : <span className="muted">Not visible to you</span>}</td>
                        <td className="num" data-label="Employees">{g.count}</td>
                      </tr>
                    ))}
                    {d.byClient.length === 0 && <tr><td colSpan={2} className="empty">No employees on assignment in this month.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            {d.byCompany.length > 0 && (
              <section className="rep-table" aria-labelledby={`${id}-co`}>
                <h3 id={`${id}-co`}>By payroll company</h3>
                <div className="card tablewrap listcard">
                  <table className="rep-compact" aria-label="Active employees by payroll company">
                    <thead><tr><th scope="col">Payroll company</th><th scope="col" className="num">Employees</th></tr></thead>
                    <tbody>
                      {d.byCompany.map((g) => (
                        <tr key={g.company?.id ?? "none"}>
                          <td className="c-primary">{g.company ? <b>{g.company.name}</b> : <span className="muted">Not set</span>}</td>
                          <td className="num" data-label="Employees">{g.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>
      ) : null)}
    </section>
  );
}
