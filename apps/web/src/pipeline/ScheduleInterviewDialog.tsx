import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogActions } from "../ui/Dialog";
import { LookupPicker } from "../lookups";
import { fieldErrors } from "../sales/errors";
import { Field } from "../sales/ui";
import { pipelineError } from "./errors";
import { pipelineApi, pipelineKeys, type Submission } from "./pipelineApi";
import { SlotPicker, slotStart, type Slot } from "./SlotPicker";
import { nextRoundName } from "./SubmissionRounds";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const FIELDS = ["round", "startsAt", "endsAt", "durationMin", "coachId"] as const;

/** Schedule an interview for one submission (POST /api/v1/interviews); same rules as the Interviews board. */
export function ScheduleInterviewDialog({ submission, onClose, onScheduled, defaultRound = "" }: {
  submission: Pick<Submission, "id" | "candidateName" | "jobTitle" | "client">; onClose: () => void; onScheduled: () => void;
  /** Prefilled round name (the drawer suggests the next one, e.g. L2 after L1). */
  defaultRound?: string;
}) {
  const [v, setV] = useState({ round: defaultRound, coachId: "", invite: false });
  const [slot, setSlot] = useState<Slot>({ day: "", time: "", durationMin: 60 });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: "round") => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.round.trim()) e.round = "Enter the round, e.g. Technical 1.";
    if (!slot.day) e.day = "Choose the day.";
    if (!slot.time) e.time = "Choose the start time.";
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
        startsAt: slotStart(slot)!.toISOString(), durationMin: slot.durationMin,
        ...(v.coachId ? { coachId: v.coachId } : {}), inviteReceived: v.invite,
      });
      onScheduled();
    } catch (err) {
      const { _form, startsAt, endsAt, durationMin, ...rest } = fieldErrors(err, FIELDS);
      const timeErr = startsAt ?? endsAt ?? durationMin;
      setErrors({ ...rest, ...(timeErr ? { time: timeErr } : {}) });
      setFormError(_form ?? pipelineError(err, "interview"));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Schedule interview · ${submission.candidateName ?? "Candidate"}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="hint">{submission.jobTitle} at {submission.client}.</p>
        <Field label="Round" error={errors.round}>
          {(p) => <input {...p} maxLength={40} value={v.round} onChange={set("round")} data-autofocus />}
        </Field>
        <SlotPicker value={slot} onChange={setSlot} zone={zone} errors={{ day: errors.day, time: errors.time }} />
        <LookupPicker kind="coaches" label="Coach (optional)" optional placeholder="Unassigned" value={v.coachId} error={errors.coachId}
          onChange={(id) => setV((s) => ({ ...s, coachId: id }))} />
        <label className="check"><input type="checkbox" checked={v.invite} onChange={(e) => setV((s) => ({ ...s, invite: e.target.checked }))} /> Invite received</label>
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
