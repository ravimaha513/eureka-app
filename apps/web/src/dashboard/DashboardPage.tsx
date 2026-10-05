import { useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, BadgeCheck, CalendarCheck, CalendarClock, Minus, Send, UserPlus, Users, type LucideIcon } from "lucide-react";
import { FunnelBars, PALETTE, PieShare, TrendChart } from "./Charts";
import { pipelineError } from "../pipeline/errors";
import { pipelineLabel } from "../pipeline/pipelineApi";
import { fmtDate } from "../sales/ui";
import {
  GROUP_LABELS, METRIC_HINTS, METRIC_LABELS, PERIODS, UNGROUPED,
  dashboardApi, periodRange, type AttentionItem, type AttentionKind, type Dashboard, type GroupBy, type Metric,
} from "./dashboardApi";

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

/** Pipeline order for the funnel chart. */
const FUNNEL: Metric[] = ["submissions", "interviewsScheduled", "interviewsCleared", "placementsCreated", "placementsJoined"];

/** The six largest shares, the rest folded into "Other" so the pie stays legible. */
function topShares(parts: { key: string; label: string; value: number }[]) {
  const sorted = [...parts].sort((a, b) => b.value - a.value);
  const rest = sorted.slice(6).reduce((n, p) => n + p.value, 0);
  return rest > 0 ? [...sorted.slice(0, 6), { key: "other", label: "Other", value: rest }] : sorted;
}

/** Icon and tint for each activity tile. */
const TILE: Record<Metric, { icon: LucideIcon; tint: string }> = {
  submissions: { icon: Send, tint: "indigo" },
  interviewsScheduled: { icon: CalendarClock, tint: "rose" },
  interviewsCleared: { icon: CalendarCheck, tint: "teal" },
  placementsCreated: { icon: BadgeCheck, tint: "amber" },
  placementsJoined: { icon: Users, tint: "violet" },
  candidatesAdded: { icon: UserPlus, tint: "sky" },
};

