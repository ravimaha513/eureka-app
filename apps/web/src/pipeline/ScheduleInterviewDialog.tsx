import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogActions } from "../ui/Dialog";
import { LookupPicker } from "../lookups";
import { fieldErrors } from "../sales/errors";
import { Field } from "../sales/ui";
import { pipelineError } from "./errors";
import { pipelineApi, pipelineKeys, type Submission } from "./pipelineApi";
import { nextRoundName } from "./SubmissionRounds";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAX_MS = 12 * 60 * 60 * 1000;
const FIELDS = ["round", "startsAt", "endsAt", "coachId"] as const;

/** Schedule an interview for one submission (POST /api/v1/interviews); same rules as the Interviews board. */
export function ScheduleInterviewDialog({ submission, onClose, onScheduled, defaultRound = "" }: {
  submission: Pick<Submission, "id" | "candidateName" | "jobTitle" | "client">; onClose: () => void; onScheduled: () => void;
  /** Prefilled round name (the drawer suggests the next one, e.g. L2 after L1). */
  defaultRound?: string;
}) {
  const [v, setV] = useState({ round: defaultRound, start: "", end: "", coachId: "", invite: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: "round" | "start" | "end") => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.round.trim()) e.round = "Enter the round, e.g. Technical 1.";
    if (!v.start) e.start = "Choose the start time.";
    if (!v.end) e.end = "Choose the end time.";
    if (v.start && v.end) {
      const ms = new Date(v.end).getTime() - new Date(v.start).getTime();
      if (!(ms > 0)) e.end = "End must be after start.";
      else if (ms > MAX_MS) e.end = "An interview can last at most 12 hours.";
    }
    return e;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError("");
    if (Object.keys(e).length) {
      // After React applies this round's errors, so stale marks from an earlier attempt don't win.
      const form = ev.currentTarget;
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setBusy(true);
    try {
      await pipelineApi.createInterview({
        submissionId: submission.id, round: v.round.trim(),
        startsAt: new Date(v.start).toISOString(), endsAt: new Date(v.end).toISOString(),
        ...(v.coachId ? { coachId: v.coachId } : {}), inviteReceived: v.invite,
      });
      onScheduled();
    } catch (err) {
      const { _form, startsAt, endsAt, ...rest } = fieldErrors(err, FIELDS);
      setErrors({ ...rest, ...(startsAt ? { start: startsAt } : {}), ...(endsAt ? { end: endsAt } : {}) });
      setFormError(_form ?? pipelineError(err, "interview"));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Schedule interview · ${submission.candidateName ?? "Candidate"}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="hint">{submission.jobTitle} at {submission.client}. Times are in {zone}.</p>
        <Field label="Round" error={errors.round}>
          {(p) => <input {...p} maxLength={40} value={v.round} onChange={set("round")} data-autofocus />}
        </Field>
        <Field label="Start" error={errors.start}>
          {(p) => <input {...p} type="datetime-local" value={v.start} onChange={set("start")} />}
        </Field>
        <Field label="End" error={errors.end}>
          {(p) => <input {...p} type="datetime-local" value={v.end} onChange={set("end")} />}
        </Field>
        <LookupPicker kind="coaches" label="Coach (optional)" optional placeholder="Unassigned" value={v.coachId} error={errors.coachId}
          onChange={(id) => setV((s) => ({ ...s, coachId: id }))} />
        <div className="field">
          <label className="check"><input type="checkbox" checked={v.invite} onChange={(e) => setV((s) => ({ ...s, invite: e.target.checked }))} /> Invite received</label>
        </div>
        <DialogActions onCancel={onClose} submitLabel="Schedule" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}

/**
 * List-row shortcut: "Schedule interview" (or "Schedule next round") without
 * opening the drawer, offered when the submission's actions allow it.
 */
export function ScheduleInterviewButton({ submission: s, onNotice }: {
  submission: Pick<Submission, "id" | "candidateName" | "jobTitle" | "client" | "interviews" | "actions">;
  onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!s.actions?.createInterview) return null;
  const held = (s.interviews ?? []).filter((t) => t.callStatus !== "cancelled" && t.callStatus !== "no_invite");
  const last = held[held.length - 1];
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)}
        aria-label={`Schedule ${last ? "next round" : "interview"} for ${s.candidateName ?? "candidate"}, ${s.jobTitle} at ${s.client}`}>
        {last ? "Schedule next round" : "Schedule interview"}
      </button>
      {open && (
        <ScheduleInterviewDialog submission={s} defaultRound={nextRoundName(last?.round)} onClose={() => setOpen(false)}
          onScheduled={() => {
            setOpen(false); onNotice(`Interview scheduled for ${s.candidateName ?? "the candidate"}.`);
            void qc.invalidateQueries({ queryKey: ["interviews"] });
            void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
          }} />
      )}
    </>
  );
}
