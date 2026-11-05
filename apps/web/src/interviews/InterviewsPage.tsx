import { useEffect, useId, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, Minus } from "lucide-react";
import {
  INTERVIEW_TYPE_LABELS, SCORECARD_CRITERIA, SCORECARD_KINDS, SCORECARD_LABELS, INTERVIEW_RESULTS, isSafeHttpsUrl,
  type InterviewResult, type InterviewType, type Scorecard,
} from "@eureka/shared";
import { api, can, ifMatch, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { Menu } from "../ui/Menu";
import { RecordLink } from "../ui/RecordLink";
import { useLookups } from "../lookups";
import { Drawer } from "../sales/ui";
import { CreatePlacementDialog } from "../pipeline/CreatePlacementDialog";
import { ScheduleInterviewDialog, refreshAfterSchedule } from "../pipeline/ScheduleInterviewDialog";
import { useBatchOptions, useDebouncedParam } from "../pipeline/ui";
import { pipelineLabel } from "../pipeline/pipelineApi";
import {
  LOCAL_ZONE, dayIn, fmtDay, fmtRange, fmtSlot, localStamp, stampToInstant, todayIn, useInterviewZone, zoneAbbr, zoneDayBoundary, zoneOptions, zoneStamp,
} from "../pipeline/zones";
import { useSearchParams } from "../lib/router";
import { SupportCalendarBlock, SupportCalendarBusy, SupportCalendarCard } from "../calendar/SupportCalendar";
import {
  CALL_STATUSES, CallStatus, Coaches, DurationSelect, Field, PanelPicker, RESULT_LABELS, ResultBadge, RoundInput, TypeRadios, callStatusLabel,
} from "./InterviewFields";
import "../pipeline/pipeline.css";
import "./interviews.css";

export { RESULT_LABELS, ResultBadge };

const errorText = (e: unknown) => e instanceof Error ? e.message : "Unable to save. Please try again.";
type Named = { id: string; name: string | null };
export interface Interview {
  id: string; submissionId: string; candidate: Named; recruiter: Named; team: Named | null; location: Named | null;
  client: Named | null; round: string; startsAt: string; endsAt: string; coach: Named | null;
  inviteReceived: boolean; callStatus: string; cleared: boolean; consentCaptured: boolean;
  otterUrl: string | null; recordingUrl: string | null; systemName: string | null;
  editableFields: string[]; feedbackKinds: string[];
  /** interviews-settings (migration 0080). */
  position?: string | null; interviewType?: InterviewType | null; meetingUrl?: string | null; durationMin?: number;
  /** interview-reports (migration 0130): latest feedback the candidate sent through the feedback email. */
  candidateFeedback?: { rating: number | null; notes: string | null; submittedAt: string } | null;
  /** Outcome of the round (migration 0360); `cleared` is the location's pre-call readiness. */
  result?: InterviewResult; resultAt?: string | null;
  submissionStatus?: string | null; placement?: { id: string; status: string } | null;
  /** The optional If-Match for PATCH and clear-and-select (IS-12, migration 0508); absent on older servers. */
  rowVersion?: number;
}

/** Board cell: the candidate's own feedback (rating and a short excerpt; the full text is in the Feedback dialog). */
export function CandidateFeedbackCell({ f }: { f: Interview["candidateFeedback"] }) {
  if (!f) return <span className="muted">No feedback yet</span>;
  const notes = f.notes?.trim() ?? "";
  const excerpt = notes.length > 120 ? `${notes.slice(0, 117)}…` : notes;
  return <>{f.rating !== null ? <Stars value={f.rating} label="Candidate rating" /> : <span>No rating</span>}{excerpt && <span className="block cf-notes" title={notes}>{excerpt}</span>}</>;
}
export interface InterviewDetail extends Interview {
  panel: { id: string; name: string; lead: boolean }[];
  lead: { id: string; name: string } | null;
}
export interface FeedbackItem {
  id: string; kind: string; rating: number | null; notes: string | null; author: Named | null; round?: string;
  scorecard?: Scorecard | null;
  format?: string | null; topics?: string[] | null; difficultQuestions?: string | null; durationMin?: number | null; nextStep?: string | null;
}
interface Page<T> { items: T[]; nextCursor: string | null }
export function localInput(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** Local midnight of `day` (or of the next day) as an instant: inclusive day filters in the browser's zone. */
export function dateBoundary(day: string, next = false) {
  const d = new Date(`${day}T00:00:00`);
  if (next) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
const KIND_LABELS: Record<string, string> = { coach: "Interview coach", location: "Location", client: "Client (relayed)", candidate: "Candidate" };
const kindLabel = (k: string) => KIND_LABELS[k] ?? pipelineLabel(k);
const safeLink = (u: string | null | undefined) => (u && /^https:\/\/\S+$/.test(u) ? u : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Read-only star row: one accessible name ("4 out of 5"), the stars are decoration. */
export function Stars({ value, label: name }: { value: number; label?: string }) {
  const text = `${value} out of 5`;
  return (
    <span className="stars" role="img" aria-label={name ? `${name}: ${text}` : text}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} aria-hidden="true" className={n <= value ? "star on" : "star"}>★</span>)}
    </span>
  );
}

/** One readiness fact as a check or a dash, with the full words for screen readers and on hover. */
function Flag({ on, label, yes, no }: { on: boolean; label: string; yes: string; no: string }) {
  return (
    <span className={on ? "iv-flag on" : "iv-flag"} title={on ? yes : no}>
      {on ? <Check size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
      <span aria-hidden="true">{label}</span><span className="sr-only">{on ? yes : no}</span>
    </span>
  );
}

/** Readiness in one line: Cleared chip (or "Not cleared"), then invite and consent as checks. */
function Readiness({ i }: { i: Interview }) {
  return (
    <span className="iv-ready">
      {i.cleared ? <span className="badge st-selected">Ready</span> : <span className="muted">Not cleared</span>}
      <Flag on={i.inviteReceived} label="Invite" yes="Invite received" no="Awaiting invite" />
      <Flag on={i.consentCaptured} label="Consent" yes="Consent captured" no="Consent pending" />
    </span>
  );
}

/** Otter / recording links, only once consent is captured. */
function Recordings({ i }: { i: Interview }) {
  if (!i.consentCaptured) return <span className="muted">Consent required</span>;
  if (!i.otterUrl && !i.recordingUrl) return <span className="muted">—</span>;
  return (
    <span className="iv-links">
      {i.otterUrl && (isSafeHttpsUrl(i.otterUrl) ? <a href={i.otterUrl} target="_blank" rel="noopener noreferrer">Otter</a> : "Otter")}
      {i.recordingUrl && (isSafeHttpsUrl(i.recordingUrl) ? <a href={i.recordingUrl} target="_blank" rel="noopener noreferrer">Recording</a> : "Recording")}
    </span>
  );
}

function Edit({ item, zone, onClose, onDone }: { item: Interview; zone: string; onClose: () => void; onDone: () => void }) {
  const detail = useQuery({ queryKey: ["interview", item.id], queryFn: () => api<InterviewDetail>(`/api/v1/interviews/${item.id}`), enabled: item.editableFields.includes("panelIds") });
  // Slot fields are entered in the board's time zone.
  const initial: Record<string, string | boolean | number> = {
    round: item.round, startsAt: zoneStamp(item.startsAt, zone), endsAt: zoneStamp(item.endsAt, zone), coachId: item.coach?.id ?? "", inviteReceived: item.inviteReceived,
    callStatus: item.callStatus, result: item.result ?? "pending", cleared: item.cleared, consentCaptured: item.consentCaptured, systemName: item.systemName ?? "",
    otterUrl: item.otterUrl ?? "", recordingUrl: item.recordingUrl ?? "", interviewType: item.interviewType ?? "", meetingUrl: item.meetingUrl ?? "",
    durationMin: item.durationMin ?? Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000),
  };
  const [values, setValues] = useState(initial); const submit = useSubmit(errorText);
  const [panel, setPanel] = useState<string[] | null>(null); const [lead, setLead] = useState<string | null>(null);
  const curPanel = panel ?? detail.data?.panel.map((p) => p.id) ?? []; const curLead = lead ?? detail.data?.lead?.id ?? "";
  const set = (k: string, v: string | boolean | number) => setValues(s => ({ ...s, [k]: v }));
  const can = (k: string) => item.editableFields.includes(k);
  // A duration in the allowed range replaces the end time in the form.
  const useDuration = can("durationMin") && Number(initial.durationMin) >= 15 && Number(initial.durationMin) <= 240;
  const title: Record<string, string> = { round: "Round", startsAt: "Interview slot", endsAt: "End", inviteReceived: "Invite received", callStatus: "Call status", result: "Interview result", cleared: "Cleared for interview (readiness)", consentCaptured: "Consent captured", systemName: "System name", otterUrl: "Otter URL", recordingUrl: "Recording URL", meetingUrl: "Meeting link" };
  const order = ["interviewType", "round", "startsAt", "durationMin", "endsAt", "meetingUrl", "coachId", "callStatus", "result", "systemName", "otterUrl", "recordingUrl", "inviteReceived", "cleared", "consentCaptured"];
  const shown = order.filter(can);
  const first = shown.find((k) => k !== "interviewType");
  const instant = (k: string) => stampToInstant(String(values[k]), zone);
  // CA-7: the support calendar's state for the slot being edited, under the duration (or the end time).
  const editDuration = useDuration ? Number(values.durationMin) : Math.round((+(instant("endsAt") ?? 0) - +(instant("startsAt") ?? 0)) / 60_000);
  const startAt = instant("startsAt");
  const busyLine = can("startsAt") && startAt ? <SupportCalendarBusy key="busy" start={localStamp(startAt)} durationMin={editDuration} interviewId={item.id} /> : null;
  const dirty = Object.keys(initial).some((k) => values[k] !== initial[k]) || panel !== null || lead !== null;
  const checks = shown.filter((k) => typeof values[k] === "boolean");
  return <Dialog title={`Edit interview · ${item.candidate.name}`} onClose={onClose} dirty={dirty}><form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    const body: Record<string, unknown> = {};
    for (const k of order) {
      if (!can(k) || values[k] === initial[k]) continue;
      if (k === "endsAt" && useDuration) continue;
      if (k === "durationMin" && !useDuration) continue;
      if (["startsAt", "endsAt"].includes(k)) {
        const at = instant(k);
        if (!at) throw new Error(`Enter the ${k === "startsAt" ? "interview slot" : "end time"}.`);
        body[k] = at.toISOString();
      } else body[k] = values[k] === "" ? null : values[k];
    }
    // A moved slot keeps its duration: send it so the server recomputes the end.
    if (useDuration && body.startsAt !== undefined && body.durationMin === undefined) body.durationMin = values.durationMin;
    if (body.meetingUrl && !/^https:\/\/\S+$/.test(String(body.meetingUrl))) throw new Error("The meeting link must start with https:// and contain no spaces.");
    if (panel !== null || lead !== null) { body.panelIds = curPanel; body.leadId = curLead || null; }
    if (Object.keys(body).length) {
      await api(`/api/v1/interviews/${item.id}`, { method: "PATCH", body: JSON.stringify(body), headers: ifMatch(item.rowVersion) });
    }
    onDone();
  }); }}>
    <p className="hint iv-editfor">{[item.candidate.name, item.position, item.client?.name].filter(Boolean).join(" · ")}</p>
    {(can("startsAt") || can("endsAt")) && <p className="hint">Times in {zone} ({zoneAbbr(zone, item.startsAt)}). Change the zone on the board.</p>}
    {(can("otterUrl") || can("recordingUrl")) && <p className="hint">Recording links require captured consent.</p>}
    {shown.map(k => {
      const auto = k === first ? { "data-autofocus": true } : {};
      if (k === "interviewType") return <TypeRadios key={k} value={String(values[k])} onChange={(t) => set(k, t)} />;
      if (k === "round") return <RoundInput key={k} value={String(values[k])} onChange={(r) => set(k, r)} autoFocus={k === first} />;
      if (k === "durationMin") return useDuration ? [<DurationSelect key={k} value={Number(values[k])} onChange={(d) => set(k, d)} />, busyLine] : null;
      if (k === "endsAt" && useDuration) return null;
      if (k === "coachId") return <Coaches key={k} value={String(values[k])} onChange={v => set(k, v)} />;
      if (typeof values[k] === "boolean") return null;
      const field = <Field key={k} title={title[k] ?? k}>{k === "callStatus" ? <select {...auto} value={String(values[k])} onChange={e => set(k, e.target.value)}>{CALL_STATUSES.map(s => <option key={s} value={s}>{callStatusLabel(s)}</option>)}</select> : k === "result" ? <select {...auto} value={String(values[k])} onChange={e => set(k, e.target.value)}>{INTERVIEW_RESULTS.map(r => <option key={r} value={r}>{RESULT_LABELS[r]}</option>)}</select> : <input {...auto} type={k.endsWith("At") ? "datetime-local" : k.endsWith("Url") ? "url" : "text"} required={["round", "startsAt", "endsAt"].includes(k)} maxLength={k === "round" ? 40 : k === "systemName" ? 80 : 500} value={String(values[k])} onChange={e => set(k, e.target.value)} />}</Field>;
      return k === "endsAt" ? [field, busyLine] : field;
    })}
    {checks.length > 0 && (
      <div className="iv-checks">
        {checks.map((k) => (
          <label className="check" key={k}><input type="checkbox" checked={Boolean(values[k])} onChange={e => set(k, e.target.checked)} {...(k === first ? { "data-autofocus": true } : {})} /> {title[k]}</label>
        ))}
      </div>
    )}
    {can("panelIds") && (detail.isPending ? <p role="status">Loading panel…</p> : detail.isError ? <p role="alert">Could not load the panel.</p>
      : <PanelPicker panel={curPanel} lead={curLead} onPanel={(ids) => { setPanel(ids); if (!ids.includes(curLead)) setLead(""); }} onLead={(id) => setLead(id)} />)}
    <DialogActions onCancel={onClose} submitLabel="Save interview" busy={submit.busy} error={submit.error} />
  </form></Dialog>;
}

