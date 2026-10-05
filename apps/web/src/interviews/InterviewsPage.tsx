import { useId, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import {
  INTERVIEW_DURATIONS, INTERVIEW_ROUNDS, INTERVIEW_TYPES, INTERVIEW_TYPE_LABELS, PANEL_MAX, SCORECARD_CRITERIA, SCORECARD_KINDS,
  SCORECARD_LABELS, type InterviewType, type Scorecard,
} from "@eureka/shared";
import { api, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { useLookups } from "../lookups";
import { Drawer } from "../sales/ui";
import { Avatar } from "../shell/ui";

const STATUSES = ["scheduled", "in_progress", "completed", "rescheduled", "cancelled", "no_invite"];
const label = (s: string) => s.replaceAll("_", " ");
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
interface Submission { id: string; candidateName: string; jobTitle: string; client: string; status: string; canUpdate?: boolean }
export function localInput(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function dateBoundary(day: string, next = false) {
  const d = new Date(`${day}T00:00:00`);
  if (next) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
const KIND_LABELS: Record<string, string> = { coach: "Interview coach", location: "Location", client: "Client (relayed)", candidate: "Candidate" };
const safeLink = (u: string | null | undefined) => (u && /^https:\/\/\S+$/.test(u) ? u : null);

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return <label className="field"><span>{title}</span>{children}</label>;
}

/** Read-only star row: one accessible name ("4 out of 5"), the stars are decoration. */
export function Stars({ value, label: name }: { value: number; label?: string }) {
  const text = `${value} out of 5`;
  return (
    <span className="stars" role="img" aria-label={name ? `${name}: ${text}` : text}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} aria-hidden="true" className={n <= value ? "star on" : "star"}>★</span>)}
    </span>
  );
}

