import { useId, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { InterviewType } from "@eureka/shared";
import { api } from "../api";
import { Dialog, DialogActions } from "../ui/Dialog";
import { fieldErrors } from "../sales/errors";
import { SupportCalendarBusy } from "../calendar/SupportCalendar";
import { Coaches, PanelPicker, RoundInput, TypeRadios } from "../interviews/InterviewFields";
import { pipelineError } from "./errors";
import { pipelineKeys, type Page, type Submission } from "./pipelineApi";
import { SlotPicker, slotStart, type Slot } from "./SlotPicker";
import { nextRoundName } from "./SubmissionRounds";
import { localStamp, useInterviewZone } from "./zones";

const FIELDS = ["round", "startsAt", "endsAt", "durationMin", "coachId", "meetingUrl", "interviewType", "submissionId"] as const;
type Sub = Pick<Submission, "id" | "candidateName" | "jobTitle" | "client">;
/** Board picker rows (GET /submissions): `canUpdate` false means the caller can't book on it. */
type PickRow = Sub & { status: string; canUpdate?: boolean };
const CLOSED = ["selected", "rejected", "withdrawn"];


/**
 * Schedule an interview (POST /api/v1/interviews). The one booking form, from a submission (the
 * submission is fixed) or from the Interviews board (`pickSubmission`: choose an open submission
 * first). Order: submission, round, time zone + day + start + length, then type, meeting link,
 * coach, panel and invite. The time zone is chosen up front and remembered for this browser.
 */
export function ScheduleInterviewDialog({ submission, pickSubmission = false, onClose, onScheduled, defaultRound = "", defaultType = "", withPanel = false }: {
  submission?: Sub; pickSubmission?: boolean; onClose: () => void; onScheduled: () => void;
  /** Prefilled round name (the drawer suggests the next one, e.g. L2 after L1). */
  defaultRound?: string;
  /** Preselected interview type (the board's default); empty sends none until one is picked. */
  defaultType?: InterviewType | "";
  /** Offer the panel and lead pickers. */
  withPanel?: boolean;
}) {
  const id = useId();
  const [zone, setZone] = useInterviewZone();
  const blank = { submissionId: submission?.id ?? "", round: defaultRound, coachId: "", invite: false, type: defaultType as InterviewType | "", link: "", panel: [] as string[], lead: "" };
  const [v, setV] = useState(blank);
  const set = <K extends keyof typeof blank>(k: K, val: (typeof blank)[K]) => setV((s) => ({ ...s, [k]: val }));
  const [slot, setSlot] = useState<Slot>({ day: "", time: "", durationMin: 60 });
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const subs = useInfiniteQuery({
    queryKey: ["interview-submissions"], initialPageParam: "", enabled: pickSubmission,
    queryFn: ({ pageParam }) => api<Page<PickRow>>(`/api/v1/submissions?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (p) => p.nextCursor || undefined,
  });
  const all = subs.data?.pages.flatMap((p) => p.items) ?? [];
  const options = all.filter((s) => !CLOSED.includes(s.status) && s.canUpdate !== false
    && `${s.candidateName} ${s.client} ${s.jobTitle}`.toLowerCase().includes(search.toLowerCase()));
  const chosen: Sub | undefined = submission ?? all.find((s) => s.id === v.submissionId);
  const start = slotStart(slot, zone);
  const dirty = Boolean(v.round !== defaultRound || slot.day || slot.time || v.coachId || v.link || v.panel.length || (pickSubmission && v.submissionId));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.submissionId) e.submissionId = "Choose the submission.";
    if (!v.round.trim()) e.round = "Enter the round, e.g. Technical 1.";
    if (!slot.day) e.day = "Choose the day.";
    if (!slot.time) e.time = "Choose the start time.";
    if (v.link && !/^https:\/\/\S+$/.test(v.link)) e.meetingUrl = "The meeting link must start with https:// and contain no spaces.";
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
      await api("/api/v1/interviews", { method: "POST", body: JSON.stringify({
        submissionId: v.submissionId, round: v.round.trim(), startsAt: start!.toISOString(), durationMin: slot.durationMin,
        ...(v.coachId ? { coachId: v.coachId } : {}), inviteReceived: v.invite,
        ...(v.type ? { interviewType: v.type } : {}), ...(v.link ? { meetingUrl: v.link } : {}),
        ...(v.panel.length ? { panelIds: v.panel } : {}), ...(v.lead ? { leadId: v.lead } : {}),
      }) });
      onScheduled();
    } catch (err) {
      const { _form, startsAt, endsAt, durationMin, ...rest } = fieldErrors(err, FIELDS);
      const timeErr = startsAt ?? endsAt ?? durationMin;
      setErrors({ ...rest, ...(timeErr ? { time: timeErr } : {}) });
      setFormError(_form ?? pipelineError(err, "interview"));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={submission ? `Schedule interview · ${submission.candidateName ?? "Candidate"}` : "Schedule interview"} onClose={onClose} dirty={dirty}>
      <form onSubmit={submit} noValidate className="scheduleform">
        {pickSubmission ? (
          <div className="schedule-sub">
            <div className="field">
              <label htmlFor={`${id}-find`}>Find a submission</label>
              <input id={`${id}-find`} type="search" value={search} placeholder="Candidate, client or job title" data-autofocus
                onChange={(e) => { setSearch(e.target.value); set("submissionId", ""); }} />
            </div>
            <div className="field">
              <label htmlFor={`${id}-sub`}>Submission</label>
              <select id={`${id}-sub`} required value={v.submissionId} onChange={(e) => set("submissionId", e.target.value)}
                aria-invalid={errors.submissionId ? true : undefined} aria-describedby={errors.submissionId ? `${id}-sub-err` : undefined}>
                <option value="">Select an open submission</option>
                {options.map((s) => <option key={s.id} value={s.id}>{s.candidateName} · {s.client} · {s.jobTitle}</option>)}
              </select>
              {errors.submissionId && <small id={`${id}-sub-err`} className="error fielderr">{errors.submissionId}</small>}
            </div>
            {subs.isPending && <p className="hint" role="status">Loading submissions…</p>}
            {subs.isError && <p className="error" role="alert">Could not load submissions.</p>}
            {!subs.isPending && !options.length && <p className="hint">No matching open submissions. Log a submission from the candidate profile first, or load more.</p>}
            {subs.hasNextPage && <button type="button" className="btn sm" disabled={subs.isFetchingNextPage} onClick={() => void subs.fetchNextPage()}>Load more submissions</button>}
          </div>
        ) : null}
        {chosen && <p className="hint schedule-for">{chosen.candidateName ?? "Candidate"} · {chosen.jobTitle} at {chosen.client}</p>}

        <RoundInput value={v.round} onChange={(r) => set("round", r)} error={errors.round} autoFocus={!pickSubmission} />
        <SlotPicker value={slot} onChange={setSlot} zone={zone} onZoneChange={setZone} errors={{ day: errors.day, time: errors.time }} />
        {start && <SupportCalendarBusy start={localStamp(start)} durationMin={slot.durationMin} />}

        <TypeRadios value={v.type} onChange={(t) => set("type", t)} />
        <div className="field">
          <label htmlFor={`${id}-link`}>Meeting link (optional)</label>
          <input id={`${id}-link`} type="url" maxLength={500} value={v.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…"
            aria-invalid={errors.meetingUrl ? true : undefined} aria-describedby={errors.meetingUrl ? `${id}-link-err` : undefined} />
          {errors.meetingUrl && <small id={`${id}-link-err`} className="error fielderr">{errors.meetingUrl}</small>}
        </div>
        <Coaches title="Coach (optional)" value={v.coachId} onChange={(c) => set("coachId", c)} error={errors.coachId} />
        {withPanel && <PanelPicker panel={v.panel} lead={v.lead} onPanel={(ids) => set("panel", ids)} onLead={(lid) => set("lead", lid)} />}
        <label className="check"><input type="checkbox" checked={v.invite} onChange={(e) => set("invite", e.target.checked)} /> Invite received</label>
        {pickSubmission && (
          <div className="actions left">
            <button type="button" className="btn sm" onClick={() => { setV(blank); setSlot({ day: "", time: "", durationMin: 60 }); setSearch(""); setErrors({}); }}>Reset form</button>
          </div>
        )}
        <DialogActions onCancel={onClose} submitLabel="Schedule" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}

/** The next round's name after the last held one ("L1" → "L2"), and whether any round was held. */
export function nextRoundOf(s: Pick<Submission, "interviews">) {
  const held = (s.interviews ?? []).filter((t) => t.callStatus !== "cancelled" && t.callStatus !== "no_invite");
  const last = held[held.length - 1];
  return { held: held.length > 0, round: nextRoundName(last?.round) };
}

/**
 * List-row shortcut: "Schedule interview" (or "Schedule next round") without
 * opening the drawer, offered when the submission's actions allow it.
 */
export function ScheduleInterviewButton({ submission: s, onNotice, className = "btn sm" }: {
  submission: Pick<Submission, "id" | "candidateName" | "jobTitle" | "client" | "interviews" | "actions">;
  onNotice: (m: string) => void;
  className?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!s.actions?.createInterview) return null;
  const next = nextRoundOf(s);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}
        aria-label={`Schedule ${next.held ? "next round" : "interview"} for ${s.candidateName ?? "candidate"}, ${s.jobTitle} at ${s.client}`}>
        {next.held ? "Schedule next round" : "Schedule interview"}
      </button>
      {open && (
        <ScheduleInterviewDialog submission={s} defaultRound={next.round} onClose={() => setOpen(false)}
          onScheduled={() => {
            setOpen(false); onNotice(`Interview scheduled for ${s.candidateName ?? "the candidate"}.`);
            refreshAfterSchedule(qc);
          }} />
      )}
    </>
  );
}

/** After an interview was booked: the Interviews board and the submission lists. */
export function refreshAfterSchedule(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["interviews"] });
  void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
}
