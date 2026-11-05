import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { INTERVIEW_REPORT_GROUPS, type InterviewReportGroup } from "@eureka/shared";
import { ApiError, api, can, type Me } from "../api";
import { fetchCsv, saveBlob, type ExportResult } from "../lib/download";
import { navigate, useSearchParams } from "../lib/router";
import { screenPath } from "../nav";
import { RecordLink } from "../ui/RecordLink";
import { Tabs } from "../ui/Tabs";
import { CandidateFeedbackCell } from "./InterviewsPage";
import { CallStatus } from "./InterviewFields";
import { fmtRange, todayIn, useInterviewZone, zoneAbbr, zoneDayBoundary } from "../pipeline/zones";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";
import "../pipeline/pipeline.css";
import "./interviews.css";

/**
 * Interview reports (gap L4; docs/interviews-settings-api.md "Interview
 * reports"): counts, clearances and durations by interview coach,
 * technology, candidate or duration bucket, and the daily interviews report
 * with the candidate's own feedback. Scope: interviews the user can see on
 * the board, where they may read reports. Exports (report:export) are capped
 * and audited by the server. Tab, period, grouping and day are in the URL.
 * Days are read in the viewer's interview time zone (the board's), so the
 * reports and the board agree.
 */

const EXPORT_ROW_CAP = 50_000;
const GROUP_LABELS: Record<InterviewReportGroup, string> = {
  coach: "Interview coach", technology: "Technology", candidate: "Candidate", duration: "Duration",
};