function ScorecardRows({ s }: { s: Scorecard }) {
  return <dl className="scorecard">{SCORECARD_CRITERIA.map((k) => <div key={k}><dt>{SCORECARD_LABELS[k]}</dt><dd><Stars value={s[k]} label={SCORECARD_LABELS[k]} /></dd></div>)}</dl>;
}

function Feedback({ item, onClose }: { item: Interview; onClose: () => void }) {
  const qc = useQueryClient(); const [kind, setKind] = useState(item.feedbackKinds[0] ?? ""); const [rating, setRating] = useState(""); const [notes, setNotes] = useState(""); const [saved, setSaved] = useState(false); const submit = useSubmit(errorText);
  const [scores, setScores] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ["interview-feedback", item.id], queryFn: () => api<{ items: FeedbackItem[] }>(`/api/v1/interviews/${item.id}/feedback`) });
  const scorable = (SCORECARD_KINDS as readonly string[]).includes(kind);
  const filled = SCORECARD_CRITERIA.filter((k) => scores[k]);
  const dirty = Boolean(rating || notes.trim() || filled.length);
  return <Dialog title={`Feedback · ${item.candidate.name}`} onClose={onClose} dirty={dirty}>
    {q.isPending && <p>Loading feedback…</p>}{q.isError && <p role="alert">Could not load feedback.</p>}
    {q.data?.items.map(f => <div className="note" key={f.id}><b>{kindLabel(f.kind)} · {f.author?.name ?? "Candidate"}</b><p>{f.rating ? `${f.rating}/5` : "No rating"}</p>{f.scorecard && <ScorecardRows s={f.scorecard} />}<p style={{ whiteSpace: "pre-wrap" }}>{f.notes}</p>{([["Format", f.format], ["Topics", f.topics?.join(", ")], ["Difficult questions", f.difficultQuestions], ["Duration (minutes)", f.durationMin], ["Next step", f.nextStep]] as const).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([name, value]) => <p key={name} style={{ whiteSpace: "pre-wrap" }}><b>{name}:</b> {value}</p>)}</div>)}
    {q.data?.items.length === 0 && <p>No feedback yet.</p>}
    {saved && <p role="status">Feedback added.</p>}
    {item.feedbackKinds.length > 0 && <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
      if (scorable && filled.length > 0 && filled.length < SCORECARD_CRITERIA.length) throw new Error("Rate all four scorecard criteria, or none.");
      const scorecard = scorable && filled.length === SCORECARD_CRITERIA.length ? Object.fromEntries(SCORECARD_CRITERIA.map((k) => [k, Number(scores[k])])) : undefined;
      await api(`/api/v1/interviews/${item.id}/feedback`, { method: "POST", body: JSON.stringify({ kind, ...(rating ? { rating: Number(rating) } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(scorecard ? { scorecard } : {}) }) });
      setNotes(""); setRating(""); setScores({}); setSaved(true); await qc.invalidateQueries({ queryKey: ["interview-feedback", item.id] });
    }); }}>
      <Field title="Feedback kind"><select value={kind} onChange={e => setKind(e.target.value)}>{item.feedbackKinds.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}</select></Field>
      <Field title="Rating"><select value={rating} onChange={e => setRating(e.target.value)}><option value="">No rating</option>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}/5</option>)}</select></Field>
      {scorable && <fieldset className="field scoreinputs"><legend>Scorecard (optional, 1 to 5)</legend><div className="grid2">
        {SCORECARD_CRITERIA.map((k) => <Field key={k} title={SCORECARD_LABELS[k]}><select value={scores[k] ?? ""} onChange={(e) => setScores((s) => ({ ...s, [k]: e.target.value }))}><option value="">Not rated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>)}
      </div></fieldset>}
      <Field title="Notes"><textarea rows={5} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <DialogActions onCancel={onClose} submitLabel="Add feedback" busy={submit.busy} disabled={!rating && !notes.trim() && filled.length === 0} error={submit.error} />
    </form>}
    {!item.feedbackKinds.length && <div className="actions"><button type="button" className="btn" onClick={onClose}>Close</button></div>}
  </Dialog>;
}

