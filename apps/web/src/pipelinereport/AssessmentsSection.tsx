import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "../sales/ui";
import {
  ASSESSMENT_PLATFORMS, ASSESSMENT_STATUSES, ASSESSMENT_STATUS_LABELS, PLATFORM_LABELS, pvApi, pvError, pvKeys,
  type Assessment, type AssessmentInput,
} from "./pipelineReportApi";
import { localToday } from "../employees/employeesApi";

const DONE = new Set(["completed", "passed", "failed"]);

/** Assessments ("gliders") of a submission, in the submission drawer (PV-3, PV-4). */
export function AssessmentsSection({ submissionId }: { submissionId: string }) {
  const id = useId();
  const q = useQuery({ queryKey: pvKeys.assessments(submissionId), queryFn: () => pvApi.assessments(submissionId) });
  const [editing, setEditing] = useState<Assessment | "new" | null>(null);
  const d = q.data;
  // A load failure is not announced as an alert: the drawer's own alerts belong to its actions.
  if (!d) return q.error ? <p className="muted">Assessments could not be loaded. {pvError(q.error)}</p> : null;
  if (d.items.length === 0 && !d.actions.create) return null;

  return (
    <section className="manageblock" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Assessments</h3>
      {d.items.length === 0 ? <p className="muted">No assessments recorded.</p> : (
        <ul className="plain">
          {d.items.map((a) => (
            <li key={a.id}>
              <b>{PLATFORM_LABELS[a.platform] ?? a.platform}</b>{" "}
              <span className={`badge st-${a.status === "passed" ? "joined" : a.status === "failed" ? "backout" : "confirmed"}`}>
                {ASSESSMENT_STATUS_LABELS[a.status] ?? a.status}</span>
              <span className="block muted">
                Assigned {fmtDate(a.assignedOn)}{a.dueOn ? ` · due ${fmtDate(a.dueOn)}` : ""}
                {a.completedOn ? ` · completed ${fmtDate(a.completedOn)}` : ""}{a.score !== null ? ` · score ${a.score}` : ""}
              </span>
              {d.actions.update && editing === null && (
                <button type="button" className="btn sm" onClick={() => setEditing(a)} aria-label={`Edit the ${PLATFORM_LABELS[a.platform] ?? a.platform} assessment`}>Edit</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <AssessmentForm submissionId={submissionId} current={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
      ) : d.actions.create && (
        <button type="button" className="btn sm" onClick={() => setEditing("new")}>Record assessment</button>
      )}
    </section>
  );
}

function AssessmentForm({ submissionId, current, onDone }: { submissionId: string; current: Assessment | null; onDone: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [v, setV] = useState<AssessmentInput>(current
    ? { platform: current.platform, status: current.status, assignedOn: current.assignedOn, dueOn: current.dueOn, completedOn: current.completedOn, score: current.score }
    : { platform: "glider", status: "assigned", assignedOn: localToday(), dueOn: null, completedOn: null, score: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof AssessmentInput>(k: K, val: AssessmentInput[K]) => setV((o) => ({ ...o, [k]: val }));
  const needsDate = DONE.has(v.status) && !v.completedOn;

  const submit = async () => {
    setBusy(true); setError("");
    try {
      if (current) await pvApi.updateAssessment(current, v);
      else await pvApi.createAssessment(submissionId, v);
      await qc.invalidateQueries({ queryKey: pvKeys.assessments(submissionId) });
      void qc.invalidateQueries({ queryKey: ["pipeline-report"] });
      onDone();
    } catch (e) { setError(pvError(e)); } finally { setBusy(false); }
  };

  return (
    <form className="stack" aria-label={current ? "Edit assessment" : "Record assessment"} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="field">
        <label htmlFor={`${id}-pl`}>Platform</label>
        <select id={`${id}-pl`} value={v.platform} onChange={(e) => set("platform", e.target.value)}>
          {ASSESSMENT_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-st`}>Status</label>
        <select id={`${id}-st`} value={v.status} onChange={(e) => set("status", e.target.value)}>
          {ASSESSMENT_STATUSES.map((s) => <option key={s} value={s}>{ASSESSMENT_STATUS_LABELS[s]}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-as`}>Assigned on</label>
        <input id={`${id}-as`} type="date" required value={v.assignedOn} onChange={(e) => set("assignedOn", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-du`}>Due on (optional)</label>
        <input id={`${id}-du`} type="date" value={v.dueOn ?? ""} min={v.assignedOn} onChange={(e) => set("dueOn", e.target.value || null)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-co`}>Completed on{DONE.has(v.status) ? "" : " (optional)"}</label>
        <input id={`${id}-co`} type="date" value={v.completedOn ?? ""} min={v.assignedOn} required={DONE.has(v.status)}
          aria-invalid={needsDate || undefined} onChange={(e) => set("completedOn", e.target.value || null)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-sc`}>Score 0-100 (optional)</label>
        <input id={`${id}-sc`} type="number" min={0} max={100} step={1} value={v.score ?? ""}
          onChange={(e) => set("score", e.target.value === "" ? null : Number(e.target.value))} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="rowactions">
        <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={busy || needsDate} aria-busy={busy || undefined}>{current ? "Save" : "Record"}</button>
      </div>
    </form>
  );
}