/** Change against the period just before this one, as shown under a tile. */
function Delta({ now, before, periodDays }: { now: number; before: number | undefined; periodDays: number }) {
  if (before === undefined) return <span className="tilehint">&nbsp;</span>;
  const vs = `vs previous ${periodDays} days`;
  if (now === before) return <span className="tiledelta flat"><Minus size={14} aria-hidden="true" />No change <span className="tilehint">{vs}</span></span>;
  if (before === 0) return <span className="tiledelta up"><ArrowUpRight size={14} aria-hidden="true" />New <span className="tilehint">{vs}</span></span>;
  const pct = Math.round(((now - before) / before) * 100);
  const up = now > before;
  return (
    <span className={`tiledelta ${up ? "up" : "down"}`}>
      {up ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownRight size={14} aria-hidden="true" />}
      {up ? "+" : ""}{pct}% <span className="tilehint">{vs}</span>
    </span>
  );
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

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

/**
 * Role dashboard (GET /api/v1/dashboard): activity counts for the caller's own
 * scope over a period, by recruiter, team or location, and the "needs attention"
 * lists. The API decides scope; this page only presents what it returns.
 */
export function DashboardPage({ canOpen = () => false, onOpen, firstName }: {
  firstName?: string;
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
  const [shareMetric, setShareMetric] = useState<Metric | undefined>(undefined);
  const [plotted, setPlotted] = useState<Metric[] | undefined>(undefined);
  const shownMetric = d && d.metrics.length > 0 ? (shareMetric && d.metrics.includes(shareMetric) ? shareMetric : d.metrics[0]!) : undefined;
  /** Until the user chooses, plot the first three metrics; six lines at once is noise. */
  const plot = d ? (plotted ?? d.metrics.slice(0, 3)).filter((m) => d.metrics.includes(m)) : [];
  const funnel = d ? FUNNEL.filter((m) => d.metrics.includes(m)).map((m) => ({ key: m, label: METRIC_LABELS[m], value: d.totals[m] ?? 0 })) : [];
  const trend = d ? d.series.map((x) => ({ date: x.date, ...Object.fromEntries(d.metrics.map((m) => [m, x.counts[m] ?? 0])) })) as ({ date: string } & Record<string, number | string>)[] : [];
  const shownGroup = d?.groupBy ?? groupBy ?? "recruiter";

  return (
    <>
      <div>
        <h1 tabIndex={-1}>Dashboard</h1>
        <p className="sub">{firstName ? `Welcome back, ${firstName}. ` : ""}Activity you can see in your own scope, and work that needs attention now.</p>
      </div>

      <form className="filters" role="search" aria-label="Dashboard filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="chipfilter">
            <span id={`${id}-period`} className="chiplabel">Period</span>
            <div className="tabs wrap" role="group" aria-labelledby={`${id}-period`}>
              {PERIODS.map((p) => (
                <button key={p.days} type="button" className="tab" aria-pressed={periodDays === p.days} onClick={() => setPeriodDays(p.days)}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-group`}>Group by</label>
            <select id={`${id}-group`} value={shownGroup} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
            </select>
          </div>
        </div>
      </form>

      {q.isLoading ? <p className="empty">Loading…</p> : q.error || !d ? (
        <p className="empty error" role="alert">{pipelineError(q.error, "generic")} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : (
        <div className="dashboard" aria-busy={q.isFetching || undefined}>
          <section aria-labelledby={`${id}-totals`}>
            <h2 id={`${id}-totals`} className="sectiontitle">
              Activity, {fmtDay(Date.parse(d.period.from))} – {fmtDay(Date.parse(d.period.to) - 1)}
            </h2>
            {d.metrics.length === 0 ? <p className="muted">Your role has no activity counts.</p> : (
              <ul className="tiles">
                {d.metrics.map((m) => {
                  const { icon: Icon, tint } = TILE[m];
                  return (
                    <li key={m} className="tile card" title={METRIC_HINTS[m]}>
                      <span className="tilehead">
                        <span className={`tileicon tint-${tint}`}><Icon size={18} strokeWidth={1.9} aria-hidden="true" /></span>
                        <span className="tilelabel">{METRIC_LABELS[m]}</span>
                      </span>
                      <span className="tilevalue">{d.totals[m] ?? 0}</span>
                      <Delta now={d.totals[m] ?? 0} before={prev.data?.totals[m]} periodDays={periodDays} />
                      <span className="sr-only">{METRIC_HINTS[m]}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {d.metrics.length > 0 && (
            <>
              <section className="card chartcard" aria-label="Activity over time">
                <div className="chartheader">
                  <div><h3 className="charttitle">Activity over time</h3><p className="chartsub">Per day, {PERIODS.find((p) => p.days === periodDays)?.label.toLowerCase()}</p></div>
                  <div className="tabs wrap" role="group" aria-label="Metrics to plot">
                    {d.metrics.map((m, i) => (
                      <button key={m} type="button" className="tab sm" aria-pressed={plot.includes(m)}
                        onClick={() => setPlotted(plot.includes(m) ? plot.filter((x) => x !== m) : [...plot, m])}>
                        <i className="swatch" style={{ background: PALETTE[i % PALETTE.length] }} />{METRIC_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </div>
                <TrendChart data={trend} label="Activity per day" series={plot.map((m) => ({ key: m, label: METRIC_LABELS[m], color: PALETTE[d.metrics.indexOf(m) % PALETTE.length]! }))} />
              </section>
              <div className="chartgrid">
                {funnel.length > 1 && (
                  <section className="card chartcard" aria-label="Pipeline funnel">
                    <h3 className="charttitle">Pipeline funnel</h3>
                    <FunnelBars stages={funnel} label="Pipeline funnel" />
                  </section>
                )}
                <section className="card chartcard" aria-label="Activity mix">
                  <h3 className="charttitle">Activity mix</h3>
                  <PieShare label="Activity mix" centre="events"
                    parts={d.metrics.map((m) => ({ key: m, label: METRIC_LABELS[m], value: d.totals[m] ?? 0 }))} />
                </section>
                {shownMetric && d.groups.length > 0 && (
                  <section className="card chartcard" aria-label={`${METRIC_LABELS[shownMetric]} share by ${GROUP_LABELS[d.groupBy].toLowerCase()}`}>
                    <h3 className="charttitle">Share by {GROUP_LABELS[d.groupBy].toLowerCase()}</h3>
                    <div className="tabs wrap" role="group" aria-label="Metric to chart">
                      {d.metrics.map((m) => (
                        <button key={m} type="button" className="tab sm" aria-pressed={shownMetric === m} onClick={() => setShareMetric(m)}>{METRIC_LABELS[m]}</button>
                      ))}
                    </div>
                    <PieShare label={`${METRIC_LABELS[shownMetric]} by ${GROUP_LABELS[d.groupBy].toLowerCase()}`} centre={METRIC_LABELS[shownMetric].toLowerCase()}
                      parts={topShares(d.groups.map((g) => ({ key: g.id ?? "none", label: g.name ?? UNGROUPED[d.groupBy], value: g.counts[shownMetric] ?? 0 })))} />
                  </section>
                )}
                {d.needsAttention.sections.length > 0 && (
                  <section className="card chartcard" aria-label="Needs attention overview">
                    <h3 className="charttitle">Needs attention</h3>
                    <PieShare label="Needs attention by kind" centre="open items"
                      parts={d.needsAttention.sections.map((s) => ({ key: s.kind, label: ATTENTION[s.kind].title, value: s.total }))} />
                  </section>
                )}
              </div>
            </>
          )}

          {d.metrics.length > 0 && (
            <div className="card tablewrap">
              <table aria-label={`Activity by ${GROUP_LABELS[d.groupBy].toLowerCase()}`}>
                <thead><tr>
                  <th>{GROUP_LABELS[d.groupBy]}</th>
                  {d.metrics.map((m) => <th key={m} className="num">{METRIC_LABELS[m]}</th>)}
                </tr></thead>
                <tbody>
                  {d.groups.map((g) => (
                    <tr key={g.id ?? "none"}>
                      <td>{g.name ?? <span className="muted">{UNGROUPED[d.groupBy]}</span>}</td>
                      {d.metrics.map((m) => <td key={m} className="num">{g.counts[m] ?? 0}</td>)}
                    </tr>
                  ))}
                  {d.groups.length === 0 && <tr><td colSpan={d.metrics.length + 1} className="empty">No activity in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          <section aria-labelledby={`${id}-attention`}>
            <h2 id={`${id}-attention`} className="sectiontitle">Needs attention</h2>
            {d.needsAttention.sections.length === 0 && <p className="muted">Nothing to follow up for your role.</p>}
            {d.needsAttention.sections.map((s) => {
              const meta = ATTENTION[s.kind];
              const target = TARGET[s.kind];
              const openable = Boolean(onOpen) && canOpen(target);
              return (
                <section key={s.kind} className="card attention" aria-labelledby={`${id}-${s.kind}`}>
                  <h3 id={`${id}-${s.kind}`}>{meta.title} <span className="count">{s.total}</span></h3>
                  <p className="muted">{meta.explain(d.needsAttention.thresholds)}</p>
                  {s.items.length === 0 ? <p className="ok">{meta.empty}</p> : (
                    <>
                      <div className="tablewrap"><table aria-label={meta.title}>
                        <thead><tr><th>Candidate</th><th>Details</th><th>Status</th><th>Recruiter</th><th className="num">Waiting</th>
                          {openable && <th><span className="sr-only">Actions</span></th>}</tr></thead>
                        <tbody>
                          {s.items.map((i) => (
                            <tr key={i.id}>
                              <td>{i.candidate.name ?? <span className="muted">Not visible to you</span>}</td>
                              <td>{detailText(s.kind, i)}</td>
                              <td>{pipelineLabel(i.status)}</td>
                              <td>{i.recruiter.name ?? "—"}</td>
                              <td className="num">
                                <span className="agebar" aria-hidden="true"><span className={`barfill ${i.ageDays >= 14 ? "c3" : "c2"}`} style={{ width: `${Math.min(100, Math.round((i.ageDays / 30) * 100))}%` }} /></span>
                                {days(i.ageDays)}
                              </td>
                              {openable && (
                                <td className="rowactions">
                                  <button type="button" className="btn sm" onClick={() => onOpen?.(target, i.id)}
                                    aria-label={`Open ${i.candidate.name ?? "this item"} in ${TARGET_LABEL[target]}`}>Open</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                      {s.total > s.items.length && <p className="muted">Showing the oldest {s.items.length} of {s.total}.</p>}
                    </>
                  )}
                </section>
              );
            })}
          </section>
        </div>
      )}
    </>
  );
}