function Coaches({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery({ queryKey: ["interview-coaches"], queryFn: () => api<{ items: Named[] }>("/api/v1/interviews/coaches") });
  return <Field title="Coach"><select value={value} onChange={e => onChange(e.target.value)}><option value="">Unassigned</option>
    {value && !q.data?.items.some(c => c.id === value) && <option value={value}>Current coach</option>}
    {q.data?.items.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>{q.isError && <span role="alert">Coach list unavailable. Try reopening this form.</span>}</Field>;
}

function TypeRadios({ value, onChange }: { value: string; onChange: (v: InterviewType) => void }) {
  const name = useId();
  return (
    <fieldset className="field radiorow">
      <legend>Interview type</legend>
      {INTERVIEW_TYPES.map((t) => (
        <label key={t} className="check"><input type="radio" name={name} value={t} checked={value === t} onChange={() => onChange(t)} /> {INTERVIEW_TYPE_LABELS[t]}</label>
      ))}
    </fieldset>
  );
}

function RoundInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useId();
  return <Field title="Round"><input required maxLength={40} list={list} value={value} onChange={e => onChange(e.target.value)} placeholder="Choose or type a round" />
    <datalist id={list}>{INTERVIEW_ROUNDS.map((r) => <option key={r} value={r} />)}</datalist></Field>;
}

function DurationSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const options: number[] = INTERVIEW_DURATIONS.includes(value as never) ? [...INTERVIEW_DURATIONS] : [...INTERVIEW_DURATIONS, value].sort((a, b) => a - b);
  return <Field title="Duration (minutes)"><select value={value} onChange={e => onChange(Number(e.target.value))}>
    {options.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>;
}

/** Panel and lead pickers (active staff, names only). The lead must be on the panel. */
function PanelPicker({ panel, lead, onPanel, onLead }: { panel: string[]; lead: string; onPanel: (ids: string[]) => void; onLead: (id: string) => void }) {
  const [find, setFind] = useState("");
  const q = useQuery({ queryKey: ["interview-panel-options"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/api/v1/interviews/panel-options") });
  const people = q.data?.items ?? [];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Panel member";
  const matches = people.filter((p) => !panel.includes(p.id) && (p.name ?? "").toLowerCase().includes(find.trim().toLowerCase())).slice(0, 8);
  const remove = (id: string) => { onPanel(panel.filter((x) => x !== id)); if (lead === id) onLead(""); };
  return (
    <>
      <fieldset className="field panelpicker">
        <legend>Panel list</legend>
        <ul className="chips" aria-label="Selected panel members">
          {panel.map((id) => <li key={id} className="chip">{nameOf(id)}<button type="button" className="chipx" aria-label={`Remove ${nameOf(id)} from the panel`} onClick={() => remove(id)}>×</button></li>)}
          {panel.length === 0 && <li className="muted">No panel members yet</li>}
        </ul>
        {panel.length < PANEL_MAX ? <>
          <label className="field"><span>Find panel member</span><input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Type a name" /></label>
          {find.trim() && <ul className="pickresults" aria-label="Matching staff">{matches.map((p) => (
            <li key={p.id}><button type="button" className="btn sm" onClick={() => { onPanel([...panel, p.id]); setFind(""); }}>Add {p.name}</button></li>
          ))}{matches.length === 0 && <li className="muted">No matching staff.</li>}</ul>}
        </> : <p className="hint">A panel has at most {PANEL_MAX} members.</p>}
        {q.isError && <p role="alert">Staff list unavailable. Try reopening this form.</p>}
      </fieldset>
      <Field title="Lead user"><select value={lead} onChange={(e) => onLead(e.target.value)} disabled={panel.length === 0}>
        <option value="">No lead</option>{panel.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}</select></Field>
    </>
  );
}

function Schedule({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const blank = { submissionId: "", type: "video" as InterviewType, round: "", start: "", duration: 60, coach: "", invite: false, link: "", panel: [] as string[], lead: "" };
  const [v, setV] = useState(blank);
  const set = <K extends keyof typeof blank>(k: K, val: (typeof blank)[K]) => setV((s) => ({ ...s, [k]: val }));
  const [search, setSearch] = useState("");
  const submit = useSubmit(errorText);
  const subs = useInfiniteQuery({ queryKey: ["interview-submissions"], initialPageParam: "", queryFn: ({ pageParam }) => api<Page<Submission>>(`/api/v1/submissions?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`), getNextPageParam: p => p.nextCursor || undefined });
  const all = subs.data?.pages.flatMap(p => p.items) ?? [];
  const options = all.filter(s => !["selected", "rejected", "withdrawn"].includes(s.status) && s.canUpdate !== false && `${s.candidateName} ${s.client} ${s.jobTitle}`.toLowerCase().includes(search.toLowerCase()));
  const chosen = all.find((s) => s.id === v.submissionId);
  return <Dialog title="Create interview" onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    if (v.link && !/^https:\/\/\S+$/.test(v.link)) throw new Error("The meeting link must start with https:// and contain no spaces.");
    await api("/api/v1/interviews", { method: "POST", body: JSON.stringify({
      submissionId: v.submissionId, round: v.round, startsAt: new Date(v.start).toISOString(), durationMin: v.duration,
      ...(v.coach ? { coachId: v.coach } : {}), inviteReceived: v.invite, interviewType: v.type,
      ...(v.link ? { meetingUrl: v.link } : {}), ...(v.panel.length ? { panelIds: v.panel } : {}), ...(v.lead ? { leadId: v.lead } : {}),
    }) }); onDone();
  }); }}>
    <TypeRadios value={v.type} onChange={(t) => set("type", t)} />
    <Field title="Find a submission"><input value={search} onChange={e => { setSearch(e.target.value); set("submissionId", ""); }} placeholder="Candidate, client or job title" /></Field>
    <Field title="Submission"><select required value={v.submissionId} onChange={e => set("submissionId", e.target.value)}><option value="">Select an open submission</option>{options.map(s => <option key={s.id} value={s.id}>{s.candidateName} · {s.client} · {s.jobTitle}</option>)}</select></Field>
    {subs.isPending && <p role="status">Loading submissions…</p>}{subs.isError && <p role="alert">Could not load submissions.</p>}
    {!subs.isPending && !options.length && <p>No matching open submissions. Log a submission from the candidate profile first, or load more below.</p>}
    {subs.hasNextPage && <button type="button" className="btn" disabled={subs.isFetchingNextPage} onClick={() => void subs.fetchNextPage()}>Load more submissions</button>}
    <div className="grid2">
      <Field title="Position"><input readOnly value={chosen?.jobTitle ?? ""} placeholder="From the submission" /></Field>
      <Field title="Candidate name"><input readOnly value={chosen?.candidateName ?? ""} placeholder="From the submission" /></Field>
    </div>
    <RoundInput value={v.round} onChange={(r) => set("round", r)} />
    <PanelPicker panel={v.panel} lead={v.lead} onPanel={(ids) => set("panel", ids)} onLead={(id) => set("lead", id)} />
    <p className="hint">Enter the slot in {zone}.</p>
    <div className="grid2">
      <Field title="Interview slot"><input required type="datetime-local" value={v.start} onChange={e => set("start", e.target.value)} /></Field>
      <DurationSelect value={v.duration} onChange={(d) => set("duration", d)} />
    </div>
    <Field title="Meeting link"><input type="url" maxLength={500} value={v.link} onChange={e => set("link", e.target.value)} placeholder="Paste the https meeting link" /></Field>
    <Coaches value={v.coach} onChange={(c) => set("coach", c)} />
    <label className="check"><input type="checkbox" checked={v.invite} onChange={e => set("invite", e.target.checked)} /> Invite received</label>
    <div className="actions left"><button type="button" className="btn" onClick={() => { setV(blank); setSearch(""); }}>Reset</button></div>
    <DialogActions onCancel={onClose} submitLabel="Create interview" busy={submit.busy} error={submit.error} disabled={!v.submissionId} />
  </form></Dialog>;
}

function Edit({ item, onClose, onDone }: { item: Interview; onClose: () => void; onDone: () => void }) {
  const detail = useQuery({ queryKey: ["interview", item.id], queryFn: () => api<InterviewDetail>(`/api/v1/interviews/${item.id}`), enabled: item.editableFields.includes("panelIds") });
  const initial: Record<string, string | boolean | number> = {
    round: item.round, startsAt: localInput(item.startsAt), endsAt: localInput(item.endsAt), coachId: item.coach?.id ?? "", inviteReceived: item.inviteReceived,
    callStatus: item.callStatus, cleared: item.cleared, consentCaptured: item.consentCaptured, systemName: item.systemName ?? "",
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
  const title: Record<string, string> = { round: "Round", startsAt: "Interview slot", endsAt: "End", inviteReceived: "Invite received", callStatus: "Call status", cleared: "Cleared", consentCaptured: "Consent captured", systemName: "System name", otterUrl: "Otter URL", recordingUrl: "Recording URL", meetingUrl: "Meeting link" };
  const order = ["interviewType", "round", "startsAt", "durationMin", "endsAt", "meetingUrl", "coachId", "inviteReceived", "callStatus", "cleared", "consentCaptured", "systemName", "otterUrl", "recordingUrl"];
  return <Dialog title={`Edit interview · ${item.candidate.name}`} onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    const body: Record<string, unknown> = {};
    for (const k of order) {
      if (!can(k) || values[k] === initial[k]) continue;
      if (k === "endsAt" && useDuration) continue;
      if (k === "durationMin" && !useDuration) continue;
      body[k] = ["startsAt", "endsAt"].includes(k) ? new Date(String(values[k])).toISOString() : values[k] === "" ? null : values[k];
    }
    // A moved slot keeps its duration: send it so the server recomputes the end.
    if (useDuration && body.startsAt !== undefined && body.durationMin === undefined) body.durationMin = values.durationMin;
    if (body.meetingUrl && !/^https:\/\/\S+$/.test(String(body.meetingUrl))) throw new Error("The meeting link must start with https:// and contain no spaces.");
    if (panel !== null || lead !== null) { body.panelIds = curPanel; body.leadId = curLead || null; }
    if (Object.keys(body).length) await api(`/api/v1/interviews/${item.id}`, { method: "PATCH", body: JSON.stringify(body) }); onDone();
  }); }}>
    <p className="hint">Times shown in {zone}. Recording links require captured consent.</p>
    {(item.position || item.candidate.name) && <div className="grid2">
      <Field title="Position"><input readOnly value={item.position ?? ""} /></Field>
      <Field title="Candidate name"><input readOnly value={item.candidate.name ?? ""} /></Field>
    </div>}
    {order.filter(can).map(k => {
      if (k === "interviewType") return <TypeRadios key={k} value={String(values[k])} onChange={(t) => set(k, t)} />;
      if (k === "round") return <RoundInput key={k} value={String(values[k])} onChange={(r) => set(k, r)} />;
      if (k === "durationMin") return useDuration ? <DurationSelect key={k} value={Number(values[k])} onChange={(d) => set(k, d)} /> : null;
      if (k === "endsAt" && useDuration) return null;
      if (k === "coachId") return <Coaches key={k} value={String(values[k])} onChange={v => set(k, v)} />;
      if (typeof values[k] === "boolean") return <div className="field" key={k}><label><input type="checkbox" checked={Boolean(values[k])} onChange={e => set(k, e.target.checked)} /> {title[k]}</label></div>;
      return <Field key={k} title={title[k] ?? k}>{k === "callStatus" ? <select value={String(values[k])} onChange={e => set(k, e.target.value)}>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select> : <input type={k.endsWith("At") ? "datetime-local" : k.endsWith("Url") ? "url" : "text"} required={["round", "startsAt", "endsAt"].includes(k)} maxLength={k === "round" ? 40 : k === "systemName" ? 80 : 500} value={String(values[k])} onChange={e => set(k, e.target.value)} />}</Field>;
    })}
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
  return <Dialog title={`Feedback · ${item.candidate.name}`} onClose={onClose}>
    {q.isPending && <p>Loading feedback…</p>}{q.isError && <p role="alert">Could not load feedback.</p>}
    {q.data?.items.map(f => <div className="note" key={f.id}><b>{label(f.kind)} · {f.author?.name ?? "Candidate"}</b><p>{f.rating ? `${f.rating}/5` : "No rating"}</p>{f.scorecard && <ScorecardRows s={f.scorecard} />}<p style={{ whiteSpace: "pre-wrap" }}>{f.notes}</p>{([["Format", f.format], ["Topics", f.topics?.join(", ")], ["Difficult questions", f.difficultQuestions], ["Duration (minutes)", f.durationMin], ["Next step", f.nextStep]] as const).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([name, value]) => <p key={name} style={{ whiteSpace: "pre-wrap" }}><b>{name}:</b> {value}</p>)}</div>)}
    {q.data?.items.length === 0 && <p>No feedback yet.</p>}
    {saved && <p role="status">Feedback added.</p>}
    {item.feedbackKinds.length > 0 && <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
      if (scorable && filled.length > 0 && filled.length < SCORECARD_CRITERIA.length) throw new Error("Rate all four scorecard criteria, or none.");
      const scorecard = scorable && filled.length === SCORECARD_CRITERIA.length ? Object.fromEntries(SCORECARD_CRITERIA.map((k) => [k, Number(scores[k])])) : undefined;
      await api(`/api/v1/interviews/${item.id}/feedback`, { method: "POST", body: JSON.stringify({ kind, ...(rating ? { rating: Number(rating) } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(scorecard ? { scorecard } : {}) }) });
      setNotes(""); setRating(""); setScores({}); setSaved(true); await qc.invalidateQueries({ queryKey: ["interview-feedback", item.id] });
    }); }}>
      <Field title="Feedback kind"><select value={kind} onChange={e => setKind(e.target.value)}>{item.feedbackKinds.map(k => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
      <Field title="Rating"><select value={rating} onChange={e => setRating(e.target.value)}><option value="">No rating</option>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}/5</option>)}</select></Field>
      {scorable && <fieldset className="field scoreinputs"><legend>Scorecard (optional, 1 to 5)</legend><div className="grid2">
        {SCORECARD_CRITERIA.map((k) => <Field key={k} title={SCORECARD_LABELS[k]}><select value={scores[k] ?? ""} onChange={(e) => setScores((s) => ({ ...s, [k]: e.target.value }))}><option value="">Not rated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>)}
      </div></fieldset>}
      <Field title="Notes"><textarea rows={5} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <DialogActions onCancel={onClose} submitLabel="Add feedback" busy={submit.busy} disabled={!rating && !notes.trim() && filled.length === 0} error={submit.error} />
    </form>}
    {!item.feedbackKinds.length && <button className="btn" onClick={onClose}>Close</button>}
  </Dialog>;
}

