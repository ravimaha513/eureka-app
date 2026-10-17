import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, can, type Me } from "../api";
import { fmtDate } from "../sales/ui";
import { employeeKeys, employeesApi, employmentError, employmentLabel, localToday, shiftDays } from "./employeesApi";
import { MarketReportPanel } from "./MarketReport";
import { ActiveEmployeesReport } from "./ActiveEmployeesReport";

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

type ReportTab = "joinings" | "market";

/**
 * Reports page: Joinings and exits for every report:read holder, and the
 * Market tab (gap L3, MarketReport.tsx) for report.market:read holders.
 */
export function ReportsPage({ me }: { me: Pick<Me, "capabilities"> }) {
  const tabsId = useId();
  const canExport = can(me, "report:export");
  const hasMarket = can(me, "report.market:read");
  const hasJoinings = can(me, "report:read");
  const [tab, setTab] = useState<ReportTab>(hasJoinings ? "joinings" : "market");
  if (!hasMarket) {
    return (
      <>
        <div><h1 tabIndex={-1}>Reports</h1></div>
        <JoiningsExitsPanel canExport={canExport} />
      </>
    );
  }
  const tabs: [ReportTab, string][] = [...(hasJoinings ? [["joinings", "Joinings and exits"] as [ReportTab, string]] : []), ["market", "Market"]];
  return (
    <>
      <div><h1 tabIndex={-1}>Reports</h1></div>
      <div className="tabs" role="tablist" aria-label="Reports">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`${tabsId}-t-${k}`} className="tab" aria-selected={tab === k}
            aria-controls={`${tabsId}-p-${k}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-p-${tab}`} aria-labelledby={`${tabsId}-t-${tab}`}>
        {tab === "market" ? <MarketReportPanel canExport={canExport} onDownload={download} /> : <JoiningsExitsPanel canExport={canExport} />}
      </div>
    </>
  );
}

/**
 * Reports > Joinings and exits (FR-EMP, design B7): assignments that started
 * or ended in a period, for what the user can see. Export (report:export) is
 * capped and audited by the server.
 */
function JoiningsExitsPanel({ canExport }: { canExport: boolean }) {
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
  const run = useMutation({
    mutationFn: () => employeesApi.exportJoiningsExits(from, to),
    onSuccess: (r) => download(r.blob, r.filename),
  });
  const d = q.data;

  return (
    <>
      <p className="sub">Joinings and exits: assignments that started or ended in the period, for the teams and placements you can see.</p>

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
            {d.totals.firstAssignments !== undefined && (
              <li className="tile card"><span className="tilelabel">First assignments</span><span className="tilevalue">{d.totals.firstAssignments}</span>
                <span className="tilehint">{d.totals.laterAssignments ?? 0} later assignments</span></li>
            )}
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

          {(d.byCompany?.length ?? 0) > 0 && (
            <div className="card tablewrap">
              <table aria-label="By payroll company">
                <thead><tr><th>Payroll company</th><th>Joinings</th><th>First / later assignments</th><th>Exits</th></tr></thead>
                <tbody>
                  {d.byCompany!.map((g) => (
                    <tr key={g.company?.id ?? "none"}><td>{g.company?.name ?? "Not set"}</td><td>{g.joinings}</td>
                      <td>{g.firstAssignments} / {g.laterAssignments}</td><td>{g.exits}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card tablewrap">
            <table aria-label="Joinings and exits">
              <thead><tr><th>Event</th><th>Date</th><th>Candidate</th><th>Client</th><th>Team / recruiter</th><th>Location</th><th>Technology</th><th>Payroll company</th><th>End reason</th></tr></thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={`${i.kind}-${i.assignmentId}`}>
                    <td><span className={`badge ${i.kind === "joining" ? "st-joined" : "st-backout"}`}>{i.kind === "joining" ? "Joining" : "Exit"}</span>
                      {i.kind === "joining" && i.isFirstPlacement && <>{" "}<span className="badge first">First placement</span></>}
                      {i.isFirstAssignment === false && <span className="block muted">Later assignment</span>}</td>
                    <td>{fmtDate(i.date)}</td>
                    <td>{i.candidate.name ?? <span className="muted">Name hidden</span>}<span className="block muted">Assignment {i.assignmentNo}</span></td>
                    <td>{i.client ?? <span className="muted">—</span>}</td>
                    <td>{i.team?.name ?? "—"}<span className="block muted">{i.recruiter ?? ""}</span></td>
                    <td>{i.location ?? "—"}</td>
                    <td>{i.technology ?? "—"}</td>
                    <td>{i.payrollCompany?.name ?? "—"}</td>
                    <td>{i.endReason ? employmentLabel(i.endReason) : "—"}</td>
                  </tr>
                ))}
                {d.items.length === 0 && <tr><td colSpan={9} className="empty">No joinings or exits in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.items.length.toLocaleString("en-US")} rows. Choose a shorter period to see the rest.</p>}
        </section>
      ) : null)}

      <ActiveEmployeesReport />
    </>
  );
}
