import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { MARKET_REPORT_GROUPS, type MarketReportGroup } from "@eureka/shared";
import { ApiError } from "../api";
import { fmtDate } from "../sales/ui";
import { statusLabel } from "../sales/salesApi";
import { employmentError } from "./employeesApi";
import { GROUP_LABELS, NO_VALUE, marketKeys, marketReportApi, type MarketCounts, type MarketFilters } from "./marketReportApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import "../dashboard/insights.css";
import "../dashboard/reports.css";

/**
 * Reports > Market (gap L3, docs/market-reports-api.md): how many candidates
 * are in market and placed right now, per technology, batch, location, team,
 * lead or recruiter, with an optional "placed between" count for planning the
 * next batches. Counts only; the server scopes them (report.market:read) and
 * audits the export (report:export).
 */
export function MarketReportPanel({ canExport, onDownload }: { canExport: boolean; onDownload: (blob: Blob, filename: string) => void }) {
  const id = useId();
  const [groupBy, setGroupBy] = useState<MarketReportGroup>("technology");
  const [placedFrom, setPlacedFrom] = useState("");
  const [placedTo, setPlacedTo] = useState("");
  const invalid = placedFrom !== "" && placedTo !== "" && placedFrom > placedTo;
  const filters: MarketFilters = { groupBy, placedFrom: placedFrom || undefined, placedTo: placedTo || undefined };
  const q = useQuery({
    queryKey: marketKeys.report(filters),
    queryFn: () => marketReportApi.get(filters),
    enabled: !invalid,
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: () => marketReportApi.exportCsv(filters),
    onSuccess: (r) => onDownload(r.blob, r.filename),
  });
  const d = q.data;
  const withPeriod = d?.placedBetween != null;
  const periodText = d?.placedBetween
    ? d.placedBetween.from && d.placedBetween.to ? `${fmtDate(d.placedBetween.from)} – ${fmtDate(d.placedBetween.to)}`
      : d.placedBetween.from ? `since ${fmtDate(d.placedBetween.from)}` : `through ${fmtDate(d.placedBetween.to)}`
    : "";
  const cells = (c: MarketCounts) => (
    <>
      <td className="num">{c.candidates}</td><td className="num">{c.inMarket}</td><td className="num">{c.placed}</td>
      {withPeriod && <td className="num">{c.placedInPeriod ?? 0}</td>}
      {d!.statuses.map((s) => <td key={s} className="num">{c.byStatus[s] ?? 0}</td>)}
    </>
  );

  return (
    <div className="rep-stack">
      <section className="rep-block" aria-labelledby={`${id}-mk`}>
        <p className="sub rep-intro">Candidates in market and placed right now, for the candidates in your scope. Use “Placed between” to count joinings in a period.</p>
        <form className="ins-period rep-filters" aria-label="Market report options" onSubmit={(e) => e.preventDefault()}>
          <div className="ins-dates">
            <div className="field inline">
              <label htmlFor={`${id}-g`}>Group by</label>
              <select id={`${id}-g`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as MarketReportGroup)}>
                {MARKET_REPORT_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
              </select>
            </div>
            <div className="field inline">
              <label htmlFor={`${id}-pf`}>Placed from</label>
              <input id={`${id}-pf`} type="date" value={placedFrom} onChange={(e) => setPlacedFrom(e.target.value)} />
            </div>
            <div className="field inline">
              <label htmlFor={`${id}-pt`}>Placed through</label>
              <input id={`${id}-pt`} type="date" value={placedTo} onChange={(e) => setPlacedTo(e.target.value)}
                aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
            </div>
            {(placedFrom || placedTo) && (
              <button type="button" className="btn rep-cleardates" onClick={() => { setPlacedFrom(""); setPlacedTo(""); }}>Clear dates</button>
            )}
          </div>
          {canExport && (
            <div className="export rep-export">
              <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? "Exporting…" : "Export CSV"}
              </button>
              <small className="hint">Counts per group for your export scope. No names or contact details are included.</small>
            </div>
          )}
          {invalid && <p id={`${id}-range`} className="error rep-msg" role="alert">Choose a start date on or before the end date.</p>}
          {run.isError ? (
            <p className="error rep-msg" role="alert">
              {run.error instanceof ApiError && run.error.status === 429 ? run.error.message : employmentError(run.error)}
            </p>
          ) : run.data ? (
            <p className="muted rep-msg" role="status">Exported {run.data.rows.toLocaleString("en-US")} {run.data.rows === 1 ? "group" : "groups"} and a total.</p>
          ) : null}
        </form>

        {invalid ? <h2 id={`${id}-mk`} className="sr-only">Market</h2> : q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={employmentError(q.error)} />
        ) : d ? (
          <div className="rep-body" aria-busy={q.isFetching || undefined}>
            <div className="ins-head">
              <h2 id={`${id}-mk`}>Market by {GROUP_LABELS[d.groupBy].toLowerCase()}</h2>
              <span className="muted">Counts as of {new Date(d.asOf).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
            <ul className="ins-tiles rep-tiles" aria-label="Market totals">
              <li><span className="tilelabel">Candidates</span><span className="tilevalue">{d.totals.candidates}</span><span className="ins-sub">In your scope</span></li>
              <li><span className="tilelabel">In market</span><span className="tilevalue">{d.totals.inMarket}</span><span className="ins-sub">{d.inMarketStatuses.map(statusLabel).join(", ")}</span></li>
              <li><span className="tilelabel">Placed (on project)</span><span className="tilevalue">{d.totals.placed}</span><span className="ins-sub">Joined and on a project</span></li>
              {withPeriod && (
                <li><span className="tilelabel">Placed in period</span><span className="tilevalue">{d.totals.placedInPeriod ?? 0}</span>
                  <span className="ins-sub">Joined {periodText}</span></li>
              )}
            </ul>
            <section className="rep-table" aria-labelledby={`${id}-mt`}>
              <h3 id={`${id}-mt`}>By {GROUP_LABELS[d.groupBy].toLowerCase()} <span className="ins-count">{d.groups.length}</span></h3>
              <div className="card tablewrap listcard rep-market">
                <table aria-label={`Market by ${GROUP_LABELS[d.groupBy].toLowerCase()}`}>
                  <thead>
                    <tr>
                      <th scope="col">{GROUP_LABELS[d.groupBy]}</th><th scope="col" className="num">Candidates</th><th scope="col" className="num">In market</th><th scope="col" className="num">Placed (on project)</th>
                      {withPeriod && <th scope="col" className="num">Placed {periodText}</th>}
                      {d.statuses.map((s) => <th key={s} scope="col" className="num">{statusLabel(s)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.groups.map((g) => (
                      <tr key={g.id ?? "none"}>
                        <th scope="row">{g.id === null ? <span className="muted">{NO_VALUE[d.groupBy]}</span> : g.name ?? <span className="muted">Not visible</span>}</th>
                        {cells(g)}
                      </tr>
                    ))}
                    {d.groups.length === 0 && <tr><td colSpan={4 + (withPeriod ? 1 : 0) + d.statuses.length} className="empty">No candidates in your scope.</td></tr>}
                  </tbody>
                  {d.groups.length > 0 && (
                    <tfoot><tr><th scope="row">Total</th>{cells(d.totals)}</tr></tfoot>
                  )}
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}
