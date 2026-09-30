import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";

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
function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return <label className="field"><span>{title}</span>{children}</label>;
}
function Coaches({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery({ queryKey: ["interview-coaches"], queryFn: () => api<{ items: Named[] }>("/api/v1/interviews/coaches") });
  return <Field title="Coach"><select value={value} onChange={e => onChange(e.target.value)}><option value="">Unassigned</option>
    {value && !q.data?.items.some(c => c.id === value) && <option value={value}>Current coach</option>}
    {q.data?.items.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>{q.isError && <span role="alert">Coach list unavailable. Try reopening this form.</span>}</Field>;
}
function Schedule({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [submissionId, setSubmission] = useState(""); const [round, setRound] = useState("");
  const [start, setStart] = useState(""); const [end, setEnd] = useState(""); const [coach, setCoach] = useState("");
  const [invite, setInvite] = useState(false); const [search, setSearch] = useState("");
  const submit = useSubmit(errorText);
  const subs = useInfiniteQuery({ queryKey: ["interview-submissions"], initialPageParam: "", queryFn: ({ pageParam }) => api<Page<Submission>>(`/api/v1/submissions?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`), getNextPageParam: p => p.nextCursor || undefined });
  const options = subs.data?.pages.flatMap(p => p.items).filter(s => !["selected", "rejected", "withdrawn"].includes(s.status) && s.canUpdate !== false && `${s.candidateName} ${s.client} ${s.jobTitle}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <Dialog title="Schedule interview" onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    if (new Date(end).getTime() <= new Date(start).getTime()) throw new Error("End must be after start.");
    await api("/api/v1/interviews", { method: "POST", body: JSON.stringify({ submissionId, round, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), ...(coach ? { coachId: coach } : {}), inviteReceived: invite }) }); onDone();
  }); }}>
    <Field title="Find a submission"><input value={search} onChange={e => { setSearch(e.target.value); setSubmission(""); }} placeholder="Candidate, client or job title" /></Field>
    <Field title="Submission"><select required value={submissionId} onChange={e => setSubmission(e.target.value)}><option value="">Select an open submission</option>{options.map(s => <option key={s.id} value={s.id}>{s.candidateName} · {s.client} · {s.jobTitle}</option>)}</select></Field>
    {subs.isPending && <p role="status">Loading submissions…</p>}{subs.isError && <p role="alert">Could not load submissions.</p>}
    {!subs.isPending && !options.length && <p>No matching open submissions. Log a submission from the candidate profile first, or load more below.</p>}
    {subs.hasNextPage && <button type="button" className="btn" disabled={subs.isFetchingNextPage} onClick={() => void subs.fetchNextPage()}>Load more submissions</button>}
    <Field title="Round"><input required maxLength={40} value={round} onChange={e => setRound(e.target.value)} /></Field>
    <p className="hint">Enter times in {zone}. Interviews may last up to 12 hours.</p>
    <Field title="Start"><input required type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></Field>
    <Field title="End"><input required type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></Field>
    <Coaches value={coach} onChange={setCoach} />
    <label><input type="checkbox" checked={invite} onChange={e => setInvite(e.target.checked)} /> Invite received</label>
    <DialogActions onCancel={onClose} submitLabel="Schedule" busy={submit.busy} error={submit.error} disabled={!submissionId} />
  </form></Dialog>;
}
function Edit({ item, onClose, onDone }: { item: Interview; onClose: () => void; onDone: () => void }) {
  const initial: Record<string, string | boolean> = { round: item.round, startsAt: localInput(item.startsAt), endsAt: localInput(item.endsAt), coachId: item.coach?.id ?? "", inviteReceived: item.inviteReceived, callStatus: item.callStatus, cleared: item.cleared, consentCaptured: item.consentCaptured, systemName: item.systemName ?? "", otterUrl: item.otterUrl ?? "", recordingUrl: item.recordingUrl ?? "" };
  const [values, setValues] = useState(initial); const submit = useSubmit(errorText);
  const set = (k: string, v: string | boolean) => setValues(s => ({ ...s, [k]: v }));
  return <Dialog title={`Edit interview · ${item.candidate.name}`} onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
    const body: Record<string, unknown> = {};
    for (const k of item.editableFields) if (values[k] !== initial[k]) body[k] = ["startsAt", "endsAt"].includes(k) ? new Date(String(values[k])).toISOString() : values[k] === "" ? null : values[k];
    if (Object.keys(body).length) await api(`/api/v1/interviews/${item.id}`, { method: "PATCH", body: JSON.stringify(body) }); onDone();
  }); }}>
    <p className="hint">Times shown in {zone}. Recording links require captured consent.</p>
    {item.editableFields.map(k => {
      const title: Record<string, string> = { round: "Round", startsAt: "Start", endsAt: "End", coachId: "Coach", inviteReceived: "Invite received", callStatus: "Call status", cleared: "Cleared", consentCaptured: "Consent captured", systemName: "System name", otterUrl: "Otter URL", recordingUrl: "Recording URL" };
      if (!(k in initial)) return null;
      if (typeof values[k] === "boolean") return <div className="field" key={k}><label><input type="checkbox" checked={Boolean(values[k])} onChange={e => set(k, e.target.checked)} /> {title[k]}</label></div>;
      if (k === "coachId") return <Coaches key={k} value={String(values[k])} onChange={v => set(k, v)} />;
      return <Field key={k} title={title[k] ?? k}>{k === "callStatus" ? <select value={String(values[k])} onChange={e => set(k, e.target.value)}>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select> : <input type={k.endsWith("At") ? "datetime-local" : k.endsWith("Url") ? "url" : "text"} required={["round", "startsAt", "endsAt"].includes(k)} maxLength={k === "round" ? 40 : k === "systemName" ? 80 : 500} value={String(values[k])} onChange={e => set(k, e.target.value)} />}</Field>;
    })}
    <DialogActions onCancel={onClose} submitLabel="Save interview" busy={submit.busy} error={submit.error} />
  </form></Dialog>;
}
function Feedback({ item, onClose }: { item: Interview; onClose: () => void }) {
  const qc = useQueryClient(); const [kind, setKind] = useState(item.feedbackKinds[0] ?? ""); const [rating, setRating] = useState(""); const [notes, setNotes] = useState(""); const [saved, setSaved] = useState(false); const submit = useSubmit(errorText);
  const q = useQuery({ queryKey: ["interview-feedback", item.id], queryFn: () => api<{ items: { id: string; kind: string; rating: number | null; notes: string | null; author: Named | null; format?: string | null; topics?: string[] | null; difficultQuestions?: string | null; durationMin?: number | null; nextStep?: string | null }[] }>(`/api/v1/interviews/${item.id}/feedback`) });
  return <Dialog title={`Feedback · ${item.candidate.name}`} onClose={onClose}>
    {q.isPending && <p>Loading feedback…</p>}{q.isError && <p role="alert">Could not load feedback.</p>}
    {q.data?.items.map(f => <div className="note" key={f.id}><b>{label(f.kind)} · {f.author?.name ?? "Candidate"}</b><p>{f.rating ? `${f.rating}/5` : "No rating"}</p><p style={{ whiteSpace: "pre-wrap" }}>{f.notes}</p>{([["Format", f.format], ["Topics", f.topics?.join(", ")], ["Difficult questions", f.difficultQuestions], ["Duration (minutes)", f.durationMin], ["Next step", f.nextStep]] as const).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([name, value]) => <p key={name} style={{ whiteSpace: "pre-wrap" }}><b>{name}:</b> {value}</p>)}</div>)}
    {q.data?.items.length === 0 && <p>No feedback yet.</p>}
    {saved && <p role="status">Feedback added.</p>}
    {item.feedbackKinds.length > 0 && <form onSubmit={e => { e.preventDefault(); void submit.run(async () => {
      await api(`/api/v1/interviews/${item.id}/feedback`, { method: "POST", body: JSON.stringify({ kind, ...(rating ? { rating: Number(rating) } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }) }); setNotes(""); setRating(""); setSaved(true); await qc.invalidateQueries({ queryKey: ["interview-feedback", item.id] });
    }); }}>
      <Field title="Feedback kind"><select value={kind} onChange={e => setKind(e.target.value)}>{item.feedbackKinds.map(k => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
      <Field title="Rating"><select value={rating} onChange={e => setRating(e.target.value)}><option value="">No rating</option>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}/5</option>)}</select></Field>
      <Field title="Notes"><textarea rows={5} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <DialogActions onCancel={onClose} submitLabel="Add feedback" busy={submit.busy} disabled={!rating && !notes.trim()} error={submit.error} />
    </form>}
    {!item.feedbackKinds.length && <button className="btn" onClick={onClose}>Close</button>}
  </Dialog>;
}

export function InterviewsPage({ me }: { me: Me }) {
  const [displayZone, setDisplayZone] = useState(zone);
  const [clientFilter, setClientFilter] = useState<Named | null>(null);
  const qc = useQueryClient(); const [from, setFrom] = useState(localInput(new Date().toISOString()).slice(0, 10)); const [to, setTo] = useState(""); const [status, setStatus] = useState(""); const [cleared, setCleared] = useState("");
  const [schedule, setSchedule] = useState(false); const [edit, setEdit] = useState<Interview | null>(null); const [feedback, setFeedback] = useState<Interview | null>(null); const [notice, setNotice] = useState("");
  const invalidRange = Boolean(from && to && from > to);
  const q = useInfiniteQuery({ queryKey: ["interviews", from, to, status, cleared, clientFilter?.id], initialPageParam: "", enabled: !invalidRange, queryFn: ({ pageParam }) => {
    const p = new URLSearchParams({ limit: "50" }); if (from) p.set("from", dateBoundary(from)); if (to) p.set("to", dateBoundary(to, true)); if (status) p.set("status", status); if (cleared) p.set("cleared", cleared); if (clientFilter) p.set("clientId", clientFilter.id); if (pageParam) p.set("cursor", pageParam);
    return api<Page<Interview>>(`/api/v1/interviews?${p}`);
  }, getNextPageParam: p => p.nextCursor || undefined });
  const done = () => { setSchedule(false); setEdit(null); setNotice("Interview saved."); void qc.invalidateQueries({ queryKey: ["interviews"] }); };
  const items = q.data?.pages.flatMap(p => p.items) ?? [];
  return <section className="panel"><div className="pagehead"><div><h1>Interviews</h1><p className="sub">Schedule, clear and review interviews. Board times in {displayZone}. Date filters and scheduling use {zone}.</p></div>{me.capabilities.includes("interview:create") && <button className="btn primary push" onClick={() => setSchedule(true)}>Schedule interview</button>}</div>
    <div className="toolbar"><Field title="Display timezone"><select value={displayZone} onChange={e => setDisplayZone(e.target.value)}><option value={zone}>{zone} (local)</option>{zone !== "America/New_York" && <option value="America/New_York">America/New_York (EST/EDT)</option>}</select></Field><Field title="From date"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field title="Through date"><input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      <Field title="Call status filter"><select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
      <Field title="Clearance filter"><select value={cleared} onChange={e => setCleared(e.target.value)}><option value="">All</option><option value="true">Cleared</option><option value="false">Not cleared</option></select></Field>
      <button className="btn" onClick={() => { setFrom(localInput(new Date().toISOString()).slice(0,10)); setTo(localInput(new Date().toISOString()).slice(0,10)); }}>Today</button>
      <button className="btn" onClick={() => { setFrom(""); setTo(""); setStatus(""); setCleared(""); setClientFilter(null); }}>Reset filters</button>
    </div>
    {clientFilter && <p className="hint">Client history: {clientFilter.name} <button className="btn" onClick={() => setClientFilter(null)}>Clear client filter</button></p>}
    {notice && <p role="status" className="livemsg">{notice}</p>}{invalidRange && <p role="alert">Through date must be on or after From date.</p>}
    {!invalidRange && q.isPending && <p>Loading interviews…</p>}{q.isError && <p role="alert">Could not load interviews. <button className="btn" onClick={() => void q.refetch()}>Retry</button></p>}
    {!invalidRange && <div className="card tablewrap"><table><thead><tr><th>Candidate / client</th><th>Time / round</th><th>Team / location</th><th>Readiness</th><th>Recordings</th><th>Actions</th></tr></thead><tbody>{items.map(i => <tr key={i.id}>
      <td><b>{i.candidate.name ?? "Candidate"}</b><span className="block">{i.client ? <button className="linkbtn" aria-label={`View history for ${i.client.name}`} onClick={() => { setClientFilter(i.client); setFrom(""); setTo(""); setStatus(""); setCleared(""); }}>{i.client.name}</button> : "No client"}</span><span className="block">Recruiter: {i.recruiter.name}</span></td>
      <td><time dateTime={i.startsAt}>{new Date(i.startsAt).toLocaleString(undefined, { timeZone: displayZone })}</time><span className="block">to {new Date(i.endsAt).toLocaleString(undefined, { timeZone: displayZone })}</span><span className="block">{i.round} · {label(i.callStatus)}</span></td>
      <td>{i.team?.name ?? "—"}<span className="block">{i.location?.name ?? "No location"}</span><span className="block">Coach: {i.coach?.name ?? "Unassigned"}</span></td>
      <td>{i.cleared ? "Cleared" : "Not cleared"}<span className="block">{i.inviteReceived ? "Invite received" : "Awaiting invite"}</span><span className="block">{i.consentCaptured ? "Consent captured" : "Consent pending"}</span>{i.systemName && <span className="block">{i.systemName}</span>}</td>
      <td>{i.consentCaptured ? <>{i.otterUrl?.startsWith("https://") && <a href={i.otterUrl} target="_blank" rel="noopener noreferrer">Otter</a>} {i.recordingUrl?.startsWith("https://") && <a href={i.recordingUrl} target="_blank" rel="noopener noreferrer">Recording</a>}{!i.otterUrl && !i.recordingUrl && "—"}</> : "Consent required"}</td>
      <td><div className="rowactions">{i.editableFields.length > 0 && <button className="btn" onClick={() => setEdit(i)}>Edit interview</button>}<button className="btn" onClick={() => setFeedback(i)}>Feedback</button></div></td>
    </tr>)}</tbody></table>{!q.isPending && !q.isError && !items.length && <p className="empty">No interviews match these filters.</p>}</div>}
    {q.hasNextPage && <button className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more interviews</button>}
    {schedule && <Schedule onClose={() => setSchedule(false)} onDone={done} />}{edit && <Edit item={edit} onClose={() => setEdit(null)} onDone={done} />}{feedback && <Feedback item={feedback} onClose={() => setFeedback(null)} />}
  </section>;
}
