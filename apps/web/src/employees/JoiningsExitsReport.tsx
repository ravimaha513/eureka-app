import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, type Me } from "../api";
import { fmtDate } from "../sales/ui";
import { employeeKeys, employeesApi, employmentError, employmentLabel, localToday, shiftDays } from "./employeesApi";

const EXPORT_ROW_CAP = 50_000;

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Reports > Joinings and exits (FR-EMP, design B7): assignments that started
 * or ended in a period, for what the user can see. Export (report:export) is
 * capped and audited by the server.
 */
export function ReportsPage({ me }: { me: Pick<Me, "capabilities"> }) {
  const id = useId();
  const today = localToday();
  const [from, setFrom] = useState(shiftDays(today, -90));
  const [to, setTo] = useState(today);
  const invalid = !from || !to || from > to;
  const q = useQuery({
    queryKey: employeeKeys.report(from, to),
    queryFn: () => employeesApi.joiningsExits(from, to),
    enabled: !invalid,
    placeholderData: keepPreviousData,
  });
  const canExport = me.capabilities.includes("report:export");
  const run = useMutation({
    mutationFn: () => employeesApi.exportJoiningsExits(from, to),
    onSuccess: (r) => download(r.blob, r.filename),
  });
  const d = q.data;

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Reports</h1>
        <p className="sub">Joinings and exits: assignments that started or ended in the period, for the teams and placements you can see.</p>
      </div>

      <form className="filters" aria-label="Report period" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-from`}>From</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-to`}>Through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
          </div>
          {canExport && (
            <div className="export">
              <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? "Exporting…" : "Export CSV"}
              </button>
              <small className="hint">Up to {EXPORT_ROW_CAP.toLocaleString("en-US")} rows for your export scope. No contact details are included.</small>
            </div>
          )}
        </div>
        {invalid && <p id={`${id}-range`} className="error" role="alert">Choose a start date on or before the end date.</p>}
        {run.isError ? (
          <p className="error" role="alert">
            {run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.") : employmentError(run.error)}
          </p>
        ) : run.data ? (
          <p className="muted" role="status">
            {run.data.truncated ? `Exported the first ${run.data.rows.toLocaleString("en-US")} rows (the export limit). Choose a shorter period for the rest.`
              : `Exported ${run.data.rows.toLocaleString("en-US")} ${run.data.rows === 1 ? "row" : "rows"}.`}
          </p>
        ) : null}
      </form>

      {!invalid && (q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{employmentError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : d ? (
        <section aria-labelledby={`${id}-je`} aria-busy={q.isFetching || undefined}>
          <h2 id={`${id}-je`}>Joinings and exits, {fmtDate(d.from)} – {fmtDate(d.to)}</h2>
          <ul className="tiles">
            <li className="tile card"><span className="tilelabel">Joinings</span><span className="tilevalue">{d.totals.joinings}</span>
              <span className="tilehint">{d.totals.firstPlacements} first placements</span></li>
            <li className="tile card"><span className="tilelabel">Exits</span><span className="tilevalue">{d.totals.exits}</span>
              <span className="tilehint">Assignments that ended</span></li>
            {Object.entries(d.totals.exitsByReason).map(([k, v]) => (
              <li key={k} className="tile card"><span className="tilelabel">Exits: {employmentLabel(k)}</span><span className="tilevalue">{v}</span></li>
            ))}
          </ul>

          {d.byTeam.length > 0 && (
            <div className="card tablewrap">
              <table aria-label="By team">
                <thead><tr><th>Team</th><th>Joinings</th><th>Exits</th></tr></thead>
                <tbody>
                  {d.byTeam.map((g) => (
                    <tr key={g.team?.id ?? "none"}><td>{g.team?.name ?? "No team"}</td><td>{g.joinings}</td><td>{g.exits}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card tablewrap">
            <table aria-label="Joinings and exits">
              <thead><tr><th>Event</th><th>Date</th><th>Candidate</th><th>Client</th><th>Team / recruiter</th><th>Location</th><th>End reason</th></tr></thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={`${i.kind}-${i.assignmentId}`}>
                    <td><span className={`badge ${i.kind === "joining" ? "st-joined" : "st-backout"}`}>{i.kind === "joining" ? "Joining" : "Exit"}</span>
                      {i.kind === "joining" && i.isFirstPlacement && <>{" "}<span className="badge first">First placement</span></>}</td>
                    <td>{fmtDate(i.date)}</td>
                    <td>{i.candidate.name ?? <span className="muted">Name hidden</span>}<span className="block muted">Assignment {i.assignmentNo}</span></td>
                    <td>{i.client}</td>
                    <td>{i.team?.name ?? "—"}<span className="block muted">{i.recruiter ?? ""}</span></td>
                    <td>{i.location ?? "—"}</td>
                    <td>{i.endReason ? employmentLabel(i.endReason) : "—"}</td>
                  </tr>
                ))}
                {d.items.length === 0 && <tr><td colSpan={7} className="empty">No joinings or exits in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.items.length.toLocaleString("en-US")} rows. Choose a shorter period to see the rest.</p>}
        </section>
      ) : null)}
    </>
  );
}