interface Group { key: string | null; label: string; interviews: number; cleared: number; completed: number; totalDurationMin: number; avgDurationMin: number | null }
interface GroupReport {
  from: string; to: string; groupBy: InterviewReportGroup; truncated: boolean; groups: Group[];
  totals: { interviews: number; cleared: number; completed: number; totalDurationMin: number; avgDurationMin: number | null };
}
interface DailyItem {
  id: string; startsAt: string; endsAt: string; durationMin: number; round: string; callStatus: string; cleared: boolean;
  candidate: { id: string; name: string | null }; technology: string | null; client: string | null; recruiter: string | null;
  team: string | null; location: string | null; coach: { id: string; name: string | null } | null;
  candidateFeedback: { rating: number | null; notes: string | null; format: string | null; nextStep: string | null; submittedAt: string } | null;
}
interface DailyReport { from: string; to: string; truncated: boolean; items: DailyItem[]; totals: { interviews: number; cleared: number; withCandidateFeedback: number } }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const shiftDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "20 h", "4 h 30 min", "45 min". */
const hours = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`);
const PRESETS = [7, 30, 90] as const;

const errorText = (e: unknown) => e instanceof ApiError ? (e.detail ?? e.message) : "Something went wrong. Please try again.";

function ExportStatus({ run }: { run: { isError: boolean; error: unknown; data?: ExportResult } }) {
  if (run.isError) return <p className="error" role="alert">{run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.") : errorText(run.error)}</p>;
  if (!run.data) return null;
  return <p className="muted" role="status">{run.data.truncated ? `Exported the first ${run.data.rows.toLocaleString("en-US")} rows (the export limit). Choose a shorter period for the rest.`
    : `Exported ${run.data.rows.toLocaleString("en-US")} ${run.data.rows === 1 ? "row" : "rows"}.`}</p>;
}

type SortKey = "label" | "interviews" | "cleared" | "completed" | "totalDurationMin" | "avgDurationMin";
const PARAMS = ["from", "to", "groupBy", "day"] as const;

function GroupedReport({ canExport, zone }: { canExport: boolean; zone: string }) {
  const id = useId();
  const today = todayIn(zone);
  const [url, setUrl] = useSearchParams(PARAMS);
  const from = ISO_DAY.test(url.from) ? url.from : shiftDays(today, -30);
  const to = ISO_DAY.test(url.to) ? url.to : today;
  const groupBy = (INTERVIEW_REPORT_GROUPS as readonly string[]).includes(url.groupBy) ? url.groupBy as InterviewReportGroup : "coach";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const invalid = !from || !to || from > to;
  const period = () => ({ from: zoneDayBoundary(from, zone), to: zoneDayBoundary(to, zone, true), groupBy });
  const q = useQuery({
    queryKey: ["reports", "interviews", from, to, zone, groupBy],
    queryFn: () => api<GroupReport>(`/api/v1/reports/interviews?${new URLSearchParams(period())}`),
    enabled: !invalid, placeholderData: keepPreviousData,
  });
  const run = useMutation({ mutationFn: () => fetchCsv("/api/v1/reports/interviews/export", period(), "interviews.csv"), onSuccess: (r) => saveBlob(r.blob, r.filename) });
  const d = q.data;
  const preset = to === today ? PRESETS.find((n) => from === shiftDays(today, -n)) : undefined;
  const setPreset = (n: number) => setUrl({ from: n === 30 ? "" : shiftDays(today, -n), to: "" });
  const groups = d ? [...d.groups] : [];
  if (sort) groups.sort((a, b) => {
    const x = a[sort.key] ?? -1; const y = b[sort.key] ?? -1;
    return (typeof x === "string" ? String(x).localeCompare(String(y)) : Number(x) - Number(y)) * sort.dir;
  });
  const head = (key: SortKey, text: string, num = true) => {
    const on = sort?.key === key;
    return (
      <th className={num ? "num" : undefined} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}>
        <button type="button" className="ir-sort" onClick={() => setSort(on ? { key, dir: sort!.dir === 1 ? -1 : 1 } : { key, dir: num ? -1 : 1 })}>
          {text}{on && <span aria-hidden="true">{sort!.dir === 1 ? " ↑" : " ↓"}</span>}
        </button>
      </th>
    );
  };
  // A candidate row opens the board for that candidate and period (the board filters by name).
  // Coach, technology and duration have no board filter, so those rows are not links.
  const boardLink = (g: Group) => groupBy === "candidate" && g.key
    ? `${screenPath("interviews")}?${new URLSearchParams({ from, to, candidate: g.label })}` : null;
  const label = GROUP_LABELS[groupBy].toLowerCase();
  return (
    <section aria-labelledby={`${id}-h`} className="ir-page">
      <h2 id={`${id}-h`} className="sr-only">Interviews by {label}</h2>
      <form className="ir-toolbar" aria-label="Interview report filters" onSubmit={(e) => e.preventDefault()}>
        <div className="ir-presets" role="group" aria-label="Period">
          {PRESETS.map((n) => <button key={n} type="button" aria-pressed={preset === n} onClick={() => setPreset(n)}>{n} days</button>)}
        </div>
        <div className="field inline"><label htmlFor={`${id}-from`}>From</label>
          <input id={`${id}-from`} type="date" value={from} onChange={(e) => setUrl({ from: e.target.value })} /></div>
        <div className="field inline"><label htmlFor={`${id}-to`}>Through</label>
          <input id={`${id}-to`} type="date" value={to} onChange={(e) => setUrl({ to: e.target.value === today ? "" : e.target.value })} aria-invalid={invalid || undefined} /></div>
        <div className="field inline"><label htmlFor={`${id}-group`}>Group by</label>
          <select id={`${id}-group`} value={groupBy} onChange={(e) => { setSort(null); setUrl({ groupBy: e.target.value === "coach" ? "" : e.target.value }); }}>
            {INTERVIEW_REPORT_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
          </select></div>
        {canExport && <div className="export ir-export">
          <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}
            title={`Up to ${EXPORT_ROW_CAP.toLocaleString("en-US")} rows for your export scope.`}>{run.isPending ? "Exporting…" : "Export CSV"}</button>
        </div>}
      </form>
      {invalid && <p className="error" role="alert">Choose a start date on or before the end date.</p>}
      <ExportStatus run={run} />
      {!invalid && (q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={errorText(q.error)} />
      ) : d ? (
        <div aria-busy={q.isFetching || undefined} className="ir-page">
          <ul className="tiles">
            <li className="tile card"><span className="tilelabel">Interviews</span><span className="tilevalue">{d.totals.interviews}</span><span className="tilehint">{d.totals.completed} completed</span></li>
            <li className="tile card"><span className="tilelabel">Ready (cleared for call)</span><span className="tilevalue">{d.totals.cleared}</span>
              <span className="tilehint">{d.totals.interviews ? `${Math.round((d.totals.cleared / d.totals.interviews) * 100)}% of interviews` : "—"}</span></li>
            <li className="tile card"><span className="tilelabel">Total duration</span><span className="tilevalue">{hours(d.totals.totalDurationMin)}</span>
              <span className="tilehint">{d.totals.avgDurationMin !== null ? `${d.totals.avgDurationMin} min on average` : "—"}</span></li>
          </ul>
          <div className="card tablewrap listcard">
            <table className="dtable ir-table" aria-label={`Interviews by ${label}`}>
              <thead><tr>
                {head("label", GROUP_LABELS[groupBy], false)}{head("interviews", "Interviews")}{head("cleared", "Ready")}{head("completed", "Completed")}
                {head("totalDurationMin", "Total duration")}{head("avgDurationMin", "Average duration")}
              </tr></thead>
              <tbody>
                {groups.map((g) => {
                  const href = boardLink(g);
                  return (
                    <tr key={g.key ?? "none"} className={href ? "rowopen" : undefined}
                      onClick={href ? (e) => { if (!(e.target as HTMLElement).closest("a, button")) navigate(href); } : undefined}>
                      <td className="c-primary ir-group">{href
                        ? <a className="recordlink" href={href} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}
                          aria-label={`Open ${g.label}'s interviews in this period`}><b>{g.label}</b></a>
                        : <b>{g.label}</b>}</td>
                      <td className="num" data-label="Interviews">{g.interviews}</td>
                      <td className="num" data-label="Ready">{g.cleared}</td>
                      <td className="num" data-label="Completed">{g.completed}</td>
                      <td className="num" data-label="Total duration">{hours(g.totalDurationMin)}</td>
                      <td className="num" data-label="Average">{g.avgDurationMin !== null ? `${g.avgDurationMin} min` : "—"}</td>
                    </tr>
                  );
                })}
                {d.groups.length === 0 && <tr><td colSpan={6} className="empty">No interviews in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.groups.length.toLocaleString("en-US")} groups. Export or choose a shorter period to see the rest.</p>}
          <p className="ir-note">Ready counts interviews cleared for the call (pre-call readiness), not the round result. Cancelled, rescheduled and no-invite interviews are not counted. Duration is the scheduled slot.{groupBy === "candidate" ? " Open a candidate to see their interviews on the board." : ""}</p>
        </div>
      ) : null)}
    </section>
  );
}

