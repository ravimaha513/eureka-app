import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, can, type Me } from "../api";
import { saveBlob } from "../lib/download";
import { fmtDate } from "../sales/ui";
import { employeeKeys, employeesApi, employmentError, employmentLabel, localToday, shiftDays } from "./employeesApi";
import { MarketReportPanel } from "./MarketReport";
import { ActiveEmployeesReport } from "./ActiveEmployeesReport";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { Tabs } from "../ui/Tabs";
import { PRESET_DAYS, PeriodPresets } from "../dashboard/PeriodPresets";
import "../dashboard/insights.css";
import "../dashboard/reports.css";

const EXPORT_ROW_CAP = 50_000;

type ReportTab = "joinings" | "market";

/**
 * Reports page: Joinings and exits for every report:read holder, and the
 * Market tab (gap L3, MarketReport.tsx) for report.market:read holders.
 * Tabs follow the WAI-ARIA pattern (ui/Tabs: arrow keys, Home/End, roving tabindex).
 */
export function ReportsPage({ me }: { me: Pick<Me, "capabilities"> }) {
  const canExport = can(me, "report:export");
  const hasMarket = can(me, "report.market:read");
  const hasJoinings = can(me, "report:read");
  if (!hasMarket) {
    return (
      <div className="rep">
        <div><h1 tabIndex={-1}>Reports</h1></div>
        <JoiningsExitsPanel canExport={canExport} />
      </div>
    );
  }
  const tabs = [...(hasJoinings ? [{ key: "joinings" as ReportTab, label: "Joinings and exits" }] : []), { key: "market" as ReportTab, label: "Market" }];
  return (
    <div className="rep">
      <div><h1 tabIndex={-1}>Reports</h1></div>
      <Tabs label="Reports" tabs={tabs} panelClassName="rep-panel">
        {(tab) => (tab === "market" ? <MarketReportPanel canExport={canExport} onDownload={saveBlob} /> : <JoiningsExitsPanel canExport={canExport} />)}
      </Tabs>
    </div>
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
  // A preset of n days runs from the same date n days ago through today (the report's long-standing 90-day default).
  const [from, setFrom] = useState(shiftDays(today, -90));
  const [to, setTo] = useState(today);
  const preset = to === today ? PRESET_DAYS.find((n) => from === shiftDays(today, -n)) ?? null : null;
  const invalid = !from || !to || from > to;
  const q = useQuery({
    queryKey: employeeKeys.report(from, to),
    queryFn: () => employeesApi.joiningsExits(from, to),
    enabled: !invalid,
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () => employeesApi.exportJoiningsExits(from, to),
    onSuccess: (r) => saveBlob(r.blob, r.filename),
  });
  const d = q.data;
  const reasons = d ? Object.entries(d.totals.exitsByReason) : [];

  return (
    <div className="rep-stack">
      <section className="rep-block" aria-labelledby={`${id}-je`}>
        <p className="sub rep-intro">Assignments that started or ended in the period, for the teams and placements you can see.</p>

        <form className="ins-period rep-filters" aria-label="Report period" onSubmit={(e) => e.preventDefault()}>
          <PeriodPresets value={preset} onChange={(n) => { setFrom(shiftDays(today, -n)); setTo(today); }} />
          <div className="ins-dates">
            <div className="field inline">
              <label htmlFor={`${id}-from`}>From</label>
              <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field inline">
              <label htmlFor={`${id}-to`}>Through</label>
              <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)}
                aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
            </div>
          </div>
          {canExport && (
            <div className="export rep-export">
              <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? "Exporting…" : "Export CSV"}
              </button>
              <small className="hint">Up to {EXPORT_ROW_CAP.toLocaleString("en-US")} rows for your export scope. No contact details are included.</small>
            </div>
          )}
          {invalid && <p id={`${id}-range`} className="error rep-msg" role="alert">Choose a start date on or before the end date.</p>}
          {run.isError ? (
            <p className="error rep-msg" role="alert">
              {run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.") : employmentError(run.error)}
            </p>
          ) : run.data ? (
            <p className="muted rep-msg" role="status">
              {run.data.truncated ? `Exported the first ${run.data.rows.toLocaleString("en-US")} rows (the export limit). Choose a shorter period for the rest.`
                : `Exported ${run.data.rows.toLocaleString("en-US")} ${run.data.rows === 1 ? "row" : "rows"}.`}
            </p>
          ) : null}
        </form>

        {invalid ? <h2 id={`${id}-je`} className="sr-only">Joinings and exits</h2> : q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={employmentError(q.error)} />
        ) : d ? (
          <div className="rep-body" aria-busy={q.isFetching || undefined}>
            <div className="ins-head">
              <h2 id={`${id}-je`}>Joinings and exits<span className="rep-range">{fmtDate(d.from)} – {fmtDate(d.to)}</span></h2>
            </div>
            <ul className="ins-tiles rep-tiles" aria-label="Joinings and exits totals">
              <li>
                <span className="tilelabel">Joinings</span><span className="tilevalue">{d.totals.joinings}</span>
                <span className="ins-sub">{d.totals.firstPlacements} first {d.totals.firstPlacements === 1 ? "placement" : "placements"}</span>
              </li>
              {d.totals.firstAssignments !== undefined && (
                <li>
                  <span className="tilelabel">First assignments</span><span className="tilevalue">{d.totals.firstAssignments}</span>
                  <span className="ins-sub">{d.totals.laterAssignments ?? 0} later {(d.totals.laterAssignments ?? 0) === 1 ? "assignment" : "assignments"}</span>
                </li>
              )}
              <li className="rep-exits">
                <span className="tilelabel">Exits</span><span className="tilevalue">{d.totals.exits}</span>
                {reasons.length > 0 ? (
                  <dl className="rep-reasons" aria-label="Exits by reason">
                    {reasons.map(([k, v]) => (
                      <div key={k} className={v === 0 ? "zero" : undefined}><dt>{employmentLabel(k)}</dt><dd>{v}</dd></div>
                    ))}
                  </dl>
                ) : <span className="ins-sub">Assignments that ended</span>}
              </li>
            </ul>

            {(d.byTeam.length > 0 || (d.byCompany?.length ?? 0) > 0) && (
              <div className="rep-pair">
                {d.byTeam.length > 0 && (
                  <section className="rep-table" aria-labelledby={`${id}-team`}>
                    <h3 id={`${id}-team`}>By team</h3>
                    <div className="card tablewrap listcard">
                      <table className="rep-compact" aria-label="By team">
                        <thead><tr><th scope="col">Team</th><th scope="col" className="num">Joinings</th><th scope="col" className="num">Exits</th></tr></thead>
                        <tbody>
                          {d.byTeam.map((g) => (
                            <tr key={g.team?.id ?? "none"}>
                              <td className="c-primary">{g.team ? <b>{g.team.name}</b> : <span className="muted">No team</span>}</td>
                              <td className="num" data-label="Joinings">{g.joinings}</td><td className="num" data-label="Exits">{g.exits}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                {(d.byCompany?.length ?? 0) > 0 && (
                  <section className="rep-table" aria-labelledby={`${id}-co`}>
                    <h3 id={`${id}-co`}>By payroll company</h3>
                    <div className="card tablewrap listcard">
                      <table className="rep-compact" aria-label="By payroll company">
                        <thead><tr><th scope="col">Payroll company</th><th scope="col" className="num">Joinings</th><th scope="col" className="num">First / later</th><th scope="col" className="num">Exits</th></tr></thead>
                        <tbody>
                          {d.byCompany!.map((g) => (
                            <tr key={g.company?.id ?? "none"}>
                              <td className="c-primary">{g.company ? <b>{g.company.name}</b> : <span className="muted">Not set</span>}</td>
                              <td className="num" data-label="Joinings">{g.joinings}</td>
                              <td className="num" data-label="First / later assignments">{g.firstAssignments} / {g.laterAssignments}</td>
                              <td className="num" data-label="Exits">{g.exits}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            )}

            <section className="rep-table" aria-labelledby={`${id}-ev`}>
              <h3 id={`${id}-ev`}>Events <span className="ins-count">{d.items.length}</span></h3>
              <div className="card tablewrap listcard">
                <table className="dtable rep-events" aria-label="Joinings and exits">
                  <thead><tr><th scope="col">Candidate</th><th scope="col">Event</th><th scope="col">Date</th><th scope="col">Client</th><th scope="col">Team / recruiter</th>
                    <th scope="col">Location</th><th scope="col">Technology</th><th scope="col">Payroll company</th><th scope="col">End reason</th></tr></thead>
                  <tbody>
                    {d.items.map((i) => (
                      <tr key={`${i.kind}-${i.assignmentId}`}>
                        <td className="c-primary">{i.candidate.name ? <b>{i.candidate.name}</b> : <span className="muted">Name hidden</span>}
                          {i.assignmentNo > 1 && <span className="block muted">Assignment {i.assignmentNo}</span>}</td>
                        <td className="c-badge rep-event"><span className={`badge ${i.kind === "joining" ? "st-joined" : "st-backout"}`}>{i.kind === "joining" ? "Joining" : "Exit"}</span>
                          {i.kind === "joining" && i.isFirstPlacement && <>{" "}<span className="badge first">First placement</span></>}
                          {i.isFirstAssignment === false && <span className="block muted">Later assignment</span>}</td>
                        <td className="rep-date" data-label="Date">{fmtDate(i.date)}</td>
                        <td data-label="Client">{i.client ?? <span className="muted">—</span>}</td>
                        <td data-label="Team / recruiter">{i.team?.name ?? "—"}{i.recruiter && <span className="block muted">{i.recruiter}</span>}</td>
                        <td data-label="Location">{i.location ?? "—"}</td>
                        <td data-label="Technology">{i.technology ?? "—"}</td>
                        <td data-label="Payroll company">{i.payrollCompany?.name ?? "—"}</td>
                        <td data-label="End reason">{i.endReason ? employmentLabel(i.endReason) : "—"}</td>
                      </tr>
                    ))}
                    {d.items.length === 0 && <tr><td colSpan={9} className="empty">No joinings or exits in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
              {d.truncated && <p className="muted" role="status">Showing the first {d.items.length.toLocaleString("en-US")} rows. Choose a shorter period to see the rest.</p>}
            </section>
          </div>
        ) : null}
      </section>

      <ActiveEmployeesReport />
    </div>
  );
}
