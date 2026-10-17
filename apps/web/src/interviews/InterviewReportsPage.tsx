import { useId, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { INTERVIEW_REPORT_GROUPS, type InterviewReportGroup } from "@eureka/shared";
import { ApiError, api, apiFetch, type Me } from "../api";
import { download } from "../employees/JoiningsExitsReport";
import { CandidateFeedbackCell, dateBoundary } from "./InterviewsPage";

/**
 * Interview reports (gap L4; docs/interviews-settings-api.md "Interview
 * reports"): counts, clearances and durations by interview coach,
 * technology, candidate or duration bucket, and the daily interviews report
 * with the candidate's own feedback. Scope: interviews the user can see on
 * the board, where they may read reports. Exports (report:export) are capped
 * and audited by the server.
 */

const EXPORT_ROW_CAP = 50_000;
const GROUP_LABELS: Record<InterviewReportGroup, string> = {
  coach: "Interview coach", technology: "Technology", candidate: "Candidate", duration: "Duration",
};
const label = (s: string) => { const t = s.replaceAll("_", " "); return t.charAt(0).toUpperCase() + t.slice(1); };

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
interface ExportResult { blob: Blob; filename: string; rows: number; truncated: boolean }

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shiftDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const hours = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);

async function postCsv(path: string, body: unknown, fallback: string): Promise<ExportResult> {
  const res = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  return { blob: await res.blob(), filename: name, rows: Number(res.headers.get("x-export-rows") ?? 0), truncated: res.headers.get("x-export-truncated") === "true" };
}
const errorText = (e: unknown) => e instanceof ApiError ? (e.detail ?? e.message) : "Something went wrong. Please try again.";