function DailyReportSection({ canExport, zone, canOpenCandidate }: { canExport: boolean; zone: string; canOpenCandidate: boolean }) {
  const id = useId();
  const today = todayIn(zone);
  const [url, setUrl] = useSearchParams(PARAMS);
  const day = ISO_DAY.test(url.day) ? url.day : today;
  const setDay = (v: string) => setUrl({ day: v === today ? "" : v });
  const period = () => ({ from: zoneDayBoundary(day, zone), to: zoneDayBoundary(day, zone, true) });
  const q = useQuery({
    queryKey: ["reports", "interviews-daily", day, zone],
    queryFn: () => api<DailyReport>(`/api/v1/reports/interviews/daily?${new URLSearchParams(period())}`),
    enabled: Boolean(day), placeholderData: keepPreviousData,
  });
  const run = useMutation({ mutationFn: () => fetchCsv("/api/v1/reports/interviews/daily/export", period(), "interviews-daily.csv"), onSuccess: (r) => saveBlob(r.blob, r.filename) });
  const d = q.data;
  const abbr = zoneAbbr(zone, `${day}T12:00:00Z`);
  return (
    <section aria-labelledby={`${id}-h`} className="ir-page">
      <h2 id={`${id}-h`} className="sr-only">Daily interviews</h2>
      <form className="ir-toolbar" aria-label="Daily report day" onSubmit={(e) => e.preventDefault()}>
        <div className="ir-stepper">
          <button type="button" className="btn" aria-label="Previous day" title="Previous day" onClick={() => setDay(shiftDays(day, -1))}><ChevronLeft size={16} aria-hidden="true" /></button>
          <div className="field inline"><label htmlFor={`${id}-day`}>Day</label>
            <input id={`${id}-day`} type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></div>
          <button type="button" className="btn" aria-label="Next day" title="Next day" onClick={() => setDay(shiftDays(day, 1))}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
        {day !== today && <button type="button" className="btn" onClick={() => setDay(today)}>Today</button>}
        {canExport && <div className="export ir-export">
          <button type="button" className="btn" disabled={!day || run.isPending} onClick={() => run.mutate()}>{run.isPending ? "Exporting…" : "Export CSV"}</button>
        </div>}
      </form>
      <ExportStatus run={run} />
      {q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={errorText(q.error)} />
      ) : d ? (
        <div aria-busy={q.isFetching || undefined} className="ir-page">
          <p className="muted ir-note">{d.totals.interviews} interviews, {d.totals.cleared} cleared, {d.totals.withCandidateFeedback} with candidate feedback.</p>
          <div className="card tablewrap listcard">
            <table className="dtable ir-table" aria-label="Daily interviews">
              <thead><tr><th>Time ({abbr})</th><th>Candidate / technology</th><th>Client / round</th><th className="p2">Team / recruiter</th><th>Coach</th><th>Status</th><th>Candidate feedback</th>
                <th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {d.items.map((i) => <tr key={i.id} className={i.cleared ? "row-cleared" : undefined}>
                  <td data-label="Time" className="pl-nowrap"><span><time dateTime={i.startsAt}>{fmtRange(i.startsAt, i.endsAt, zone)}</time><small className="block muted">{i.durationMin} min</small></span></td>
                  <td className="c-primary">{i.candidate.name
                    ? <RecordLink kind="candidate" id={i.candidate.id} allowed={canOpenCandidate}><b>{i.candidate.name}</b></RecordLink>
                    : <span className="muted">Name hidden</span>}<small className="block muted">{i.technology ?? ""}</small></td>
                  <td data-label="Client"><span>{i.client ?? "—"}<small className="block muted">{i.round}</small></span></td>
                  <td className="p2" data-label="Team"><span>{i.team ?? "—"}<small className="block muted">{i.recruiter ?? ""}</small></span></td>
                  <td data-label="Coach">{i.coach?.name ?? "Unassigned"}</td>
                  <td className="c-badge" data-label="Status"><span><CallStatus status={i.callStatus} />{i.cleared && <> <span className="badge st-selected">Ready</span></>}</span></td>
                  <td data-label="Feedback"><span><CandidateFeedbackCell f={i.candidateFeedback} />{i.candidateFeedback?.nextStep && <span className="block muted">Next step: {i.candidateFeedback.nextStep}</span>}</span></td>
                  <td className="c-act"><RecordLink kind="interview" id={i.id} className="btn sm" label={`Open the ${i.round} interview of ${i.candidate.name ?? "the candidate"}`}>Open</RecordLink></td>
                </tr>)}
                {d.items.length === 0 && <tr><td colSpan={8} className="empty">No interviews on this day.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.items.length.toLocaleString("en-US")} interviews. Export to see the rest.</p>}
        </div>
      ) : null}
    </section>
  );
}

export function InterviewReportsPage({ me }: { me: Pick<Me, "capabilities"> }) {
  const canExport = can(me, "report:export");
  const [zone] = useInterviewZone();
  return (
    <section className="panel ir-page">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Interview reports</h1>
          <p className="sub">Interviews you can see on the board: by interview coach, technology, candidate or duration, and a daily list with the candidate&apos;s feedback. Days and times in {zone}.</p>
        </div>
      </div>
      <Tabs label="Interview reports" urlKey="tab" defaultValue="grouped" tabs={[{ key: "grouped", label: "Summary" }, { key: "daily", label: "Daily interviews" }]}>
        {(tab) => (tab === "grouped" ? <GroupedReport canExport={canExport} zone={zone} />
          : <DailyReportSection canExport={canExport} zone={zone} canOpenCandidate={can(me, "candidate:read")} />)}
      </Tabs>
    </section>
  );
}
