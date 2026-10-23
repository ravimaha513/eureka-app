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
      <td>{c.candidates}</td><td>{c.inMarket}</td><td>{c.placed}</td>
      {withPeriod && <td>{c.placedInPeriod ?? 0}</td>}
      {d!.statuses.map((s) => <td key={s}>{c.byStatus[s] ?? 0}</td>)}
    </>
  );

  return (
    <>
      <p className="sub">Candidates in market and placed right now, for the candidates in your scope. Use “Placed between” to count joinings in a period.</p>
      <form className="filters" aria-label="Market report options" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label>Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as MarketReportGroup)}>
                {MARKET_REPORT_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
              </select>
            </label>
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
            <button type="button" className="btn sm" onClick={() => { setPlacedFrom(""); setPlacedTo(""); }}>Clear dates</button>
          )}
          {canExport && (
            <div className="export">
              <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? "Exporting…" : "Export CSV"}
              </button>
              <small className="hint">Counts per group for your export scope. No names or contact details are included.</small>
            </div>
          )}
        </div>
        {invalid && <p id={`${id}-range`} className="error" role="alert">Choose a start date on or before the end date.</p>}
        {run.isError ? (
          <p className="error" role="alert">
            {run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.") : employmentError(run.error)}
          </p>
        ) : run.data ? (
          <p className="muted" role="status">Exported {run.data.rows.toLocaleString("en-US")} {run.data.rows === 1 ? "group" : "groups"} and a total.</p>
        ) : null}
      </form>

      {!invalid && (q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={employmentError(q.error)} />
      ) : d ? (
        <section aria-labelledby={`${id}-mk`} aria-busy={q.isFetching || undefined}>
          <h2 id={`${id}-mk`}>Market by {GROUP_LABELS[d.groupBy].toLowerCase()}</h2>
          <p className="muted">Counts as of {new Date(d.asOf).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
            {" "}In market: {d.inMarketStatuses.map(statusLabel).join(", ")}. Placed: joined and on a project.</p>
          <ul className="tiles">
            <li className="tile card"><span className="tilelabel">Candidates</span><span className="tilevalue">{d.totals.candidates}</span></li>
            <li className="tile card"><span className="tilelabel">In market</span><span className="tilevalue">{d.totals.inMarket}</span></li>
            <li className="tile card"><span className="tilelabel">Placed (on project)</span><span className="tilevalue">{d.totals.placed}</span></li>
            {withPeriod && (
              <li className="tile card"><span className="tilelabel">Placed in period</span><span className="tilevalue">{d.totals.placedInPeriod ?? 0}</span>
                <span className="tilehint">Joined {periodText}</span></li>
            )}
          </ul>
          <div className="card tablewrap">
            <table aria-label={`Market by ${GROUP_LABELS[d.groupBy].toLowerCase()}`}>
              <thead>
                <tr>
                  <th scope="col">{GROUP_LABELS[d.groupBy]}</th><th scope="col">Candidates</th><th scope="col">In market</th><th scope="col">Placed (on project)</th>
                  {withPeriod && <th scope="col">Placed {periodText}</th>}
                  {d.statuses.map((s) => <th key={s} scope="col">{statusLabel(s)}</th>)}
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
      ) : null)}
    </>
  );
}
