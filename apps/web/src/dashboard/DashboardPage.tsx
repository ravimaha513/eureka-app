import { useId, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, Minus, SlidersHorizontal, X } from "lucide-react";
import { PALETTE } from "../ui/Charts";
import { DailyTrend } from "./DailyTrend";
import { pipelineError } from "../pipeline/errors";
import { saveBlob } from "../lib/download";
import { pipelineLabel } from "../pipeline/pipelineApi";
import { fmtDate } from "../sales/ui";
import {
  GROUP_LABELS, METRICS, METRIC_HINTS, METRIC_LABELS, PERIODS, UNGROUPED,
  dashboardApi, periodRange, type AttentionItem, type AttentionKind, type Dashboard, type GroupBy, type Metric,
} from "./dashboardApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import { Dialog } from "../ui/Dialog";
import { PeriodPresets } from "./PeriodPresets";
import "./insights.css";
import "./dashboard.css";

/** Where a "needs attention" row can be opened. */
export type DashboardTarget = "submissions" | "interviews" | "placements";

const TARGET: Record<AttentionKind, DashboardTarget> = {
  submissionStale: "submissions",
  interviewFeedbackMissing: "interviews",
  placementStalled: "placements",
};

const TARGET_LABEL: Record<DashboardTarget, string> = { submissions: "Submissions", interviews: "Interviews", placements: "Placements" };

/** A local calendar day for an instant (period bounds are local midnights). */
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Pipeline order for the stage counts. */
const STAGES: Metric[] = ["submissions", "interviewsScheduled", "interviewsCleared", "placementsCreated", "placementsJoined"];

/** One colour per metric, everywhere on the page (tile swatch, legend, trend line, stage bar). */
const METRIC_COLOR = Object.fromEntries(METRICS.map((m, i) => [m, PALETTE[i % PALETTE.length]!])) as Record<Metric, string>;

/** Rows shown per needs-attention list before "Show all". */
const ATTENTION_ROWS = 5;

/**
 * Change against the period just before this one. Absolute and percent, so a small base cannot
 * inflate ("+4 (+200%)"); a zero base says so ("New · prev 0") instead of an unbounded percent.
 */
export function Delta({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined) return <span className="ins-sub" />;
  if (now === before) return <span className="ins-sub dash-delta flat"><Minus size={13} aria-hidden="true" />No change</span>;
  const diff = now - before;
  const sign = diff > 0 ? "+" : "−";
  if (before === 0) {
    return <span className="ins-sub dash-delta flat">New<span aria-hidden="true">·</span>prev 0</span>;
  }
  const pct = Math.round((Math.abs(diff) / before) * 100);
  const up = diff > 0;
  return (
    <span className={`ins-sub dash-delta ${up ? "up" : "down"}`}>
      {up ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
      {sign}{Math.abs(diff)} <span className="dash-pct">({sign}{pct}%)</span>
    </span>
  );
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** "Oct 29 – Nov 4, 2026" for a period whose `to` is the exclusive next midnight. */
function fmtRange(from: string, to: string): string {
  const a = new Date(Date.parse(from)), b = new Date(Date.parse(to) - 1);
  const sameYear = a.getFullYear() === b.getFullYear();
  const start = a.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  const end = b.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${start} – ${end}`;
}

/** Bring a section into view and move focus to it. */
function jumpTo(elementId: string) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.scrollIntoView?.({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

/**
 * Small-screen filters: a bottom sheet with the period and grouping. Choices are a
 * draft until Apply, so the page does not refetch on every tap.
 */
function FilterSheet({ periodDays, groupBy, onApply, onClose }: {
  periodDays: number; groupBy: GroupBy;
  onApply: (periodDays: number, groupBy: GroupBy) => void; onClose: () => void;
}) {
  const id = useId();
  const [p, setP] = useState(periodDays);
  const [g, setG] = useState<GroupBy>(groupBy);
  return (
    <Dialog title="Filters" onClose={onClose} className="sheet">
      <button type="button" className="sheetclose" aria-label="Close filters" onClick={onClose}><X size={20} aria-hidden="true" /></button>
      <div className="sheetbody">
        <div className="chipfilter">
          <span id={`${id}-period`} className="chiplabel">Period</span>
          <div className="tabs wrap" role="group" aria-labelledby={`${id}-period`}>
            {PERIODS.map((x) => (
              <button key={x.days} type="button" className="tab" aria-pressed={p === x.days} onClick={() => setP(x.days)}>{x.label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-group`}>Group by</label>
          <select id={`${id}-group`} value={g} onChange={(e) => setG(e.target.value as GroupBy)}>
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((k) => <option key={k} value={k}>{GROUP_LABELS[k]}</option>)}
          </select>
        </div>
      </div>
      <div className="sheetfoot">
        <button type="button" className="btn" onClick={() => { setP(PERIODS[0].days); setG(groupBy); }}>Reset</button>
        <button type="button" className="btn primary" onClick={() => { onApply(p, g); onClose(); }}>Apply</button>
      </div>
    </Dialog>
  );
}

