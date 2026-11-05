import { useId } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLookups } from "../lookups";
import { fmtDate } from "../sales/ui";
import { useSearchParams } from "../lib/router";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { RecordLink } from "../ui/RecordLink";
import {
  FUNNEL, PIPELINE_STAGES, STAGE_LABELS, pvApi, pvError, pvKeys, type PipelineFilters, type PipelineItem,
} from "./pipelineReportApi";
import { pipelineLabel } from "../pipeline/pipelineApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import "../pipeline/pipeline.css";
import "./pipelinereport.css";

const PAGE = 50;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PARAMS = ["from", "to", "technologyId", "locationId", "stage", "notResponding", "offset"] as const;

/**
 * Candidate pipeline (docs/pipeline-vendors-api.md PV-1, PV-2): marketing start →
 * submissions → interviews → assessments → confirmation → paperwork → joining,
 * one row per candidate the caller's reports cover. Filters and the page are in the URL,
 * so opening a candidate and coming back keeps the view.
 */
export function PipelineReportPage({ onOpenCandidate }: { onOpenCandidate?: (id: string) => void }) {
  const id = useId();
  const lookups = useLookups();
  const [url, setUrl] = useSearchParams(PARAMS);
  const from = ISO_DAY.test(url.from) ? url.from : "";
  const to = ISO_DAY.test(url.to) ? url.to : "";
  const { technologyId, locationId } = url;
  const stage = (PIPELINE_STAGES as readonly string[]).includes(url.stage) ? url.stage : "";
  const notResponding = url.notResponding === "true";
  const offset = Math.max(0, Number(url.offset) || 0);
  const usePeriod = Boolean(from || to);
  const invalid = usePeriod && (!from || !to || from > to);
  // Any filter change goes back to the first page.
  const patch = (p: Partial<Record<(typeof PARAMS)[number], string>>) => setUrl({ offset: "", ...p });
  const filters: PipelineFilters = {
    ...(usePeriod ? { from, to } : {}),
    technologyId: technologyId || undefined, locationId: locationId || undefined, stage: stage || undefined,
    notResponding: notResponding || undefined, limit: PAGE, offset,
  };
  const q = useQuery({
    queryKey: pvKeys.report(filters), queryFn: () => pvApi.report(filters), enabled: !invalid, placeholderData: keepPreviousData,
  });
  const d = q.data;
  const techs = lookups.data?.technologies ?? [];
  const locs = lookups.data?.locations ?? [];
  const chips: FilterChip[] = [];
  if (notResponding) chips.push({ key: "nr", label: "Not responding only", onRemove: () => patch({ notResponding: "" }) });
  const hasFilters = Boolean(from || to || technologyId || locationId || stage || notResponding);
  const activeCount = [from || to, technologyId, locationId, stage, notResponding].filter(Boolean).length;
  const clear = () => setUrl({ from: "", to: "", technologyId: "", locationId: "", stage: "", notResponding: "", offset: "" });

  return (
    <section className="panel pr-page">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Candidate pipeline{d && !q.isLoading && <span className="h1count" aria-hidden="true">{d.total.toLocaleString("en-US")}</span>}</h1>
          <p className="sub">Where each candidate is: marketing, submissions, interviews, assessments, confirmation, paperwork and joining.
            Only the candidates your reports cover are listed.</p>
        </div>
      </div>

      <FilterBar label="Pipeline filters" hasFilters={hasFilters} onClear={clear} chips={chips} moreCount={0} activeCount={activeCount}
        primary={<>
          <div className="field inline fb-status">
            <label htmlFor={`${id}-stage`}>Stage</label>
            <select id={`${id}-stage`} value={stage} onChange={(e) => patch({ stage: e.target.value })}>
              <option value="">All stages{d ? ` · ${d.total}` : ""}</option>
              {PIPELINE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}{d && !stage ? ` · ${d.byStage[s] ?? 0}` : ""}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-tech`}>Technology</label>
            <select id={`${id}-tech`} value={technologyId} onChange={(e) => patch({ technologyId: e.target.value })}>
              <option value="">All</option>
              {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-loc`}>Location</label>
            <select id={`${id}-loc`} value={locationId} onChange={(e) => patch({ locationId: e.target.value })}>
              <option value="">All</option>
              {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field inline pr-date">
            <label htmlFor={`${id}-from`}>Period from</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => patch({ from: e.target.value })} />
          </div>
          <div className="field inline pr-date">
            <label htmlFor={`${id}-to`}>Through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => patch({ to: e.target.value })}
              aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-range` : undefined} />
          </div>
        </>}
      />
      {invalid && <p id={`${id}-range`} className="error" role="alert">Choose both dates, with the start on or before the end. Leave both empty for all time.</p>}

      {invalid ? null : q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={pvError(q.error)} />
      ) : d ? (
        <section aria-labelledby={`${id}-h`} aria-busy={q.isFetching || undefined} className="pr-page">
          <h2 id={`${id}-h`} className="pr-total">{d.total.toLocaleString("en-US")} {d.total === 1 ? "candidate" : "candidates"}
            {d.period ? `, ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}` : ", all time"}</h2>
          <div className="pr-funnelrow">
            {/* Stages reached: a count, not a filter (the Stage filter is the candidate's current stage). */}
            <ul className="pr-funnel" aria-label="Pipeline funnel">
              {FUNNEL.map(([k, label]) => (
                <li key={k}><span className="tilelabel">{label}</span><span className="tilevalue">{d.funnel[k]}</span></li>
              ))}
            </ul>
            <button type="button" className="pr-nrtile" aria-pressed={notResponding} aria-label="Not responding only"
              onClick={() => patch({ notResponding: notResponding ? "" : "true" })}>
              <span className="tilelabel">Not responding</span><span className="tilevalue">{d.notResponding}</span>
              <span className="tilehint">{notResponding ? "Showing only these · clear" : "Open flags · show only these"}</span>
            </button>
          </div>

          <div className="card tablewrap listcard">
            <table className="dtable pr-table" aria-label="Candidate pipeline">
              <thead>
                <tr><th>Candidate</th><th>Stage</th><th>Marketing start</th><th>Activity</th>
                  <th>Placement</th><th className="p2">Team / recruiter</th></tr>
              </thead>
              <tbody>
                {d.items.map((i) => <Row key={i.candidate.id} i={i} onOpen={onOpenCandidate} />)}
                {d.items.length === 0 && <tr><td colSpan={6} className="empty">No candidates match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.total > PAGE && (
            <nav className="pager" aria-label="Candidate pages">
              <button type="button" disabled={offset === 0} onClick={() => setUrl({ offset: offset - PAGE > 0 ? String(offset - PAGE) : "" })}><ChevronLeft size={15} aria-hidden="true" />Previous</button>
              <span className="muted pr-range">{offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
              <button type="button" disabled={offset + PAGE >= d.total} onClick={() => setUrl({ offset: String(offset + PAGE) })}>Next<ChevronRight size={15} aria-hidden="true" /></button>
            </nav>
          )}
        </section>
      ) : null}
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const latest = (...ds: (string | null)[]) => ds.filter(Boolean).sort().at(-1) ?? null;

function Row({ i, onOpen }: { i: PipelineItem; onOpen?: (id: string) => void }) {
  const name = i.candidate.name ?? "Candidate";
  const quiet = !i.submissions.count && !i.interviews.count && !i.assessments.count;
  const last = latest(i.submissions.lastAt, i.interviews.lastAt, i.assessments.lastOn);
  return (
    <tr>
      <td className="c-primary">
        <RecordLink kind="candidate" id={i.candidate.id} onOpen={onOpen}><b>{name}</b></RecordLink>
        <small className="block muted">{i.technology.name ?? ""}{i.location.name ? ` · ${i.location.name}` : ""}</small>
        {i.notResponding && <span className="badge st-backout pr-nr">Not responding</span>}
      </td>
      <td className="c-badge" data-label="Stage"><span className={`badge st-${i.stage}`}>{STAGE_LABELS[i.stage]}</span></td>
      <td data-label="Marketing start" className="pl-nowrap">{i.marketingStartDate ? fmtDate(i.marketingStartDate) : <span className="muted">—</span>}</td>
      <td data-label="Activity" className={quiet ? "muted" : undefined}>
        {quiet ? <span>No submissions, interviews or assessments yet</span> : (
          <span>
            {plural(i.submissions.count, "submission")} · {plural(i.interviews.count, "interview")}{i.interviews.count ? ` (${i.interviews.cleared} cleared)` : ""}
            {i.assessments.count ? ` · ${plural(i.assessments.count, "assessment")} (${i.assessments.passed} passed)` : ""}
            {last && <small className="block muted">Last activity {fmtDate(last)}</small>}
          </span>
        )}
      </td>
      <td data-label="Placement">
        {i.placement ? (
          <span>
            <span className={`badge st-${i.placement.status}`}>{i.placement.status === "bgc" ? "Background check" : pipelineLabel(i.placement.status)}</span>
            <small className="block muted">
              {i.placement.joinedAt ? `Joined ${fmtDate(i.placement.joinedAt)}` : `Start ${fmtDate(i.placement.tentativeStart)}`}
            </small>
            {i.placement.paperwork && <small className="block muted">Paperwork {i.placement.paperwork.done}/{i.placement.paperwork.total}</small>}
          </span>
        ) : <span className="muted">—</span>}
      </td>
      <td className="p2" data-label="Team"><span>{i.team.name ?? "—"}<small className="block muted">{i.recruiter?.name ?? "Unassigned"}</small></span></td>
    </tr>
  );
}
