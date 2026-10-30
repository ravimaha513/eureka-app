import { useId } from "react";
import { fmtDateTime, pipelineLabel, type Submission } from "./pipelineApi";

/** Status chip for submissions and placements (colour by status class, text always present). */
export const PipelineStatus = ({ status }: { status: string }) => <span className={`badge st-${status}`}>{pipelineLabel(status)}</span>;

export const FirstPlacementBadge = () => <span className="badge first">First placement</span>;

/** Single-choice status filter as toggle chips ("All" plus each status), with optional per-status counts. */
export function StatusChips({ label, statuses, value, onChange, counts, total }: {
  label: string; statuses: readonly string[]; value: string; onChange: (v: string) => void;
  counts?: Record<string, number>; total?: number;
}) {
  const id = useId();
  const n = (v: number | undefined) => (v === undefined ? null : <span className="chipcount">{v}</span>);
  return (
    <div className="chipfilter">
      <span id={id} className="chiplabel">{label}</span>
      <div className="tabs wrap" role="group" aria-labelledby={id}>
        <button type="button" className="tab" aria-pressed={value === ""} onClick={() => onChange("")}>All{n(total)}</button>
        {statuses.map((s) => (
          <button key={s} type="button" className="tab" aria-pressed={value === s} onClick={() => onChange(value === s ? "" : s)}>
            {pipelineLabel(s)}{n(counts?.[s])}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Got an interview" filter for submission lists (value is the API's `interviewed` param). */
export function InterviewFilter({ value, onChange }: { value: string; onChange: (v: "true" | "false" | "") => void }) {
  const id = useId();
  return (
    <div className="field inline">
      <label htmlFor={id}>Interview</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as "true" | "false" | "")}>
        <option value="">Any</option>
        <option value="true">Got an interview</option>
        <option value="false">No interview yet</option>
      </select>
    </div>
  );
}

/** Interviews on a submission: count and latest date, or a dash. */
export function InterviewCell({ s }: { s: Pick<Submission, "interviewCount" | "lastInterviewAt"> }) {
  if (!s.interviewCount) return <span className="muted">—</span>;
  return (
    <>
      <span className="badge st-interview_scheduled">{s.interviewCount === 1 ? "1 interview" : `${s.interviewCount} interviews`}</span>
      {s.lastInterviewAt && <span className="block muted">Latest {fmtDateTime(s.lastInterviewAt)}</span>}
    </>
  );
}