const ATTENTION: Record<AttentionKind, { title: string; explain: (t: Dashboard["needsAttention"]["thresholds"]) => string; empty: string }> = {
  submissionStale: {
    title: "Stale submissions",
    explain: (t) => `Open submissions with no status change for ${days(t.staleSubmissionDays)} or more.`,
    empty: "No stale submissions.",
  },
  interviewFeedbackMissing: {
    title: "Interviews without feedback",
    explain: (t) => `Interviews that ended over ${t.feedbackGraceHours} hours ago (within the last ${days(t.feedbackLookbackDays)}) with no coach, location or client feedback.`,
    empty: "Every recent interview has feedback.",
  },
  placementStalled: {
    title: "Placements awaiting the next step",
    explain: (t) => `Placements before joining with no status change for ${days(t.placementStallDays)}, or past their tentative start date.`,
    empty: "No placements are waiting.",
  },
};

function detailText(kind: AttentionKind, i: AttentionItem): string {
  switch (kind) {
    case "submissionStale": return [i.detail.client, i.detail.jobTitle].filter(Boolean).join(" · ");
    case "interviewFeedbackMissing": return [i.detail.round, i.detail.client].filter(Boolean).join(" · ");
    case "placementStalled":
      return i.detail.reason === "start_date_passed"
        ? `Tentative start ${fmtDate(i.detail.tentativeStart)} has passed`
        : `Tentative start ${fmtDate(i.detail.tentativeStart)}`;
  }
}