/** What the viewer can do with one interview (row and drawer share it). */
export interface InterviewActions {
  onEdit?: () => void;
  onFeedback?: () => void;
  /** Clear and place / Create placement (IS-11). */
  onPlace?: () => void;
}
const placeLabel = (i: Interview) => (i.result === "cleared" ? "Create placement" : "Clear and place");

/**
 * Interview details drawer. The action strip comes first: call status and result, the slot in the
 * board's zone, then the next action (create placement when the round can become one) with Edit and
 * Feedback beside it. Then links to the candidate, submission and placement, the info grid, the
 * calendar file, recordings and the reviewer cards with read-only star rows.
 */
export function InterviewDrawer({ item, displayZone, onClose, actions = {}, suspended = false, canOpenCandidate = false, canOpenPlacement = false, onOpenSubmission }: {
  item: Interview; displayZone: string; onClose: () => void;
  actions?: InterviewActions; suspended?: boolean;
  canOpenCandidate?: boolean; canOpenPlacement?: boolean;
  /** Opens the submission (the Submissions drawer); without it the submission is not linked. */
  onOpenSubmission?: (id: string) => void;
}) {
  const d = useQuery({ queryKey: ["interview", item.id], queryFn: () => api<InterviewDetail>(`/api/v1/interviews/${item.id}`) });
  const f = useQuery({ queryKey: ["interview-feedback", item.id], queryFn: () => api<{ items: FeedbackItem[] }>(`/api/v1/interviews/${item.id}/feedback`) });
  const i = d.data ? { ...item, ...d.data } : { ...item, panel: [], lead: null };
  const link = safeLink(i.meetingUrl);
  const reviewers = (f.data?.items ?? []).filter((x) => x.kind !== "candidate" && (x.scorecard || x.rating !== null));
  const hasActions = Boolean(actions.onPlace || actions.onEdit || actions.onFeedback);
  return (
    <Drawer title="Interview details" onClose={onClose} wide closeLabel="Close interview details" suspended={suspended}>
      <div className="actionstrip iv-strip">
        <div className="as-status">
          <CallStatus status={i.callStatus} /><ResultBadge result={i.result} />
          <span className="as-note">{fmtDay(i.startsAt, displayZone)} · {fmtSlot(i.startsAt, i.endsAt, displayZone)}</span>
        </div>
        {hasActions && (
          <div className="as-actions">
            {actions.onPlace && <button type="button" className="btn primary" onClick={actions.onPlace}>{placeLabel(i)}</button>}
            {actions.onEdit && <button type="button" className={actions.onPlace ? "btn" : "btn primary"} onClick={actions.onEdit}>Edit interview</button>}
            {actions.onFeedback && <button type="button" className="btn" onClick={actions.onFeedback}>Feedback</button>}
          </div>
        )}
      </div>
      <dl className="iv-links-dl">
        <div><dt>Candidate</dt><dd><RecordLink kind="candidate" id={i.candidate.id} allowed={canOpenCandidate}><b>{i.candidate.name ?? "Candidate"}</b></RecordLink></dd></div>
        <div><dt>Submission</dt><dd>
          <RecordLink kind="submission" id={i.submissionId} onOpen={onOpenSubmission} label={`Open the submission of ${i.candidate.name ?? "the candidate"}`}>
            {[i.position, i.client?.name].filter(Boolean).join(" at ") || "Submission"}
          </RecordLink>{i.submissionStatus && <span className="muted"> · {pipelineLabel(i.submissionStatus)}</span>}
        </dd></div>
        {i.placement && <div><dt>Placement</dt><dd><RecordLink kind="placement" id={i.placement.id} allowed={canOpenPlacement}>{pipelineLabel(i.placement.status)}</RecordLink></dd></div>}
      </dl>
      {d.isError && <p role="alert">Could not load the interview details.</p>}
      <section className="card pad" aria-labelledby={`${item.id}-info`}>
        <h2 id={`${item.id}-info`}>Interview info</h2>
        <dl className="infogrid">
          <div><dt>Candidate name</dt><dd>{i.candidate.name ?? "—"}</dd></div>
          <div><dt>Position</dt><dd>{i.position ?? "—"}</dd></div>
          <div><dt>Round name</dt><dd>{i.round}</dd></div>
          <div><dt>Interview type</dt><dd>{i.interviewType ? INTERVIEW_TYPE_LABELS[i.interviewType] : "—"}</dd></div>
          {link && <div><dt>Meeting link</dt><dd><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></dd></div>}
          <div><dt>Interview slot</dt><dd><time dateTime={i.startsAt}>{fmtDay(i.startsAt, displayZone)}, {fmtSlot(i.startsAt, i.endsAt, displayZone)}</time></dd></div>
          <div><dt>Panel list</dt><dd>{d.isPending ? "Loading…" : i.panel.length ? i.panel.map((p) => p.name).join(", ") : "—"}</dd></div>
          <div><dt>Lead user</dt><dd>{i.lead?.name ?? "—"}</dd></div>
          <div><dt>Interview duration (in mins)</dt><dd>{i.durationMin ?? "—"}</dd></div>
          <div><dt>Client</dt><dd>{i.client?.name ?? "—"}</dd></div>
          <div><dt>Coach</dt><dd>{i.coach?.name ?? "—"}</dd></div>
          <div><dt>Recruiter</dt><dd>{i.recruiter.name ?? "—"}</dd></div>
          <div><dt>Readiness</dt><dd><Readiness i={i} /></dd></div>
          <div><dt>Recordings</dt><dd><Recordings i={i} /></dd></div>
          {i.systemName && <div><dt>System name</dt><dd>{i.systemName}</dd></div>}
        </dl>
        {i.callStatus === "scheduled" && <a className="btn sm calbtn" href={`/api/v1/interviews/${encodeURIComponent(i.id)}/calendar.ics`} download><CalendarPlus size={15} aria-hidden="true" /> Add to calendar (.ics)</a>}
      </section>
      <SupportCalendarBlock interviewId={item.id} scheduled={i.callStatus === "scheduled"} startsAt={i.startsAt} endsAt={i.endsAt} />
      <section aria-labelledby={`${item.id}-rev`} className="reviewers">
        <h2 id={`${item.id}-rev`} className="sectiontitle">Reviewers</h2>
        {f.isPending && <p>Loading feedback…</p>}{f.isError && <p role="alert">Could not load feedback.</p>}
        {!f.isPending && !f.isError && reviewers.length === 0 && <p className="muted">No scored feedback yet.</p>}
        {reviewers.map((r) => (
          <article key={r.id} className="card pad reviewer" aria-label={`Reviewer: ${r.author?.name ?? "Unknown"}`}>
            <h3>Reviewer: {r.author?.name ?? "Unknown"}</h3>
            <dl className="infogrid">
              <div><dt>Round</dt><dd>{r.round ?? i.round}</dd></div>
              <div><dt>Reviewer role</dt><dd>{kindLabel(r.kind)}</dd></div>
              {r.rating !== null && <div><dt>Overall rating</dt><dd><Stars value={r.rating} label="Overall rating" /></dd></div>}
            </dl>
            {r.scorecard && <ScorecardRows s={r.scorecard} />}
            {r.notes && <p className="reviewnotes">{r.notes}</p>}
          </article>
        ))}
      </section>
    </Drawer>
  );
}