/** Interview details drawer: info grid, calendar file, reviewer cards with read-only star rows. */
export function InterviewDrawer({ item, displayZone, onClose }: { item: Interview; displayZone: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ["interview", item.id], queryFn: () => api<InterviewDetail>(`/api/v1/interviews/${item.id}`) });
  const f = useQuery({ queryKey: ["interview-feedback", item.id], queryFn: () => api<{ items: FeedbackItem[] }>(`/api/v1/interviews/${item.id}/feedback`) });
  const i = d.data ?? { ...item, panel: [], lead: null };
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { timeZone: displayZone, dateStyle: "medium", timeStyle: "short" });
  const link = safeLink(i.meetingUrl);
  const reviewers = (f.data?.items ?? []).filter((x) => x.kind !== "candidate" && (x.scorecard || x.rating !== null));
  return (
    <Drawer title="Interview details" onClose={onClose} wide closeLabel="Close interview details">
      <div className="drawerperson"><Avatar name={i.candidate.name} /><div><b>{i.candidate.name ?? "Candidate"}</b>
        <span className={`badge st-${i.callStatus === "scheduled" ? "interview_scheduled" : i.callStatus === "completed" ? "selected" : "under_review"}`}>{label(i.callStatus)}</span>
        {i.position && <span className="block muted">{i.position}</span>}</div></div>
      {d.isError && <p role="alert">Could not load the interview details.</p>}
      <section className="card pad" aria-labelledby={`${item.id}-info`}>
        <h2 id={`${item.id}-info`}>Interview info</h2>
        <dl className="infogrid">
          <div><dt>Candidate name</dt><dd>{i.candidate.name ?? "—"}</dd></div>
          <div><dt>Position</dt><dd>{i.position ?? "—"}</dd></div>
          <div><dt>Round name</dt><dd>{i.round}</dd></div>
          <div><dt>Interview type</dt><dd>{i.interviewType ? INTERVIEW_TYPE_LABELS[i.interviewType] : "—"}</dd></div>
          {link && <div><dt>Meeting link</dt><dd><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></dd></div>}
          <div><dt>Interview slot</dt><dd><time dateTime={i.startsAt}>{when(i.startsAt)}</time></dd></div>
          <div><dt>Panel list</dt><dd>{d.isPending ? "Loading…" : i.panel.length ? i.panel.map((p) => p.name).join(", ") : "—"}</dd></div>
          <div><dt>Lead user</dt><dd>{i.lead?.name ?? "—"}</dd></div>
          <div><dt>Interview duration (in mins)</dt><dd>{i.durationMin ?? "—"}</dd></div>
          <div><dt>Client</dt><dd>{i.client?.name ?? "—"}</dd></div>
          <div><dt>Coach</dt><dd>{i.coach?.name ?? "—"}</dd></div>
        </dl>
        {i.callStatus === "scheduled" && <a className="btn sm calbtn" href={`/api/v1/interviews/${encodeURIComponent(i.id)}/calendar.ics`} download><CalendarPlus size={15} aria-hidden="true" /> Add to calendar (.ics)</a>}
      </section>
      <section aria-labelledby={`${item.id}-rev`} className="reviewers">
        <h2 id={`${item.id}-rev`} className="sectiontitle">Reviewers</h2>
        {f.isPending && <p>Loading feedback…</p>}{f.isError && <p role="alert">Could not load feedback.</p>}
        {!f.isPending && !f.isError && reviewers.length === 0 && <p className="muted">No scored feedback yet.</p>}
        {reviewers.map((r) => (
          <article key={r.id} className="card pad reviewer" aria-label={`Reviewer: ${r.author?.name ?? "Unknown"}`}>
            <h3>Reviewer: {r.author?.name ?? "Unknown"}</h3>
            <dl className="infogrid">
              <div><dt>Round</dt><dd>{r.round ?? i.round}</dd></div>
              <div><dt>Reviewer role</dt><dd>{KIND_LABELS[r.kind] ?? label(r.kind)}</dd></div>
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

export function InterviewsPage({ me }: { me: Me }) {
  const [displayZone, setDisplayZone] = useState(zone);
  const [clientFilter, setClientFilter] = useState<Named | null>(null);
  const qc = useQueryClient(); const [from, setFrom] = useState(localInput(new Date().toISOString()).slice(0, 10)); const [to, setTo] = useState(""); const [status, setStatus] = useState(""); const [cleared, setCleared] = useState(""); const [locationId, setLocationId] = useState("");
  // Interview location (B2.3): narrows the board within the caller's scope; the server applies the scope.
  const locations = useLookups().data?.locations ?? [];
  const [schedule, setSchedule] = useState(false); const [edit, setEdit] = useState<Interview | null>(null); const [feedback, setFeedback] = useState<Interview | null>(null); const [details, setDetails] = useState<Interview | null>(null); const [notice, setNotice] = useState("");
  const invalidRange = Boolean(from && to && from > to);
  const q = useInfiniteQuery({ queryKey: ["interviews", from, to, status, cleared, locationId, clientFilter?.id], initialPageParam: "", enabled: !invalidRange, queryFn: ({ pageParam }) => {
    const p = new URLSearchParams({ limit: "50" }); if (from) p.set("from", dateBoundary(from)); if (to) p.set("to", dateBoundary(to, true)); if (status) p.set("status", status); if (cleared) p.set("cleared", cleared); if (locationId) p.set("locationId", locationId); if (clientFilter) p.set("clientId", clientFilter.id); if (pageParam) p.set("cursor", pageParam);
    return api<Page<Interview>>(`/api/v1/interviews?${p}`);
  }, getNextPageParam: p => p.nextCursor || undefined });
  const done = () => { setSchedule(false); setEdit(null); setNotice("Interview saved."); void qc.invalidateQueries({ queryKey: ["interviews"] }); void qc.invalidateQueries({ queryKey: ["interview"] }); };
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  return <section className="panel"><div className="pagehead"><div><h1>Interviews</h1><p className="sub">Schedule, clear and review interviews. Board times in {displayZone}. Date filters and scheduling use {zone}.</p></div>{me.capabilities.includes("interview:create") && <button className="btn primary push" onClick={() => setSchedule(true)}>Schedule interview</button>}</div>
    <div className="toolbar"><Field title="Display timezone"><select value={displayZone} onChange={e => setDisplayZone(e.target.value)}><option value={zone}>{zone} (local)</option>{zone !== "America/New_York" && <option value="America/New_York">America/New_York (EST/EDT)</option>}</select></Field><Field title="From date"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field title="Through date"><input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      <Field title="Call status filter"><select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
      <Field title="Clearance filter"><select value={cleared} onChange={e => setCleared(e.target.value)}><option value="">All</option><option value="true">Cleared</option><option value="false">Not cleared</option></select></Field>
      {locations.length > 1 && <Field title="Location filter"><select value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">All locations</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <button className="btn" onClick={() => { setFrom(localInput(new Date().toISOString()).slice(0,10)); setTo(localInput(new Date().toISOString()).slice(0,10)); }}>Today</button>
      <button className="btn" onClick={() => { setFrom(""); setTo(""); setStatus(""); setCleared(""); setLocationId(""); setClientFilter(null); }}>Reset filters</button>
    </div>
    {clientFilter && <p className="hint">Client history: {clientFilter.name} <button className="btn" onClick={() => setClientFilter(null)}>Clear client filter</button></p>}
    {notice && <p role="status" className="livemsg">{notice}</p>}{invalidRange && <p role="alert">Through date must be on or after From date.</p>}
    {!invalidRange && q.isPending && <p>Loading interviews…</p>}{q.isError && <p role="alert">Could not load interviews. <button className="btn" onClick={() => void q.refetch()}>Retry</button></p>}
    {!invalidRange && <div className="card tablewrap"><table><thead><tr><th>Candidate / client</th><th>Time / round</th><th>Team / location</th><th>Readiness</th><th>Recordings</th><th>Actions</th></tr></thead><tbody>{items.map(i => <tr key={i.id}>
      <td><b>{i.candidate.name ?? "Candidate"}</b><span className="block">{i.client ? <button className="linkbtn" aria-label={`View history for ${i.client.name}`} onClick={() => { setClientFilter(i.client); setFrom(""); setTo(""); setStatus(""); setCleared(""); setLocationId(""); }}>{i.client.name}</button> : "No client"}</span><span className="block">Recruiter: {i.recruiter.name}</span></td>
      <td><time dateTime={i.startsAt}>{new Date(i.startsAt).toLocaleString(undefined, { timeZone: displayZone })}</time><span className="block">to {new Date(i.endsAt).toLocaleString(undefined, { timeZone: displayZone })}</span><span className="block">{i.round} · {label(i.callStatus)}{i.interviewType ? ` · ${INTERVIEW_TYPE_LABELS[i.interviewType]}` : ""}</span></td>
      <td>{i.team?.name ?? "—"}<span className="block">{i.location?.name ?? "No location"}</span><span className="block">Coach: {i.coach?.name ?? "Unassigned"}</span></td>
      <td>{i.cleared ? "Cleared" : "Not cleared"}<span className="block">{i.inviteReceived ? "Invite received" : "Awaiting invite"}</span><span className="block">{i.consentCaptured ? "Consent captured" : "Consent pending"}</span>{i.systemName && <span className="block">{i.systemName}</span>}</td>
      <td>{i.consentCaptured ? <>{i.otterUrl?.startsWith("https://") && <a href={i.otterUrl} target="_blank" rel="noopener noreferrer">Otter</a>} {i.recordingUrl?.startsWith("https://") && <a href={i.recordingUrl} target="_blank" rel="noopener noreferrer">Recording</a>}{!i.otterUrl && !i.recordingUrl && "—"}</> : "Consent required"}</td>
      <td><div className="rowactions"><button className="btn" aria-label={`Details of the interview with ${i.candidate.name ?? "the candidate"}`} onClick={() => setDetails(i)}>Details</button>{i.editableFields.length > 0 && <button className="btn" onClick={() => setEdit(i)}>Edit interview</button>}<button className="btn" onClick={() => setFeedback(i)}>Feedback</button></div></td>
    </tr>)}</tbody></table>{!q.isPending && !q.isError && !items.length && <p className="empty">No interviews match these filters.</p>}</div>}
    {q.hasNextPage && <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more interviews</button>}
    {schedule && <Schedule onClose={() => setSchedule(false)} onDone={done} />}{edit && <Edit item={edit} onClose={() => setEdit(null)} onDone={done} />}{feedback && <Feedback item={feedback} onClose={() => setFeedback(null)} />}
    {details && <InterviewDrawer item={details} displayZone={displayZone} onClose={() => setDetails(null)} />}
  </section>;
}