/** One needs-attention list: the oldest rows first, five at a time, each with Open. */
function AttentionList({ id, kind, total, items, thresholds, openable, onOpen }: {
  id: string; kind: AttentionKind; total: number; items: AttentionItem[];
  thresholds: Dashboard["needsAttention"]["thresholds"]; openable: boolean;
  onOpen: (target: DashboardTarget, id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const meta = ATTENTION[kind];
  const target = TARGET[kind];
  const shown = all ? items : items.slice(0, ATTENTION_ROWS);
  return (
    <section className="dash-att" aria-labelledby={`${id}-${kind}`}>
      <div className="dash-atthead">
        <h3 id={`${id}-${kind}`} tabIndex={-1}>{meta.title} <span className="ins-count">{total}</span></h3>
        <p className="muted">{meta.explain(thresholds)}</p>
      </div>
      {items.length === 0 ? <p className="dash-attempty">{meta.empty}</p> : (
        <>
          <div className="tablewrap listcard dash-atttable">
            <table className="dtable" aria-label={meta.title}>
              <thead><tr><th>Candidate</th><th>Details</th><th>Status</th><th>Recruiter</th><th className="num">Waiting</th>
                {openable && <th className="c-act"><span className="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td className="c-primary">{i.candidate.name ? <b>{i.candidate.name}</b> : <span className="muted">Not visible to you</span>}</td>
                    <td className="dash-detail" data-label="Details">{detailText(kind, i) || "—"}</td>
                    <td className="c-badge"><span className={`badge st-${i.status}`}>{pipelineLabel(i.status)}</span></td>
                    <td data-label="Recruiter">{i.recruiter.name ?? "—"}</td>
                    <td className="num" data-label="Waiting">{days(i.ageDays)}</td>
                    {openable && (
                      <td className="c-act">
                        <button type="button" className="btn sm" onClick={() => onOpen(target, i.id)}
                          aria-label={`Open ${i.candidate.name ?? "this item"} in ${TARGET_LABEL[target]}`}>Open</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(items.length > ATTENTION_ROWS || total > items.length) && (
            <div className="dash-attfoot">
              {items.length > ATTENTION_ROWS && (
                <button type="button" className="btn sm" aria-expanded={all} onClick={() => setAll(!all)}>
                  {all ? "Show fewer" : `Show all ${items.length}`}<span className="sr-only"> {meta.title.toLowerCase()}</span>
                </button>
              )}
              {total > items.length && <p className="muted">Showing the oldest {items.length} of {total}.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Role dashboard (GET /api/v1/dashboard): the work that needs attention first, then
 * activity counts for the caller's own scope over a period, by recruiter, team or
 * location. The API decides scope; this page only presents what it returns.
 */
export function DashboardPage({ canOpen = () => false, onOpen, firstName, canExport = false }: {
  firstName?: string;
  /** report:export: offer the sales report CSV (the server checks again). */
  canExport?: boolean;
  canOpen?: (target: DashboardTarget) => boolean;
  onOpen?: (target: DashboardTarget, id: string) => void;
}) {
  const id = useId();
  const [periodDays, setPeriodDays] = useState<number>(PERIODS[0].days);
  const [groupBy, setGroupBy] = useState<GroupBy | undefined>(undefined);
  const range = useMemo(() => periodRange(periodDays), [periodDays]);
  const q = useQuery({
    queryKey: ["dashboard", range, groupBy ?? null],
    queryFn: () => dashboardApi.get({ ...range, groupBy }),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  // The period just before, for the change shown on each tile (same length and grouping).
  const prevRange = useMemo(() => ({ from: new Date(2 * Date.parse(range.from) - Date.parse(range.to)).toISOString(), to: range.from }), [range]);
  const prev = useQuery({
    queryKey: ["dashboard", prevRange, groupBy ?? null],
    queryFn: () => dashboardApi.get({ ...prevRange, groupBy }),
    enabled: Boolean(d),
  });
  const [rankMetric, setRankMetric] = useState<Metric | undefined>(undefined);
  const [plotted, setPlotted] = useState<Metric[] | undefined>(undefined);
  const shownMetric = d && d.metrics.length > 0 ? (rankMetric && d.metrics.includes(rankMetric) ? rankMetric : d.metrics[0]!) : undefined;
  /** Until the user chooses, plot the first three metrics; six lines at once is noise. */
  const plot = d ? (plotted ?? d.metrics.slice(0, 3)).filter((m) => d.metrics.includes(m)) : [];
  const stages = d ? STAGES.filter((m) => d.metrics.includes(m)).map((m) => ({ key: m, label: METRIC_LABELS[m], value: d.totals[m] ?? 0 })) : [];
  const trend = d ? d.series.map((x) => ({ date: x.date, ...Object.fromEntries(d.metrics.map((m) => [m, x.counts[m] ?? 0])) })) as ({ date: string } & Record<string, number | string>)[] : [];
  const shownGroup = d?.groupBy ?? groupBy ?? "recruiter";
  const exportRun = useMutation({
    mutationFn: () => dashboardApi.exportCsv({ ...range, groupBy: d?.groupBy ?? groupBy }),
    onSuccess: (r) => saveBlob(r.blob, r.filename),
  });

  const [sheetOpen, setSheetOpen] = useState(false);
  const rangeText = fmtRange(d?.period.from ?? range.from, d?.period.to ?? range.to);
  const prevGroup = useMemo(() => new Map((prev.data?.groups ?? []).map((g) => [g.id ?? "none", g.counts])), [prev.data]);
  const openTotal = d ? d.needsAttention.sections.reduce((n, s) => n + s.total, 0) : 0;
  const groupWord = d ? GROUP_LABELS[d.groupBy].toLowerCase() : "";

  return (
    <>
      <div className="dashhead">
        <div>
          <h1 tabIndex={-1}>Dashboard</h1>
          <p className="sub">{firstName ? `Welcome back, ${firstName}. ` : ""}Work that needs attention, then activity in your scope.</p>
        </div>

        <form className="dashfilters" role="search" aria-label="Dashboard filters" onSubmit={(e) => e.preventDefault()}>
          <span className="rangepill"><CalendarDays size={16} aria-hidden="true" /><span>{rangeText}</span></span>
          <div className="dashfilters-full">
            <PeriodPresets value={periodDays} onChange={setPeriodDays} />
            <div className="field inline groupselect">
              <label htmlFor={`${id}-group`}>Group by</label>
              <select id={`${id}-group`} value={shownGroup} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="iconbtn dashfilters-btn" aria-label="Filters" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
            <SlidersHorizontal size={18} aria-hidden="true" />
          </button>
          {canExport && (
            <div className="export">
              <button type="button" className="btn" disabled={exportRun.isPending || !d} onClick={() => exportRun.mutate()}>
                {exportRun.isPending ? "Exporting…" : "Export CSV"}
              </button>
              <p role="status" aria-live="polite" className={exportRun.isError ? "error" : "muted"}>
                {exportRun.isError ? pipelineError(exportRun.error, "generic") : exportRun.data ? `Exported ${exportRun.data.rows} ${exportRun.data.rows === 1 ? "row" : "rows"} and a total.` : ""}
              </p>
            </div>
          )}
        </form>
      </div>
      {sheetOpen && (
        <FilterSheet periodDays={periodDays} groupBy={shownGroup} onClose={() => setSheetOpen(false)}
          onApply={(p, g) => { setPeriodDays(p); if (g !== shownGroup) setGroupBy(g); }} />
      )}

      {q.isLoading ? <Loading /> : q.error || !d ? (
        <QueryError query={q} message={pipelineError(q.error, "generic")} />
      ) : (
        <div className="dashboard dash-v2" aria-busy={q.isFetching || undefined}>
          <section className="card dash-attention" aria-labelledby={`${id}-attention`}>
            <div className="ins-head dash-attentionhead">
              <h2 id={`${id}-attention`}>Needs attention {d.needsAttention.sections.length > 0 && <span className="ins-count" aria-label={`${openTotal} open`}>{openTotal}</span>}</h2>
              <span className="muted">Current, not limited to the period</span>
            </div>
            {d.needsAttention.sections.length === 0 && <p className="dash-attempty">Nothing to follow up for your role.</p>}
            {d.needsAttention.sections.map((s) => (
              <AttentionList key={s.kind} id={id} kind={s.kind} total={s.total} items={s.items} thresholds={d.needsAttention.thresholds}
                openable={Boolean(onOpen) && canOpen(TARGET[s.kind])} onOpen={(t, x) => onOpen?.(t, x)} />
            ))}
          </section>

          <section aria-labelledby={`${id}-totals`}>
            <div className="ins-head">
              <h2 id={`${id}-totals`}>Activity<span className="sr-only">, {fmtDay(Date.parse(d.period.from))} – {fmtDay(Date.parse(d.period.to) - 1)}</span></h2>
              {d.metrics.length > 0 && prev.data && <span className="muted">Change vs previous {days(periodDays)}</span>}
            </div>
            {d.metrics.length === 0 ? <p className="muted">Your role has no activity counts.</p> : (
              <ul className="ins-tiles" aria-label="Activity totals">
                {d.metrics.map((m) => (
                  <li key={m} title={METRIC_HINTS[m]}>
                    <span className="tilelabel"><i className="ins-swatch" style={{ background: METRIC_COLOR[m] }} aria-hidden="true" /><span>{METRIC_LABELS[m]}</span></span>
                    <span className="tilevalue">{d.totals[m] ?? 0}</span>
                    <Delta now={d.totals[m] ?? 0} before={prev.data?.totals[m]} />
                    <span className="sr-only">{METRIC_HINTS[m]}{prev.data ? `, compared with the previous ${days(periodDays)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.metrics.length > 0 && (
            <div className="dash-grid">
              <section className="card dash-card dash-trend" aria-label="Activity over time">
                <div className="chartheader">
                  <div><h3 className="charttitle">Activity trend</h3><p className="chartsub">Per day, {PERIODS.find((p) => p.days === periodDays)?.label.toLowerCase()}</p></div>
                  <div className="tabs wrap legendtabs" role="group" aria-label="Metrics to plot">
                    {d.metrics.map((m) => (
                      <button key={m} type="button" className="tab sm" aria-pressed={plot.includes(m)}
                        onClick={() => setPlotted(plot.includes(m) ? plot.filter((x) => x !== m) : [...plot, m])}>
                        <i className="dot" style={{ background: METRIC_COLOR[m] }} />{METRIC_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </div>
                <DailyTrend data={trend} label="Activity per day" height={260}
                  series={plot.map((m) => ({ key: m, label: METRIC_LABELS[m], color: METRIC_COLOR[m] }))} />
              </section>

              <div className="dash-side">
                {shownMetric && d.groups.length > 1 && (
                  <section className="card dash-card" aria-labelledby={`${id}-rank`}>
                    <div className="chartheader">
                      <div>
                        <h3 id={`${id}-rank`} className="charttitle">Activity by {groupWord}</h3>
                        <p className="chartsub">Most active first{d.groups.length > 5 ? ", top 5" : ""}</p>
                      </div>
                      <div className="field inline dash-metric">
                        <label htmlFor={`${id}-metric`} className="sr-only">Metric to rank</label>
                        <select id={`${id}-metric`} value={shownMetric} onChange={(e) => setRankMetric(e.target.value as Metric)}>
                          {d.metrics.map((m) => <option key={m} value={m}>{METRIC_LABELS[m]}</option>)}
                        </select>
                      </div>
                    </div>
                    {(() => {
                      const rows = [...d.groups].sort((a, b) => (b.counts[shownMetric] ?? 0) - (a.counts[shownMetric] ?? 0)).slice(0, 5);
                      const max = Math.max(1, ...rows.map((g) => g.counts[shownMetric] ?? 0));
                      return (
                        <ol className="dash-rank" aria-label={`Most active by ${groupWord}`}>
                          {rows.map((g) => {
                            const v = g.counts[shownMetric] ?? 0;
                            const before = prev.data ? (prevGroup.get(g.id ?? "none")?.[shownMetric] ?? 0) : undefined;
                            return (
                              <li key={g.id ?? "none"}>
                                <span className={`dash-rankname${g.name ? "" : " muted"}`}>{g.name ?? UNGROUPED[d.groupBy]}</span>
                                <span className="dash-bar" aria-hidden="true">{v > 0 && <span style={{ width: `${Math.round((v / max) * 100)}%`, background: METRIC_COLOR[shownMetric] }} />}</span>
                                <b className="dash-rankvalue">{v}</b>
                                <Delta now={v} before={before} />
                              </li>
                            );
                          })}
                        </ol>
                      );
                    })()}
                    <button type="button" className="linkbtn dash-viewall" onClick={() => jumpTo(`${id}-table`)}>
                      All {d.groups.length} rows in the table <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  </section>
                )}

                {stages.length > 1 && (
                  <section className="card dash-card" aria-labelledby={`${id}-stages`}>
                    <div>
                      <h3 id={`${id}-stages`} className="charttitle">Pipeline activity in the period</h3>
                      <p className="chartsub">Events counted in the period, not a cohort: a placement can follow a submission from an earlier period.</p>
                    </div>
                    {(() => {
                      const max = Math.max(1, ...stages.map((s) => s.value));
                      return (
                        <ol className="dash-rank dash-stages" aria-label="Pipeline activity in the period">
                          {stages.map((s) => (
                            <li key={s.key}>
                              <span className="dash-rankname">{s.label}</span>
                              <span className="dash-bar" aria-hidden="true">{s.value > 0 && <span style={{ width: `${Math.max(2, Math.round((s.value / max) * 100))}%`, background: METRIC_COLOR[s.key] }} />}</span>
                              <b className={`dash-rankvalue${s.value === 0 ? " zero" : ""}`}>{s.value}</b>
                            </li>
                          ))}
                        </ol>
                      );
                    })()}
                  </section>
                )}
              </div>
            </div>
          )}

          {d.metrics.length > 0 && (
            <section className="ins-section" aria-labelledby={`${id}-bygroup`}>
              <div className="ins-head">
                <h2 id={`${id}-bygroup`}>By {groupWord} <span className="ins-count">{d.groups.length}</span></h2>
                {d.groupsTruncated && <span className="muted">Showing the {d.groups.length} most active; totals include everyone.</span>}
              </div>
              <div className="card tablewrap listcard" id={`${id}-table`} tabIndex={-1}>
                <table className="dtable dash-groups" aria-label={`Activity by ${groupWord}`}>
                  <thead><tr>
                    <th>{GROUP_LABELS[d.groupBy]}</th>
                    {d.metrics.map((m) => <th key={m} className="num">{METRIC_LABELS[m]}</th>)}
                  </tr></thead>
                  <tbody>
                    {d.groups.map((g) => (
                      <tr key={g.id ?? "none"}>
                        <td className="c-primary">{g.name ? <b>{g.name}</b> : <span className="muted">{UNGROUPED[d.groupBy]}</span>}</td>
                        {d.metrics.map((m) => {
                          const v = g.counts[m] ?? 0;
                          return <td key={m} className="num" data-label={METRIC_LABELS[m]}>{v === 0 ? <span className="ins-zero">0</span> : v}</td>;
                        })}
                      </tr>
                    ))}
                    {d.groups.length === 0 && <tr><td colSpan={d.metrics.length + 1} className="empty">No activity in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
