import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { SUBMISSION_STATUSES } from "../pipeline/pipelineApi";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import { salesError } from "./errors";
import { salesApi, salesKeys, statusLabel } from "./salesApi";
import { fmtDate } from "./ui";

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Pipeline metrics on the candidate profile (GET /api/v1/candidates/:id/metrics):
 * submissions, interviews and placements, each shown only when the server sends
 * that section (the caller's read permission) and counting what the caller can see.
 */
export function CandidateMetrics({ candidateId }: { candidateId: string }) {
  const id = useId();
  const q = useQuery({ queryKey: salesKeys.metrics(candidateId), queryFn: () => salesApi.metrics(candidateId) });
  if (q.isLoading || q.error) {
    return (
      <section className="card pad" aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`}>Metrics</h2>
        {q.error ? <QueryError query={q} message={salesError(q.error)} /> : <Loading />}
      </section>
    );
  }
  const d = q.data;
  if (!d || (!d.submissions && !d.interviews && !d.placements)) return null;
  const s = d.submissions, i = d.interviews, p = d.placements;

  const tiles: { label: string; value: number | string; hint: string }[] = [];
  if (s) {
    tiles.push({ label: "Submissions", value: s.total,
      hint: s.total ? `${s.last30Days} in last 30 days · ${plural(s.clients, "client")}` : "None yet" });
  }
  if (i) {
    tiles.push({ label: "Interviews", value: i.total,
      hint: i.upcoming ? `${i.upcoming} upcoming${i.nextAt ? `, next ${fmtDate(i.nextAt)}` : ""}` : i.lastAt ? `Last ${fmtDate(i.lastAt)}` : "None yet" });
    tiles.push({ label: "Cleared", value: i.cleared, hint: `${pct(i.cleared, i.completed)} of ${plural(i.completed, "completed interview")}` });
    tiles.push({ label: "Not cleared", value: i.notCleared, hint: i.cancelled ? `${i.cancelled} cancelled or no invite` : "Completed without clearing" });
  }
  if (s) {
    const rejected = s.byStatus.rejected ?? 0, selected = s.byStatus.selected ?? 0;
    tiles.push({ label: "Selected", value: selected, hint: `${pct(selected, s.total)} of submissions` });
    tiles.push({ label: "Rejected", value: rejected, hint: `${s.byStatus.withdrawn ?? 0} withdrawn` });
  }
  if (p) {
    tiles.push({ label: "Placements", value: p.total,
      hint: p.total ? `${p.joined} joined · ${p.active} in progress${p.fellThrough ? ` · ${p.fellThrough} fell through` : ""}` : "None yet" });
  }

  const statuses = s ? SUBMISSION_STATUSES.filter((k) => (s.byStatus[k] ?? 0) > 0) : [];
  const rounds = i ? Object.entries(i.byRound).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })) : [];

  return (
    <section className="card pad cp-metrics" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Metrics</h2>
      <ul className="tiles kpis" aria-label="Candidate metrics">
        {tiles.map((t) => (
          <li key={t.label} className="tile"><span className="tilelabel">{t.label}</span><span className="tilevalue">{t.value}</span><span className="tilehint">{t.hint}</span></li>
        ))}
      </ul>
      {(s || i) && (
        <dl className="facts cp-rates">
          {s && i && <><dt>Submission to interview</dt><dd>{pct(s.withInterview, s.total)}</dd></>}
          {i && <><dt>Interview clear rate</dt><dd>{pct(i.cleared, i.completed)}</dd></>}
          {s && <><dt>Submission to selection</dt><dd>{pct(s.byStatus.selected ?? 0, s.total)}</dd></>}
          {s?.firstAt && <><dt>First submitted</dt><dd>{fmtDate(s.firstAt)}</dd></>}
          {s?.lastAt && <><dt>Last submitted</dt><dd>{fmtDate(s.lastAt)}</dd></>}
        </dl>
      )}
      {(statuses.length > 0 || rounds.length > 0) && (
        <div className="cp-breakdown">
          {statuses.length > 0 && (
            <div>
              <h3>Submissions by status</h3>
              <ul className="plain">
                {statuses.map((k) => <li key={k}><span className={`badge st-${k}`}>{statusLabel(k)}</span> {s!.byStatus[k]}</li>)}
              </ul>
            </div>
          )}
          {rounds.length > 0 && (
            <div>
              <h3>Interviews by round</h3>
              <ul className="plain">
                {rounds.map(([r, n]) => <li key={r}><b>{r}</b> {n}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