function ExportStatus({ run }: { run: { isError: boolean; error: unknown; data?: ExportResult } }) {
  if (run.isError) return <p className="error" role="alert">{run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.") : errorText(run.error)}</p>;
  if (!run.data) return null;
  return <p className="muted" role="status">{run.data.truncated ? `Exported the first ${run.data.rows.toLocaleString("en-US")} rows (the export limit). Choose a shorter period for the rest.`
    : `Exported ${run.data.rows.toLocaleString("en-US")} ${run.data.rows === 1 ? "row" : "rows"}.`}</p>;
}

function GroupedReport({ canExport }: { canExport: boolean }) {
  const id = useId();
  const today = localToday();
  const [from, setFrom] = useState(shiftDays(today, -30));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<InterviewReportGroup>("coach");
  const invalid = !from || !to || from > to;
  const period = () => ({ from: dateBoundary(from), to: dateBoundary(to, true), groupBy });
  const q = useQuery({
    queryKey: ["reports", "interviews", from, to, groupBy],
    queryFn: () => api<GroupReport>(`/api/v1/reports/interviews?${new URLSearchParams(period())}`),
    enabled: !invalid, placeholderData: keepPreviousData,
  });
  const run = useMutation({ mutationFn: () => postCsv("/api/v1/reports/interviews/export", period(), "interviews.csv"), onSuccess: (r) => download(r.blob, r.filename) });
  const d = q.data;
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Interviews by {GROUP_LABELS[groupBy].toLowerCase()}</h2>
      <form className="filters" aria-label="Interview report filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline"><label htmlFor={`${id}-from`}>From</label>
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field inline"><label htmlFor={`${id}-to`}>Through</label>
            <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={invalid || undefined} /></div>
          <div className="field inline"><label htmlFor={`${id}-group`}>Group by</label>
            <select id={`${id}-group`} value={groupBy} onChange={(e) => setGroupBy(e.target.value as InterviewReportGroup)}>
              {INTERVIEW_REPORT_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
            </select></div>
          {canExport && <div className="export">
            <button type="button" className="btn" disabled={invalid || run.isPending} onClick={() => run.mutate()}>{run.isPending ? "Exporting…" : "Export CSV"}</button>
            <small className="hint">Up to {EXPORT_ROW_CAP.toLocaleString("en-US")} rows for your export scope.</small>
          </div>}
        </div>
        {invalid && <p className="error" role="alert">Choose a start date on or before the end date.</p>}
        <ExportStatus run={run} />
      </form>
      {!invalid && (q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{errorText(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : d ? (
        <div aria-busy={q.isFetching || undefined}>
          <ul className="tiles">
            <li className="tile card"><span className="tilelabel">Interviews</span><span className="tilevalue">{d.totals.interviews}</span><span className="tilehint">{d.totals.completed} completed</span></li>
            <li className="tile card"><span className="tilelabel">Cleared</span><span className="tilevalue">{d.totals.cleared}</span>
              <span className="tilehint">{d.totals.interviews ? `${Math.round((d.totals.cleared / d.totals.interviews) * 100)}% of interviews` : "—"}</span></li>
            <li className="tile card"><span className="tilelabel">Total duration</span><span className="tilevalue">{hours(d.totals.totalDurationMin)}</span>
              <span className="tilehint">{d.totals.avgDurationMin !== null ? `${d.totals.avgDurationMin} min on average` : "—"}</span></li>
          </ul>
          <div className="card tablewrap">
            <table aria-label={`Interviews by ${GROUP_LABELS[groupBy].toLowerCase()}`}>
              <thead><tr><th>{GROUP_LABELS[groupBy]}</th><th>Interviews</th><th>Cleared</th><th>Completed</th><th>Total duration</th><th>Average duration</th></tr></thead>
              <tbody>
                {d.groups.map((g) => <tr key={g.key ?? "none"}>
                  <td>{g.label}</td><td>{g.interviews}</td><td>{g.cleared}</td><td>{g.completed}</td>
                  <td>{hours(g.totalDurationMin)}</td><td>{g.avgDurationMin !== null ? `${g.avgDurationMin} min` : "—"}</td>
                </tr>)}
                {d.groups.length === 0 && <tr><td colSpan={6} className="empty">No interviews in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.groups.length.toLocaleString("en-US")} groups. Export or choose a shorter period to see the rest.</p>}
          <p className="hint">Cancelled, rescheduled and no-invite interviews are not counted. Duration is the scheduled slot.</p>
        </div>
      ) : null)}
    </section>
  );
}

function DailyReportSection({ canExport }: { canExport: boolean }) {
  const id = useId();
  const [day, setDay] = useState(localToday());
  const period = () => ({ from: dateBoundary(day), to: dateBoundary(day, true) });
  const q = useQuery({
    queryKey: ["reports", "interviews-daily", day],
    queryFn: () => api<DailyReport>(`/api/v1/reports/interviews/daily?${new URLSearchParams(period())}`),
    enabled: Boolean(day), placeholderData: keepPreviousData,
  });
  const run = useMutation({ mutationFn: () => postCsv("/api/v1/reports/interviews/daily/export", period(), "interviews-daily.csv"), onSuccess: (r) => download(r.blob, r.filename) });
  const d = q.data;
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Daily interviews</h2>
      <form className="filters" aria-label="Daily report day" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline"><label htmlFor={`${id}-day`}>Day</label>
            <input id={`${id}-day`} type="date" value={day} onChange={(e) => setDay(e.target.value)} /></div>
          <button type="button" className="btn" onClick={() => setDay(shiftDays(day || localToday(), -1))}>Previous day</button>
          <button type="button" className="btn" onClick={() => setDay(shiftDays(day || localToday(), 1))}>Next day</button>
          {canExport && <div className="export">
            <button type="button" className="btn" disabled={!day || run.isPending} onClick={() => run.mutate()}>{run.isPending ? "Exporting…" : "Export CSV"}</button>
          </div>}
        </div>
        <ExportStatus run={run} />
      </form>
      {day && (q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{errorText(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : d ? (
        <div aria-busy={q.isFetching || undefined}>
          <p className="muted">{d.totals.interviews} interviews, {d.totals.cleared} cleared, {d.totals.withCandidateFeedback} with candidate feedback.</p>
          <div className="card tablewrap">
            <table aria-label="Daily interviews">
              <thead><tr><th>Time</th><th>Candidate / technology</th><th>Client / round</th><th>Team / recruiter</th><th>Coach</th><th>Status</th><th>Candidate feedback</th></tr></thead>
              <tbody>
                {d.items.map((i) => <tr key={i.id} className={i.cleared ? "row-cleared" : undefined}>
                  <td><time dateTime={i.startsAt}>{new Date(i.startsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time><span className="block muted">{i.durationMin} min</span></td>
                  <td>{i.candidate.name ?? <span className="muted">Name hidden</span>}<span className="block muted">{i.technology ?? ""}</span></td>
                  <td>{i.client ?? "—"}<span className="block muted">{i.round}</span></td>
                  <td>{i.team ?? "—"}<span className="block muted">{i.recruiter ?? ""}</span></td>
                  <td>{i.coach?.name ?? "Unassigned"}</td>
                  <td>{label(i.callStatus)}{i.cleared && <span className="block"><span className="badge cleared">Cleared</span></span>}</td>
                  <td><CandidateFeedbackCell f={i.candidateFeedback} />{i.candidateFeedback?.nextStep && <span className="block muted">Next step: {i.candidateFeedback.nextStep}</span>}</td>
                </tr>)}
                {d.items.length === 0 && <tr><td colSpan={7} className="empty">No interviews on this day.</td></tr>}
              </tbody>
            </table>
          </div>
          {d.truncated && <p className="muted" role="status">Showing the first {d.items.length.toLocaleString("en-US")} interviews. Export to see the rest.</p>}
        </div>
      ) : null)}
    </section>
  );
}

export function InterviewReportsPage({ me }: { me: Pick<Me, "capabilities"> }) {
  const [tab, setTab] = useState<"grouped" | "daily">("grouped");
  const canExport = me.capabilities.includes("report:export");
  return (
    <>
      <div>
        <h1 tabIndex={-1}>Interview reports</h1>
        <p className="sub">Interviews you can see on the board: by interview coach, technology, candidate or duration, and a daily list with the candidate's feedback.</p>
      </div>
      <div role="tablist" aria-label="Interview reports" className="tabs">
        <button type="button" role="tab" aria-selected={tab === "grouped"} className="tab" onClick={() => setTab("grouped")}>Summary</button>
        <button type="button" role="tab" aria-selected={tab === "daily"} className="tab" onClick={() => setTab("daily")}>Daily interviews</button>
      </div>
      <div role="tabpanel">{tab === "grouped" ? <GroupedReport canExport={canExport} /> : <DailyReportSection canExport={canExport} />}</div>
    </>
  );
}
