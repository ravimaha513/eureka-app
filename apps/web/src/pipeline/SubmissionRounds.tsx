import { useId, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ResultBadge, type Interview } from "../interviews/InterviewsPage";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { pipelineError } from "./errors";
import { fmtDateTime, pipelineApi, pipelineKeys, pipelineLabel, type Submission } from "./pipelineApi";

const dead = (i: Pick<Interview, "callStatus">) => i.callStatus === "cancelled" || i.callStatus === "no_invite";
const CLOSED = new Set(["rejected", "withdrawn"]);

/** The next round's name after `round` when it ends in a number ("L1" → "L2", "Technical 2" → "Technical 3"). */
export function nextRoundName(round: string | undefined): string {
  const m = round?.trim().match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}` : "";
}

/**
 * Submission drawer: every interview round in time order with its result
 * (IS-10). Sales can mark a round cleared or rejected (and back), and from the
 * latest held round clear it and place the candidate (IS-11).
 */
export function SubmissionRounds({ submission: s, onPlace, onReject, onSchedule, onNotice }: {
  submission: Submission;
  /** Opens the reject-round dialog (rendered by the drawer, which suspends itself while it's open). */
  onReject: (round: Interview) => void;
  /** Opens the placement dialog for this round (cleared first when still pending). */
  onPlace: (round: Interview) => void;
  onSchedule: (defaultRound: string) => void;
  onNotice: (m: string) => void;
}) {
  const headId = useId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: pipelineKeys.rounds(s.id), queryFn: () => pipelineApi.submissionInterviews(s.id) });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rounds = q.data?.items ?? [];
  const live = rounds.filter((r) => !dead(r));
  const latest = live[live.length - 1];
  const anyRejected = live.some((r) => r.result === "rejected");
  const placed = Boolean(s.placementStatus);
  const open = !CLOSED.has(s.status) && !placed;
  const canPlace = Boolean(s.actions?.clearAndPlace) && !placed && !anyRejected;

  const refresh = () => refreshRounds(qc, s.id);
  const setResult = async (r: Interview, result: "pending" | "cleared") => {
    setBusy(r.id); setError("");
    try {
      await pipelineApi.setInterviewResult(r.id, result);
      onNotice(result === "cleared" ? `${r.round} marked cleared.` : `${r.round} reset to pending.`);
      refresh();
    } catch (e) { setError(pipelineError(e, "interview")); }
    finally { setBusy(null); }
  };

  return (
    <section className="manageblock rounds" aria-labelledby={headId}>
      <h3 id={headId}>Interview rounds{rounds.length ? ` · ${rounds.length}` : ""}</h3>
      {q.isLoading ? <Loading /> : q.error ? <p className="error" role="alert">{pipelineError(q.error, "interview")}</p> : (
        <>
          {rounds.length === 0 && <p className="hint">No interviews yet. Schedule the first round when the client asks for one.</p>}
          <ol className="roundlist">
            {rounds.map((r, i) => {
              const editable = open && r.editableFields.includes("result");
              const isLatest = r === latest;
              const state = dead(r) ? "dead" : r.result === "cleared" ? "ok" : r.result === "rejected" ? "no" : "wait";
              const meta = [fmtDateTime(r.startsAt), r.interviewType ? pipelineLabel(r.interviewType) : null,
                r.coach?.name ? `Coach ${r.coach.name}` : null, dead(r) ? pipelineLabel(r.callStatus) : null].filter(Boolean).join(" · ");
              return (
                <li key={r.id} className={`round ${state}${isLatest && open ? " current" : ""}`}>
                  <span className="round-dot" aria-hidden="true">{state === "ok" ? "✓" : state === "no" ? "✗" : i + 1}</span>
                  <div className="round-body">
                    <div className="round-head">
                      <b>Round {i + 1} · {r.round}</b>
                      {dead(r) ? <span className="muted">{pipelineLabel(r.callStatus)}</span> : <ResultBadge result={r.result} />}
                    </div>
                    <span className="muted">{meta}</span>
                    {editable && !dead(r) && (
                      <div className="rowactions" role="group" aria-label={`Result of ${r.round}`}>
                        {r.result === "pending" ? (
                          <>
                            <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === r.id || undefined}
                              onClick={() => void setResult(r, "cleared")}>Mark cleared</button>
                            <button type="button" className="btn sm danger" disabled={busy !== null} onClick={() => onReject(r)}>Mark rejected…</button>
                          </>
                        ) : (
                          <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === r.id || undefined}
                            onClick={() => void setResult(r, "pending")}>Reset to pending</button>
                        )}
                        {isLatest && canPlace && r.result !== "rejected" && (
                          <button type="button" className="btn sm primary" disabled={busy !== null} onClick={() => onPlace(r)}>
                            {r.result === "cleared" ? "Create placement" : "Clear and place"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {error && <p className="banner error" role="alert">{error}</p>}
          {s.actions?.createInterview && (
            <div className="rowactions">
              <button type="button" className="btn sm" onClick={() => onSchedule(nextRoundName(latest?.round))}>
                {rounds.length ? "Schedule next round" : "Schedule interview"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** After a round or its submission changed: the timeline, the submission lists and the Interviews board. */
export function refreshRounds(qc: QueryClient, submissionId: string) {
  void qc.invalidateQueries({ queryKey: pipelineKeys.rounds(submissionId) });
  void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
  void qc.invalidateQueries({ queryKey: ["interviews"] });
}

/** Mark a round rejected; optionally reject the whole submission too (some clients give a second chance, so it's a choice). */
export function RejectRoundDialog({ submission, round, canRejectSubmission, onClose, onDone }: {
  submission: Submission; round: Interview; canRejectSubmission: boolean; onClose: () => void; onDone: (alsoSubmission: boolean) => void;
}) {
  const id = useId();
  const [also, setAlso] = useState(canRejectSubmission);
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState("");
  const submit = useSubmit((e) => pipelineError(e, "submission"));
  return (
    <Dialog title={`Mark ${round.round} rejected?`} onClose={onClose}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        if (also && !reason.trim()) { setFieldErr("Give a rejection reason for the submission."); return; }
        setFieldErr("");
        void submit.run(async () => {
          if (round.result !== "rejected") await pipelineApi.setInterviewResult(round.id, "rejected");
          if (also) await pipelineApi.changeSubmissionStatus(submission.id, "rejected", reason.trim());
          onDone(also);
        });
      }}>
        <p className="hint">{submission.candidateName ?? "The candidate"} didn't clear {round.round} for {submission.jobTitle} at {submission.client}.</p>
        {canRejectSubmission && (
          <label className="check">
            <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
            {" "}Also reject the submission (closes it; no more rounds)
          </label>
        )}
        {also && (
          <div className="field">
            <label htmlFor={`${id}-reason`}>Rejection reason</label>
            <textarea id={`${id}-reason`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus
              aria-invalid={fieldErr ? true : undefined} aria-describedby={fieldErr ? `${id}-err` : undefined} />
            {fieldErr && <small id={`${id}-err`} className="error fielderr">{fieldErr}</small>}
          </div>
        )}
        <DialogActions onCancel={onClose} submitLabel={also ? "Reject round and submission" : "Mark rejected"} danger busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
