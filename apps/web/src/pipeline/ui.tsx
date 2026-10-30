import { useId } from "react";
import { INTERVIEW_STAGE_LABELS, type InterviewStage } from "@eureka/shared";
import { fmtDateTime, pipelineLabel, type Submission, type SubmissionSummary, type TrailStep } from "./pipelineApi";

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

/** The funnel steps in order; a submission "reaches" a stage with a live interview of that stage. */
export const FUNNEL_STAGES = ["screening", "l1", "l2", "l3", "final"] as const satisfies readonly InterviewStage[];

/**
 * How far submissions got, one select: the API's `interviewed` param ("true"/"false")
 * or `stage` (an interview stage or "placed"). Value is "", "true", "false" or "stage:<s>".
 */
export type Reached = { interviewed: "true" | "false" | ""; stage: string };
export const reachedValue = (r: Reached) => (r.stage ? `stage:${r.stage}` : r.interviewed);
export const parseReached = (v: string): Reached =>
  v.startsWith("stage:") ? { interviewed: "", stage: v.slice(6) } : { interviewed: v === "true" || v === "false" ? v : "", stage: "" };

export function ReachedFilter({ value, onChange }: { value: Reached; onChange: (v: Reached) => void }) {
  const id = useId();
  return (
    <div className="field inline">
      <label htmlFor={id}>Interview</label>
      <select id={id} value={reachedValue(value)} onChange={(e) => onChange(parseReached(e.target.value))}>
        <option value="">Any</option>
        <option value="true">Got an interview</option>
        <option value="false">No interview yet</option>
        {[...FUNNEL_STAGES, "other" as const].map((st) => <option key={st} value={`stage:${st}`}>Reached {INTERVIEW_STAGE_LABELS[st]}</option>)}
        <option value="stage:placed">Placed</option>
      </select>
    </div>
  );
}

const pct = (n: number, of: number) => (of > 0 ? `${n / of < 0.01 && n > 0 ? (Math.round((n / of) * 1000) / 10) : Math.round((n / of) * 100)}%` : "—");

/**
 * Submission funnel: Submitted -> Got an interview -> Screening -> L1 -> L2 -> L3+ -> Final -> Placed,
 * each step with its count and the share of the step before it. Clicking a step filters the list to it.
 */
export function PipelineFunnel({ summary, value, onPick }: {
  summary: SubmissionSummary; value: Reached; onPick: (r: Reached) => void;
}) {
  const f = summary.funnel;
  if (!f) return null;
  type Step = { key: string; label: string; n: number; hint?: string; reached: Reached };
  const steps: Step[] = [
    { key: "all", label: "Submitted", n: f.submitted, reached: { interviewed: "", stage: "" } },
    { key: "iv", label: "Got an interview", n: f.interviewed, reached: { interviewed: "true", stage: "" } },
    ...FUNNEL_STAGES.map((st) => ({
      key: st, label: INTERVIEW_STAGE_LABELS[st], n: f.stages[st].held,
      hint: f.stages[st].held ? `${f.stages[st].cleared} cleared` : undefined,
      reached: { interviewed: "" as const, stage: st },
    })),
    { key: "placed", label: "Placed", n: f.placed, reached: { interviewed: "", stage: "placed" } },
  ];
  const other = f.stages.other.held;
  const current = reachedValue(value);
  return (
    <section className="funnel" aria-label="Submission funnel">
      <ol>
        {steps.map((st, i) => {
          // Compare with the last earlier step that has submissions (stages can be skipped, e.g. no screening).
          const base = steps.slice(0, i).reverse().find((x) => x.n > 0);
          const on = reachedValue(st.reached) === current;
          return (
            <li key={st.key} className={st.n === 0 && i > 0 ? "zero" : undefined}>
              <button type="button" aria-pressed={on} onClick={() => onPick(on && i > 0 ? { interviewed: "", stage: "" } : st.reached)}>
                <b>{st.n}</b>
                <span className="fl-label">{st.label}</span>
                <span className="fl-hint">{i === 0 ? "All submissions" : base ? `${pct(st.n, base.n)} of ${base.label}` : "\u00a0"}</span>
                {st.hint && <span className="fl-hint">{st.hint}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {other > 0 && (
        <p className="muted fl-other">
          Plus {other} {other === 1 ? "submission" : "submissions"} with other rounds (manager, client, HR).{" "}
          <button type="button" className="btn sm" onClick={() => onPick({ interviewed: "", stage: "other" })}>Show them</button>
        </p>
      )}
    </section>
  );
}

const RESULT_MARK: Record<string, string> = { cleared: "✓", rejected: "✗" };

/** One interview in a trail: stage label, result mark, round and date in the tooltip. */
function TrailChip({ t }: { t: TrailStep }) {
  const dead = t.callStatus === "cancelled" || t.callStatus === "no_invite";
  const upcoming = !dead && t.result === "pending" && Date.parse(t.startsAt) > Date.now();
  const state = dead ? "dead" : t.result === "cleared" ? "ok" : t.result === "rejected" ? "no" : upcoming ? "next" : "held";
  const label = t.stage === "other" ? t.round : INTERVIEW_STAGE_LABELS[t.stage];
  const desc = dead ? pipelineLabel(t.callStatus) : t.result === "pending" ? (upcoming ? "Upcoming" : "Result pending") : pipelineLabel(t.result);
  return (
    <li className={`trail-step ${state}`} title={`${t.round} · ${fmtDateTime(t.startsAt)} · ${desc}`}>
      {label}{RESULT_MARK[t.result] && !dead ? ` ${RESULT_MARK[t.result]}` : ""}
      <span className="sr-only"> ({t.round}, {desc}, {fmtDateTime(t.startsAt)})</span>
    </li>
  );
}

/** Per-submission path: each interview round in order, then the placement when there is one. */
export function StageTrail({ s }: { s: Pick<Submission, "interviews" | "placementStatus" | "interviewCount" | "lastInterviewAt"> }) {
  if (!s.interviews) return <InterviewCell s={s} />;
  if (s.interviews.length === 0 && !s.placementStatus) return <span className="muted">—</span>;
  return (
    <ol className="trail" aria-label="Interview rounds">
      {s.interviews.map((t, i) => <TrailChip key={i} t={t} />)}
      {s.placementStatus && <li className="trail-step placed">Placed · {pipelineLabel(s.placementStatus)}</li>}
    </ol>
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
