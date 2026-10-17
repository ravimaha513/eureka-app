import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "../sales/ui";
import { NONRESPONSE_REASONS, REASON_LABELS, RESOLUTION_LABELS, pvApi, pvError, pvKeys } from "./pipelineReportApi";

/**
 * "Candidate not responding" on the candidate profile (PV-5, PV-6). Sales who own
 * the candidate flag it; the candidate is emailed a warning that marketing will be
 * put on hold, and the recruiter and team lead are notified. The server checks every action.
 */
export function NonResponseCard({ candidateId }: { candidateId: string }) {
  const id = useId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: pvKeys.nonResponse(candidateId), queryFn: () => pvApi.nonResponse(candidateId) });
  const [reason, setReason] = useState<string>("no_reply_calls");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const d = q.data;
  if (q.isLoading) return null;
  if (!d) return null;
  if (!d.current && !d.actions.flag && d.history.length === 0) return null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(""); setMessage("");
    try {
      await fn();
      setMessage(done);
      await qc.invalidateQueries({ queryKey: pvKeys.nonResponse(candidateId) });
      void qc.invalidateQueries({ queryKey: ["pipeline-report"] });
    } catch (e) { setError(pvError(e)); } finally { setBusy(false); }
  };
  const c = d.current;

  return (
    <section className="card pad" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Responsiveness</h2>
      {c ? (
        <div className="note warn" role="status">
          <b>Not responding</b> since {fmtDate(c.flaggedAt)} ({REASON_LABELS[c.reason] ?? c.reason}){c.flaggedBy ? `, flagged by ${c.flaggedBy}` : ""}.
          <span className="block muted">
            {c.candidateWarnedAt ? `Warning emailed ${fmtDate(c.candidateWarnedAt)}.` : "The warning email to the candidate is queued."}
            {c.holdReachedAt ? ` Still not responding after the warning: decide whether to put marketing on hold or stop it.` : ""}
          </span>
        </div>
      ) : <p className="muted">The candidate is not flagged as not responding.</p>}

      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {error && <p className="banner error" role="alert">{error}</p>}

      {c && d.actions.resolve && (
        <div className="rowactions" role="group" aria-label="Resolve the flag">
          <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => pvApi.resolve(candidateId, "responded"), "Marked as responded.")}>
            Candidate responded
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => pvApi.resolve(candidateId, "flagged_in_error"), "Flag removed.")}>
            Flagged in error
          </button>
        </div>
      )}
      {!c && d.actions.flag && (
        <form className="rowactions" onSubmit={(e) => { e.preventDefault(); void act(() => pvApi.flag(candidateId, reason), "Flagged as not responding. The candidate will be warned by email."); }}>
          <div className="field inline">
            <label htmlFor={`${id}-reason`}>Reason</label>
            <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)}>
              {NONRESPONSE_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
            </select>
          </div>
          <button type="submit" className="btn sm danger" disabled={busy} aria-busy={busy || undefined}>Flag as not responding</button>
        </form>
      )}

      {d.history.length > 0 && (
        <details>
          <summary>Earlier flags ({d.history.length})</summary>
          <ul className="plain">
            {d.history.map((f) => (
              <li key={f.id}>{fmtDate(f.flaggedAt)}: {REASON_LABELS[f.reason] ?? f.reason}
                {f.resolution ? ` · ${RESOLUTION_LABELS[f.resolution] ?? f.resolution} ${fmtDate(f.resolvedAt)}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