const PARAMS = ["from", "to", "status", "cleared", "result", "locationId", "clientId", "batchId"] as const;
type Param = (typeof PARAMS)[number];
/** `?from=any`: every date (the board otherwise opens on today onward). */
const ANY = "any";

export function InterviewsPage({ me, initialOpenId = null, onOpenChange, onOpenSubmission }: {
  me: Me; initialOpenId?: string | null;
  /** The interview whose details are open changed (the shell keeps it in the URL). */
  onOpenChange?: (id: string | null) => void;
  /** Opens a submission in the Submissions drawer (links from the interview drawer). */
  onOpenSubmission?: (id: string) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [zone, setZone] = useInterviewZone();
  const today = todayIn(zone);
  // Every filter lives in the address bar, so a refresh or Back from a candidate keeps the board view.
  const [url, setUrl] = useSearchParams(PARAMS);
  const [candidateInput, setCandidateInput, candidate] = useDebouncedParam("candidate");
  const from = url.from === ANY ? "" : ISO_DAY.test(url.from) ? url.from : today;
  const to = ISO_DAY.test(url.to) ? url.to : "";
  const { status, cleared, result, locationId, clientId, batchId } = url;
  const patch = (p: Partial<Record<Param, string>>) => setUrl(p);
  const setFrom = (v: string) => patch({ from: v === today ? "" : v || ANY });
  // Interview location (B2.3): narrows the board within the caller's scope; the server applies the scope.
  const lookups = useLookups().data;
  const locations = lookups?.locations ?? [];
  const batches = useBatchOptions(me);
  // The board opens on today onward; finding a candidate or batch looks at every date, unless the user picked some.
  const searchAllDates = () => { if (from === today && !to) patch({ from: ANY }); };
  const [schedule, setSchedule] = useState(false);
  const [edit, setEdit] = useState<Interview | null>(null);
  const [feedback, setFeedback] = useState<Interview | null>(null);
  const [placing, setPlacing] = useState<Interview | null>(null);
  const [clientName, setClientName] = useState<Record<string, string>>({});
  // IS-11: any held round can become a placement; the server re-checks scope, the other rounds and the submission.
  const canPlace = (i: Interview) => can(me, "placement:create") && !i.placement && i.editableFields.includes("result")
    && i.result !== "rejected" && i.callStatus !== "cancelled" && i.callStatus !== "no_invite"
    && !["rejected", "withdrawn"].includes(i.submissionStatus ?? "");
  // Only the open interview's id is kept here; its record is read from the query data (see `details` below).
  const [detailsId, setDetailsId] = useState<string | null>(initialOpenId);
  const [notice, setNotice] = useState("");
  const invalidRange = Boolean(from && to && from > to);
  const q = useInfiniteQuery({ queryKey: ["interviews", from, to, zone, status, cleared, result, locationId, clientId, candidate, batchId], initialPageParam: "", enabled: !invalidRange, queryFn: ({ pageParam }) => {
    const p = new URLSearchParams({ limit: "50" });
    if (from) p.set("from", zoneDayBoundary(from, zone)); if (to) p.set("to", zoneDayBoundary(to, zone, true));
    if (status) p.set("status", status); if (cleared) p.set("cleared", cleared); if (result) p.set("result", result); if (locationId) p.set("locationId", locationId);
    if (clientId) p.set("clientId", clientId); if (candidate) p.set("candidate", candidate); if (batchId) p.set("batchId", batchId); if (pageParam) p.set("cursor", pageParam);
    return api<Page<Interview>>(`/api/v1/interviews?${p}`);
  }, getNextPageParam: p => p.nextCursor || undefined });
  const done = () => {
    setEdit(null);
    setNotice("Interview saved.");
    void qc.invalidateQueries({ queryKey: ["interviews"] });
    void qc.invalidateQueries({ queryKey: ["interview"] });
  };
  // interview-alerts: opened from an inbox entry: load that interview and show its details.
  // Also the URL's interview (/interviews/<id>), so back/forward open and close the details.
  const initial = useQuery({
    queryKey: ["interview", initialOpenId],
    queryFn: () => api<InterviewDetail>(`/api/v1/interviews/${encodeURIComponent(initialOpenId!)}`),
    enabled: initialOpenId !== null,
  });
  useEffect(() => { setDetailsId(initialOpenId); }, [initialOpenId]);
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  // Read from the list or the URL's detail load, so a save (which refreshes both) shows the new values.
  const details = items.find(i => i.id === detailsId) ?? (initial.data?.id === detailsId ? initial.data : undefined);
  const showDetails = (next: string | null) => { setDetailsId(next); onOpenChange?.(next); };
  const actionsFor = (i: Interview): InterviewActions => ({
    onEdit: i.editableFields.length > 0 ? () => setEdit(i) : undefined,
    onFeedback: () => setFeedback(i),
    onPlace: canPlace(i) ? () => setPlacing(i) : undefined,
  });
  const showClient = (c: Named) => { setClientName((m) => ({ ...m, [c.id]: c.name ?? "Client" })); patch({ clientId: c.id, from: ANY, to: "", status: "", cleared: "", result: "", locationId: "" }); };
  const clientLabel = clientId ? clientName[clientId] ?? lookups?.clients.find((c) => c.id === clientId)?.name ?? "Selected client" : "";
  const reset = () => { setUrl({ from: "", to: "", status: "", cleared: "", result: "", locationId: "", clientId: "", batchId: "" }); setCandidateInput(""); };

  const chips: FilterChip[] = [];
  if (clientId) chips.push({ key: "client", label: `Client history: ${clientLabel}`, onRemove: () => patch({ clientId: "" }) });
  if (cleared) chips.push({ key: "cleared", label: cleared === "true" ? "Cleared" : "Not cleared", onRemove: () => patch({ cleared: "" }) });
  if (locationId) chips.push({ key: "loc", label: `Location: ${locations.find((l) => l.id === locationId)?.name ?? "Selected"}`, onRemove: () => patch({ locationId: "" }) });
  if (batchId) chips.push({ key: "batch", label: `Batch: ${batches.find((b) => b.id === batchId)?.name ?? "Selected"}`, onRemove: () => patch({ batchId: "" }) });
  const moreCount = [cleared, locationId, batchId].filter(Boolean).length;
  const hasFilters = Boolean(url.from || to || status || cleared || result || locationId || clientId || candidate || batchId);
  const activeCount = [url.from, to, status, result, candidate].filter(Boolean).length + chips.length;

  // Group by calendar day in the board's zone (the list comes in start order).
  const groups: { day: string; rows: Interview[] }[] = [];
  for (const i of items) {
    const day = dayIn(i.startsAt, zone);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.rows.push(i); else groups.push({ day, rows: [i] });
  }
  const COLS = 9;
  const abbr = zoneAbbr(zone);
  const dayHead = (g: { day: string; rows: Interview[] }) => {
    const label = fmtDay(g.rows[0]!.startsAt, zone);
    return `${g.day === today ? "Today · " : ""}${label}`;
  };

  const zoneField = (
    <div className="field inline iv-zone">
      <label htmlFor={`${id}-zone`}>Time zone</label>
      <select id={`${id}-zone`} value={zone} onChange={(e) => setZone(e.target.value)}>
        {zoneOptions(zone).map(([z, l]) => <option key={z} value={z}>{l}</option>)}
      </select>
    </div>
  );

  return <section className="panel ivpage">
    <div className="pagehead">
      <div>
        <h1 tabIndex={-1}>Interviews{!q.isPending && !q.isError && !invalidRange && <span className="h1count" aria-hidden="true">{items.length}{q.hasNextPage ? "+" : ""}</span>}</h1>
        <p className="sub">Schedule, clear and review interviews. Times, date filters and scheduling use one time zone{zone === LOCAL_ZONE ? " (your own)" : ""}: {zone}.</p>
      </div>
      <div className="rowactions push iv-headacts">
        {zoneField}
        {can(me, "interview:create") && <button type="button" className="btn primary" onClick={() => setSchedule(true)}>Schedule interview</button>}
      </div>
    </div>

    <FilterBar label="Interview filters" hasFilters={hasFilters} onClear={reset} chips={chips} moreCount={moreCount} activeCount={activeCount}
      search={
        <div className="field inline fb-search">
          <label htmlFor={`${id}-cand`}>Candidate</label>
          <input id={`${id}-cand`} type="search" placeholder="Search by name" value={candidateInput} onChange={e => { setCandidateInput(e.target.value); searchAllDates(); }} />
        </div>
      }
      primary={<>
        <div className="field inline pl-date">
          <label htmlFor={`${id}-from`}>From date</label>
          <input id={`${id}-from`} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="field inline pl-date">
          <label htmlFor={`${id}-to`}>Through date</label>
          <input id={`${id}-to`} type="date" value={to} onChange={e => patch({ to: e.target.value })}
            aria-invalid={invalidRange || undefined} aria-describedby={invalidRange ? `${id}-range` : undefined} />
        </div>
        <div className="field inline">
          <label htmlFor={`${id}-status`}>Call status</label>
          <select id={`${id}-status`} value={status} onChange={e => patch({ status: e.target.value })}><option value="">All statuses</option>{CALL_STATUSES.map(s => <option key={s} value={s}>{callStatusLabel(s)}</option>)}</select>
        </div>
        <div className="field inline">
          <label htmlFor={`${id}-result`}>Result</label>
          <select id={`${id}-result`} value={result} onChange={e => patch({ result: e.target.value })}><option value="">All</option>{INTERVIEW_RESULTS.map(r => <option key={r} value={r}>{RESULT_LABELS[r]}</option>)}</select>
        </div>
        <button type="button" className="btn iv-today" onClick={() => patch({ from: "", to: today })}>Today</button>
      </>}
      more={<>
        <div className="field inline">
          <label htmlFor={`${id}-cleared`}>Readiness</label>
          <select id={`${id}-cleared`} value={cleared} onChange={e => patch({ cleared: e.target.value })}><option value="">All</option><option value="true">Cleared</option><option value="false">Not cleared</option></select>
        </div>
        {locations.length > 1 && (
          <div className="field inline">
            <label htmlFor={`${id}-loc`}>Location filter</label>
            <select id={`${id}-loc`} value={locationId} onChange={e => patch({ locationId: e.target.value })}><option value="">All locations</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </div>
        )}
        {batches.length > 0 && (
          <div className="field inline">
            <label htmlFor={`${id}-batch`}>Batch</label>
            <select id={`${id}-batch`} value={batchId} onChange={e => { patch({ batchId: e.target.value }); searchAllDates(); }}><option value="">All batches</option>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </div>
        )}
      </>}
    />

    {can(me, "calendar:block") && <SupportCalendarCard />}
    {initialOpenId && initial.isError && <p role="alert">That interview is no longer available to you.</p>}
    {notice && <p role="status" className="livemsg">{notice}</p>}
    {invalidRange && <p id={`${id}-range`} className="error" role="alert">Through date must be on or after From date.</p>}
    {!invalidRange && q.isPending && <p>Loading interviews…</p>}
    {q.isError && <p role="alert">Could not load interviews. <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>}
    {!invalidRange && !q.isPending && !q.isError && (
      <div className="card tablewrap listcard">
        <table className="dtable iv-board" aria-label="Interviews">
          <thead><tr>
            <th>Time ({abbr})</th><th>Candidate / client</th><th>Round</th><th>Call status</th><th>Readiness</th><th>Result</th>
            <th className="p3">Candidate feedback</th><th className="p3">Recordings</th>
            <th className="c-act"><span className="sr-only">Actions</span></th>
          </tr></thead>
          {groups.map((g) => (
            <tbody key={g.day}>
              <tr className="iv-day"><th colSpan={COLS} scope="colgroup">{dayHead(g)}<span className="iv-daycount">{g.rows.length}</span></th></tr>
              {g.rows.map((i) => {
                const name = i.candidate.name ?? "Candidate";
                const acts = actionsFor(i);
                return (
                  <tr key={i.id} className={`rowopen${i.cleared ? " row-cleared" : ""}`}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button, input, select, label, [role='menu']")) showDetails(i.id); }}>
                    <td data-label="Time" className="iv-time"><time dateTime={i.startsAt}>{fmtRange(i.startsAt, i.endsAt, zone)}</time></td>
                    <td className="c-primary">
                      <RecordLink kind="candidate" id={i.candidate.id} allowed={can(me, "candidate:read")}><b>{name}</b></RecordLink>
                      <span className="block iv-sub">
                        {i.client ? <button type="button" className="linkbtn iv-client" aria-label={`View history for ${i.client.name}`} onClick={() => showClient(i.client!)}>{i.client.name}</button> : "No client"}
                        <span className="muted"> · {i.recruiter.name ?? "—"}</span>
                      </span>
                    </td>
                    <td data-label="Round"><span>{i.round}{(i.interviewType || i.coach) && <small className="block muted pl-nowrap">{[i.interviewType && INTERVIEW_TYPE_LABELS[i.interviewType], i.coach?.name].filter(Boolean).join(" · ")}</small>}</span></td>
                    <td className="c-badge" data-label="Call status"><CallStatus status={i.callStatus} /></td>
                    <td data-label="Readiness"><span><Readiness i={i} /></span></td>
                    <td data-label="Result"><span><ResultBadge result={i.result} />
                      {i.candidateFeedback?.rating != null && <span className="iv-fbinline" title={i.candidateFeedback.notes ?? undefined}><Stars value={i.candidateFeedback.rating} label="Candidate feedback" /></span>}
                      {i.placement && <small className="block pl-nowrap"><RecordLink kind="placement" id={i.placement.id} allowed={can(me, "placement:read")}>Placement: {pipelineLabel(i.placement.status)}</RecordLink></small>}
                    </span></td>
                    <td className="p3 iv-fb" data-label="Feedback"><span><CandidateFeedbackCell f={i.candidateFeedback} /></span></td>
                    <td className="p3" data-label="Recordings"><Recordings i={i} /></td>
                    <td className="c-act">
                      <div className="pl-act">
                        {acts.onPlace
                          ? <button type="button" className="btn sm" aria-label={`${placeLabel(i)} from ${i.round} for ${name}`} onClick={acts.onPlace}>{placeLabel(i)}</button>
                          : <button type="button" className="btn sm" aria-label={`Details of the interview with ${name}`} onClick={() => showDetails(i.id)}>Details</button>}
                        <Menu label={`More actions for ${name}`} items={[
                          acts.onPlace && { label: "Details", onSelect: () => showDetails(i.id) },
                          acts.onEdit && { label: "Edit interview", onSelect: acts.onEdit },
                          acts.onFeedback && { label: "Feedback", onSelect: acts.onFeedback },
                        ]} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
          {items.length === 0 && <tbody><tr><td colSpan={COLS} className="empty">No interviews match these filters.</td></tr></tbody>}
        </table>
      </div>
    )}
    {q.hasNextPage && <div className="listfoot"><button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more interviews</button></div>}
    {schedule && <ScheduleInterviewDialog pickSubmission withPanel defaultType="video" onClose={() => setSchedule(false)}
      onScheduled={() => { setSchedule(false); setNotice("Interview scheduled."); refreshAfterSchedule(qc); void qc.invalidateQueries({ queryKey: ["interview"] }); }} />}
    {edit && <Edit item={edit} zone={zone} onClose={() => setEdit(null)} onDone={done} />}
    {feedback && <Feedback item={feedback} onClose={() => setFeedback(null)} />}
    {placing && <CreatePlacementDialog
      submission={{ id: placing.submissionId, candidateName: placing.candidate.name, jobTitle: placing.position || "The position", client: placing.client?.name ?? "the client" }}
      clearRound={{ id: placing.id, round: placing.round, pending: placing.result !== "cleared", rowVersion: placing.rowVersion }}
      onClose={() => setPlacing(null)}
      onSelectedOnly={() => { setPlacing(null); setNotice(`${placing.round} cleared and the submission moved to Selected.`); void qc.invalidateQueries({ queryKey: ["interviews"] }); void qc.invalidateQueries({ queryKey: ["submissions"] }); }}
      onCreated={() => { setPlacing(null); setNotice(`Placement created for ${placing.candidate.name ?? "the candidate"} from ${placing.round}.`); void qc.invalidateQueries({ queryKey: ["interviews"] }); void qc.invalidateQueries({ queryKey: ["submissions"] }); void qc.invalidateQueries({ queryKey: ["placements"] }); }} />}
    {details && <InterviewDrawer item={details} displayZone={zone} onClose={() => showDetails(null)} actions={actionsFor(details)}
      suspended={Boolean(edit || feedback || placing)} canOpenCandidate={can(me, "candidate:read")} canOpenPlacement={can(me, "placement:read")}
      onOpenSubmission={onOpenSubmission} />}
  </section>;
}
