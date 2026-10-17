import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLookups } from "../lookups";
import { fmtDate } from "../sales/ui";
import { localToday, shiftDays } from "../employees/employeesApi";
import {
  FUNNEL, PIPELINE_STAGES, STAGE_LABELS, pvApi, pvError, pvKeys, type PipelineFilters, type PipelineItem,
} from "./pipelineReportApi";
import { QueryError } from "../ui/QueryError";

const PAGE = 50;

/**
 * Candidate pipeline (docs/pipeline-vendors-api.md PV-1, PV-2): marketing start →
 * submissions → interviews → assessments → confirmation → paperwork → joining,
 * one row per candidate the caller's reports cover.
 */
export function PipelineReportPage({ onOpenCandidate }: { onOpenCandidate?: (id: string) => void }) {
  const id = useId();
  const lookups = useLookups();
  const today = localToday();
  const [usePeriod, setUsePeriod] = useState(false);
  const [from, setFrom] = useState(shiftDays(today, -30));
  const [to, setTo] = useState(today);
  const [technologyId, setTechnologyId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [stage, setStage] = useState("");
  const [notResponding, setNotResponding] = useState(false);
  const [offset, setOffset] = useState(0);
  const invalid = usePeriod && (!from || !to || from > to);
  const filters: PipelineFilters = {
    ...(usePeriod ? { from, to } : {}),
    technologyId: technologyId || undefined, locationId: locationId || undefined, stage: stage || undefined,
    notResponding: notResponding || undefined, limit: PAGE, offset,
  };
  const q = useQuery({
    queryKey: pvKeys.report(filters), queryFn: () => pvApi.report(filters), enabled: !invalid, placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };
  const d = q.data;

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Candidate pipeline</h1>
        <p className="sub">Where each candidate is: marketing, submissions, interviews, assessments, confirmation, paperwork and joining.
          Only the candidates your reports cover are listed.</p>
      </div>

      <form className="filters" aria-label="Pipeline filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <label className="check"><input type="checkbox" checked={usePeriod} onChange={(e) => reset(setUsePeriod)(e.target.checked)} /> Limit to a period</label>
          {usePeriod && (
            <>
              <div className="field inline">
                <label htmlFor={`${id}-from`}>From</label>
                <input id={`${id}-from`} type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
              </div>
              <div className="field inline">
                <label htmlFor={`${id}-to`}>Through</label>
                <input id={`${id}-to`} type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)}
                  aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
              </div>
            </>
          )}
          <div className="field inline">
            <label htmlFor={`${id}-tech`}>Technology</label>
            <select id={`${id}-tech`} value={technologyId} onChange={(e) => reset(setTechnologyId)(e.target.value)}>
              <option value="">All</option>
              {(lookups.data?.technologies ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-loc`}>Location</label>
            <select id={`${id}-loc`} value={locationId} onChange={(e) => reset(setLocationId)(e.target.value)}>
              <option value="">All</option>
              {(lookups.data?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-stage`}>Stage</label>
            <select id={`${id}-stage`} value={stage} onChange={(e) => reset(setStage)(e.target.value)}>
              <option value="">All</option>
              {PIPELINE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
          </div>
          <label className="check"><input type="checkbox" checked={notResponding} onChange={(e) => reset(setNotResponding)(e.target.checked)} /> Not responding only</label>
        </div>
        {invalid && <p id={`${id}-range`} className="error" role="alert">Choose a start date on or before the end date.</p>}
      </form>

      {invalid ? null : q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <QueryError query={q} message={pvError(q.error)} />
      ) : d ? (
        <section aria-labelledby={`${id}-h`} aria-busy={q.isFetching || undefined}>
          <h2 id={`${id}-h`}>{d.total.toLocaleString("en-US")} {d.total === 1 ? "candidate" : "candidates"}
            {d.period ? `, ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}` : ""}</h2>
          <ul className="tiles" aria-label="Pipeline funnel">
            {FUNNEL.map(([k, label]) => (
              <li key={k} className="tile card"><span className="tilelabel">{label}</span><span className="tilevalue">{d.funnel[k]}</span></li>
            ))}
            <li className="tile card"><span className="tilelabel">Not responding</span><span className="tilevalue">{d.notResponding}</span>
              <span className="tilehint">Open flags</span></li>
          </ul>

          <div className="card tablewrap">
            <table aria-label="Candidate pipeline">
              <thead>
                <tr><th>Candidate</th><th>Stage</th><th>Marketing start</th><th>Submissions</th><th>Interviews</th>
                  <th>Assessments</th><th>Placement</th><th>Team / recruiter</th></tr>
              </thead>
              <tbody>
                {d.items.map((i) => <Row key={i.candidate.id} i={i} onOpen={onOpenCandidate} />)}
                {d.items.length === 0 && <tr><td colSpan={8} className="empty">No candidates match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.total > PAGE && (
            <div className="rowactions" role="group" aria-label="Pages">
              <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <span className="muted">{offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
              <button type="button" className="btn sm" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

function Row({ i, onOpen }: { i: PipelineItem; onOpen?: (id: string) => void }) {
  const name = i.candidate.name ?? "Candidate";
  return (
    <tr>
      <td>
        {onOpen ? <button type="button" className="linkbtn" onClick={() => onOpen(i.candidate.id)}>{name}</button> : name}
        <span className="block muted">{i.technology.name ?? ""}{i.location.name ? ` · ${i.location.name}` : ""}</span>
        {i.notResponding && <span className="badge st-backout">Not responding</span>}
      </td>
      <td><span className={`badge st-${i.stage}`}>{STAGE_LABELS[i.stage]}</span></td>
      <td>{fmtDate(i.marketingStartDate)}</td>
      <td>{i.submissions.count}{i.submissions.lastAt && <span className="block muted">Last {fmtDate(i.submissions.lastAt)}</span>}</td>
      <td>{i.interviews.count}<span className="block muted">{i.interviews.cleared} cleared</span></td>
      <td>{i.assessments.count}<span className="block muted">{i.assessments.passed} passed</span></td>
      <td>
        {i.placement ? (
          <>
            <span className={`badge st-${i.placement.status}`}>{i.placement.status === "bgc" ? "Background check" : i.placement.status.replace("_", " ")}</span>
            <span className="block muted">
              {i.placement.joinedAt ? `Joined ${fmtDate(i.placement.joinedAt)}` : `Start ${fmtDate(i.placement.tentativeStart)}`}
            </span>
            {i.placement.paperwork && <span className="block muted">Paperwork {i.placement.paperwork.done}/{i.placement.paperwork.total}</span>}
          </>
        ) : "—"}
      </td>
      <td>{i.team.name ?? "—"}<span className="block muted">{i.recruiter?.name ?? "Unassigned"}</span></td>
    </tr>
  );
}
