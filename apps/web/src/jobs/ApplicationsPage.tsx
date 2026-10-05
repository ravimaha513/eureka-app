import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, APP_INTERVIEW_ROUNDS, APP_INTERVIEW_TYPES, isSafeHttpsUrl,
  type ApplicationStatus,
} from "@eureka/shared";
import type { Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { useLookups } from "../lookups";
import { Drawer, Field, fmtDate } from "../sales/ui";
import { Person } from "../shell/ui";
import { JobFacts } from "./JobsPage";
import { RichTextView } from "./RichText";
import {
  applicationError, applicationKeys, applicationsApi, type AppInterview, type Application, type ApplicationDetail,
} from "./applicationsApi";
import { jobKeys, jobsApi, type Job } from "./jobsApi";
import "./jobs.css";

const PAGE_SIZE = 50;

export const AppStatus = ({ status }: { status: string }) =>
  <span className={`badge app-${status}`}>{APPLICATION_STATUS_LABELS[status as ApplicationStatus] ?? status}</span>;
export const InterviewStatusBadge = ({ status }: { status: string }) => <span className={`badge ai-${status}`}>{APP_INTERVIEW_LABELS[status] ?? status}</span>;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;

/** Applications (staff): HR sees all; a hiring manager their jobs'; an interviewer those they review (the server decides). */
export function ApplicationsPage({ me, initialOpenId }: { me: Pick<Me, "capabilities" | "id">; initialOpenId?: string | null }) {
  const id = useId();
  const [status, setStatus] = useState("");
  const [jobId, setJobId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const filters = { status, jobId, search, cursor: cursors[page] ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: [...applicationKeys.all, "list", filters], queryFn: () => applicationsApi.list(filters), placeholderData: keepPreviousData });
  const jobs = useQuery({
    queryKey: [...jobKeys.all, "list", { kind: "internal_opening", picker: true }],
    queryFn: () => jobsApi.list({ kind: "internal_opening", limit: 200 }), enabled: me.capabilities.includes("job:read"), retry: false,
  });
  const items = q.data?.items ?? [];
  const canExport = me.capabilities.includes("application:read");
  const hasFilters = Boolean(status || jobId || search);
  const n = items.length;

  return (
    <>
      <div className="pagehead">
        <div style={{ flex: 1 }}>
          <h1 tabIndex={-1}>Applications</h1>
          <p className="sub">Applications from the careers portal to our internal openings.</p>
        </div>
        {canExport && (
          <button type="button" className="btn" onClick={async () => {
            try { const r = await applicationsApi.exportCsv({ status, jobId, search }); setNotice(`Exported ${r.rows} applications${r.truncated ? " (first 5,000 only)" : ""}.`); }
            catch (e) { setNotice(applicationError(e)); }
          }}><Download size={16} aria-hidden="true" /> Export</button>
        )}
      </div>

      <form className="filters" role="search" aria-label="Application filters" onSubmit={(e) => e.preventDefault()}>
        <div className="chipfilter">
          <span id={`${id}-s`} className="chiplabel">Status</span>
          <div className="tabs wrap" role="group" aria-labelledby={`${id}-s`}>
            <button type="button" className="tab" aria-pressed={status === ""} onClick={() => { setStatus(""); reset(); }}>All</button>
            {APPLICATION_STATUSES.map((s) => <button key={s} type="button" className="tab" aria-pressed={status === s} onClick={() => { setStatus(status === s ? "" : s); reset(); }}>{APPLICATION_STATUS_LABELS[s]}</button>)}
          </div>
        </div>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Applicant</label>
            <input id={`${id}-q`} type="search" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          {(jobs.data?.items.length ?? 0) > 0 && (
            <label className="field inline">Job
              <select value={jobId} onChange={(e) => { setJobId(e.target.value); reset(); }}>
                <option value="">All jobs</option>
                {jobs.data!.items.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
              </select>
            </label>
          )}
          {hasFilters && <button type="button" className="btn" onClick={() => { setStatus(""); setJobId(""); setSearchText(""); setSearch(""); reset(); }}>Clear filters</button>}
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{applicationError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <div className="tablewrap"><table aria-label="Applications" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>Job title</th><th>Applicant</th><th>Company</th><th>Applied</th><th>Overall rating</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.job.title ?? "—"}</b></td>
                  <td><Person name={a.applicant.name}>{a.applicant.name ?? "—"}<span className="block muted">{a.applicant.email}</span></Person></td>
                  <td>{a.company?.name ?? <span className="muted">Internal opening</span>}</td>
                  <td>{fmtDate(a.appliedAt)}</td>
                  <td>{a.overallRating ?? <span className="muted">—</span>}</td>
                  <td><AppStatus status={a.status} /></td>
                  <td className="rowactions"><button type="button" className="btn sm" onClick={() => setOpenId(a.id)} aria-label={`Open application of ${a.applicant.name ?? "applicant"}`}>Open</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="empty">{hasFilters ? "No applications match these filters." : "No applications for you yet."}</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{q.isLoading || q.error ? "" : `${n} ${n === 1 ? "application" : "applications"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`}</p>
        <nav className="pager" aria-label="Application pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>
      {openId && <ApplicationDrawer id={openId} initial={items.find((a) => a.id === openId)} me={me} onClose={() => setOpenId(null)} onNotice={setNotice} />}
    </>
  );
}

type Tab = "job" | "applicant" | "interviews";
type Action = { kind: "people"; interview: AppInterview } | { kind: "status" } | { kind: "schedule" } | { kind: "candidate" } | { kind: "scorecard"; interview: AppInterview } | { kind: "interview"; interview: AppInterview };

function ApplicationDrawer({ id, initial, me, onClose, onNotice }: {
  id: string; initial?: Application; me: Pick<Me, "id" | "capabilities">; onClose: () => void; onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const tabId = useId();
  const q = useQuery({ queryKey: applicationKeys.detail(id), queryFn: () => applicationsApi.get(id),
    placeholderData: initial ? { ...initial, interviews: [], history: [] } as ApplicationDetail : undefined });
  const [tab, setTab] = useState<Tab>("job");
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const a = q.data;
  const full = Boolean(a && !q.isPlaceholderData);
  const done = (m: string) => {
    setAction(null); setMessage(m); onNotice(m);
    void qc.invalidateQueries({ queryKey: applicationKeys.all });
    void qc.invalidateQueries({ queryKey: jobKeys.all });
  };
  const job = a && "category" in a.job ? (a.job as Job) : null;
  return (
    <>
      <Drawer title={a ? `${a.job.title ?? "Application"} · ${a.applicant.name ?? ""}` : "Application"} onClose={onClose} suspended={action !== null} wide closeLabel="Close application details">
        {!a ? (q.isLoading ? <p className="empty">Loading…</p> : <p className="error" role="alert">{applicationError(q.error)}</p>) : (
          <>
            <p><AppStatus status={a.status} />{a.overallRating !== null && <span className="muted"> · Overall rating {a.overallRating} / 5</span>}</p>
            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            {(a.actions.transition.length > 0 || a.actions.scheduleInterview || a.actions.createCandidate || (a.status === "hired" && !a.candidateId)) && (
              <div className="rowactions" role="group" aria-label="Application actions">
                {a.actions.transition.length > 0 && <button type="button" className="btn sm" onClick={() => setAction({ kind: "status" })}>Change status…</button>}
                {a.actions.scheduleInterview && <button type="button" className="btn sm" onClick={() => setAction({ kind: "schedule" })}>Schedule interview…</button>}
                {a.actions.createCandidate && <button type="button" className="btn sm primary" onClick={() => setAction({ kind: "candidate" })}>Create candidate…</button>}
                {a.status === "hired" && !a.candidateId && !a.actions.createCandidate && <small className="hint">Creating the Eureka candidate needs a Sales role that creates candidates.</small>}
              </div>
            )}
            {a.candidateId && <p className="note">A Eureka candidate was created from this application.</p>}
            <div className="tabs" role="tablist" aria-label="Application sections">
              {(["job", "applicant", "interviews"] as const).map((t) => (
                <button key={t} type="button" role="tab" id={`${tabId}-${t}`} className="tab" aria-selected={tab === t} aria-controls={`${tabId}-${t}-p`} onClick={() => setTab(t)}>
                  {t === "job" ? "Job details" : t === "applicant" ? "Applicant" : `Interviews${full ? ` (${a.interviews.length})` : ""}`}
                </button>
              ))}
            </div>
            <section role="tabpanel" id={`${tabId}-${tab}-p`} aria-labelledby={`${tabId}-${tab}`} className="manageblock">
              {tab === "job" && (job ? (
                <>
                  <JobFacts j={job} />
                  <h3>Requirements</h3><RichTextView doc={job.requirements} />
                  <h3>Description</h3><RichTextView doc={job.description} />
                </>
              ) : <p className="muted">{full ? "Job details are not available to you." : "Loading…"}</p>)}
              {tab === "applicant" && (
                <dl className="facts">
                  <dt>Name</dt><dd>{a.applicant.name ?? "—"}</dd>
                  <dt>Email</dt><dd>{a.applicant.email ?? "—"}{a.applicant.emailVerified ? " (verified)" : ""}</dd>
                  <dt>Phone</dt><dd>{a.applicant.phone ? <span className={a.applicant.phoneMasked ? "masked" : undefined}>{a.applicant.phone}</span> : "—"}</dd>
                  <dt>Applied</dt><dd>{fmtWhen(a.appliedAt)}</dd>
                  <dt>Status since</dt><dd>{fmtWhen(a.statusChangedAt)}</dd>
                </dl>
              )}
              {tab === "interviews" && (!full ? <p className="muted">Loading interviews…</p> : a.interviews.length === 0 ? <p className="muted">No interviews yet.</p> : (
                <div className="tablewrap"><table className="mini" aria-label="Interviews">
                  <thead><tr><th>Type</th><th>Round</th><th>Slot</th><th>Status</th><th>Rating</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {a.interviews.map((i) => {
                      const avg = i.scorecards.length ? (i.scorecards.reduce((s, c) => s + (c.technical + c.communication + c.problemSolving + c.attitude) / 4, 0) / i.scorecards.length).toFixed(1) : null;
                      return (
                        <tr key={i.id}>
                          <td><span className="badge pill">{APP_INTERVIEW_LABELS[i.interviewType]}</span></td>
                          <td>{APP_INTERVIEW_LABELS[i.round]}</td>
                          <td>{fmtWhen(i.startsAt)}<span className="block muted">{i.durationMinutes} min</span></td>
                          <td><InterviewStatusBadge status={i.status} /></td>
                          <td>{avg ?? <span className="muted">—</span>}</td>
                          <td className="rowactions">
                            <button type="button" className="btn sm" onClick={() => setAction({ kind: "interview", interview: i })} aria-label={`Interview details ${APP_INTERVIEW_LABELS[i.round]}`}>Details</button>
                            {i.actions.scorecard && <button type="button" className="btn sm" onClick={() => setAction({ kind: "scorecard", interview: i })} aria-label={`Review ${APP_INTERVIEW_LABELS[i.round]}`}>Review</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              ))}
            </section>
            {full && a.history.length > 0 && (
              <section className="manageblock" aria-label="History">
                <h3>History</h3>
                <ol className="timeline">
                  {a.history.map((h) => (
                    <li key={h.id}>
                      <b>{h.kind === "status" ? `${APPLICATION_STATUS_LABELS[h.fromStatus as ApplicationStatus] ?? h.fromStatus} → ${APPLICATION_STATUS_LABELS[h.toStatus as ApplicationStatus] ?? h.toStatus}`
                        : h.kind === "applied" ? "Applied" : h.kind === "withdrawn" ? "Withdrawn by the applicant" : h.kind === "interview_scheduled" ? "Interview scheduled"
                        : h.kind === "interview_status" ? `Interview ${APP_INTERVIEW_LABELS[h.toStatus ?? ""]?.toLowerCase() ?? ""}` : "Candidate created"}</b>
                      {h.comment && <span className="block note">{h.comment}</span>}
                      <span className="block muted">{fmtWhen(h.at)}{h.actor ? ` · ${h.actor}` : ""}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </Drawer>
      {a && action?.kind === "status" && <StatusDialog a={a} onClose={() => setAction(null)} onDone={(s) => done(`Status changed to ${APPLICATION_STATUS_LABELS[s]}. The applicant was emailed.`)} />}
      {a && action?.kind === "schedule" && <ScheduleDialog a={a} me={me} onClose={() => setAction(null)} onDone={() => done("Interview scheduled. The applicant was emailed.")} />}
      {a && action?.kind === "candidate" && <CandidateDialog a={a} onClose={() => setAction(null)} onDone={() => done("Candidate created in Eureka.")} />}
      {a && action?.kind === "scorecard" && <ScorecardDialog i={action.interview} meId={me.id} onClose={() => setAction(null)} onDone={() => done("Review saved.")} />}
      {a && action?.kind === "interview" && <InterviewDialog i={action.interview} onClose={() => setAction(null)} onDone={(m) => done(m)} onPeople={() => setAction({ kind: "people", interview: action.interview })} />}
      {a && action?.kind === "people" && <PeopleDialog i={action.interview} onClose={() => setAction(null)} onDone={() => done("Interviewers updated.")} />}
    </>
  );
}

function StatusDialog({ a, onClose, onDone }: { a: ApplicationDetail; onClose: () => void; onDone: (s: ApplicationStatus) => void }) {
  const [to, setTo] = useState<ApplicationStatus>(a.actions.transition[0]!);
  const [comment, setComment] = useState("");
  const { busy, error, run } = useSubmit(applicationError);
  return (
    <Dialog title="Application status" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await applicationsApi.setStatus(a.id, a.rowVersion, to, comment.trim() || undefined); onDone(to); }); }}>
        <Field label="Status">{(p) => (
          <select {...p} value={to} onChange={(e) => setTo(e.target.value as ApplicationStatus)} data-autofocus>
            {a.actions.transition.map((s) => <option key={s} value={s}>{APPLICATION_STATUS_LABELS[s]}</option>)}
          </select>
        )}</Field>
        <Field label="Comment (internal, optional)" hint="Staff only: never shown or emailed to the applicant.">
          {(p) => <textarea {...p} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Save status" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function ScheduleDialog({ a, me, onClose, onDone }: { a: ApplicationDetail; me: Pick<Me, "id">; onClose: () => void; onDone: () => void }) {
  const opts = useQuery({ queryKey: jobKeys.options, queryFn: jobsApi.options, retry: false, staleTime: 5 * 60_000 });
  const staff = opts.data?.staff ?? [{ id: me.id, name: "Me" }];
  const [v, setV] = useState({ interviewType: "video", round: "screening", leadUserId: me.id, panel: [] as string[], startsAt: localInput(new Date(Date.now() + 86_400_000)), duration: "30", link: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit(applicationError);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!v.startsAt || Number.isNaN(Date.parse(v.startsAt))) er.startsAt = "Choose the interview slot.";
    if (v.link.trim() && !isSafeHttpsUrl(v.link.trim())) er.link = "Meeting links must start with https://";
    setErrors(er);
    if (Object.keys(er).length) return;
    void run(async () => {
      await applicationsApi.schedule(a.id, { interviewType: v.interviewType, round: v.round, leadUserId: v.leadUserId, panelUserIds: v.panel,
        startsAt: new Date(v.startsAt).toISOString(), durationMinutes: Number(v.duration), ...(v.link.trim() ? { meetingLink: v.link.trim() } : {}) });
      onDone();
    });
  };
  return (
    <Dialog title="Create interview" onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <fieldset className="radios"><legend>Interview type</legend>
          {APP_INTERVIEW_TYPES.map((t) => <label key={t}><input type="radio" name="itype" checked={v.interviewType === t} onChange={() => setV({ ...v, interviewType: t })} />{APP_INTERVIEW_LABELS[t]}</label>)}
        </fieldset>
        <div className="grid2">
          <Field label="Round of interview">{(p) => <select {...p} value={v.round} onChange={(e) => setV({ ...v, round: e.target.value })}>{APP_INTERVIEW_ROUNDS.map((r) => <option key={r} value={r}>{APP_INTERVIEW_LABELS[r]}</option>)}</select>}</Field>
          <Field label="Lead user">{(p) => <select {...p} value={v.leadUserId} onChange={(e) => setV({ ...v, leadUserId: e.target.value })}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <Field label="Interview slot" error={errors.startsAt}>{(p) => <input {...p} type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />}</Field>
          <Field label="Duration (minutes)">{(p) => <select {...p} value={v.duration} onChange={(e) => setV({ ...v, duration: e.target.value })}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m}</option>)}</select>}</Field>
        </div>
        <Field label="Panel (optional)" hint="Hold Ctrl or Cmd to choose several. Panel members can review the interview.">
          {(p) => <select {...p} multiple size={Math.min(6, Math.max(3, staff.length))} value={v.panel}
            onChange={(e) => setV({ ...v, panel: [...e.target.selectedOptions].map((o) => o.value).slice(0, 10) })}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        </Field>
        <Field label="Meeting link (optional)" error={errors.link}>{(p) => <input {...p} type="url" placeholder="https://" maxLength={2000} value={v.link} onChange={(e) => setV({ ...v, link: e.target.value })} />}</Field>
        <DialogActions onCancel={onClose} submitLabel="Create interview" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function CandidateDialog({ a, onClose, onDone }: { a: ApplicationDetail; onClose: () => void; onDone: () => void }) {
  const lookups = useLookups();
  const [tech, setTech] = useState("");
  const [loc, setLoc] = useState("");
  const [dup, setDup] = useState(false);
  const { busy, error, run, setError } = useSubmit(applicationError);
  return (
    <Dialog title={`Create candidate · ${a.applicant.name ?? ""}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!tech || !loc) { setError("Choose the technology and the location."); return; }
        void run(async () => {
          try { await applicationsApi.createCandidate(a.id, { technologyId: tech, locationId: loc, ...(dup ? { confirmDuplicate: true } : {}) }); onDone(); }
          catch (err) { if ((err as { detail?: string }).detail === "possible_duplicate") setDup(true); throw err; }
        });
      }}>
        <p className="dialogbody">Creates a Eureka candidate with the applicant's name, email and phone, in your team.</p>
        <Field label="Technology">{(p) => <select {...p} value={tech} onChange={(e) => setTech(e.target.value)} data-autofocus><option value="" disabled>Choose…</option>{(lookups.data?.technologies ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Location">{(p) => <select {...p} value={loc} onChange={(e) => setLoc(e.target.value)}><option value="" disabled>Choose…</option>{(lookups.data?.locations ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        {dup && <p className="note warn">A possible duplicate exists. Create anyway only if you checked it is a different person; submitting again confirms.</p>}
        <DialogActions onCancel={onClose} submitLabel={dup ? "Create anyway" : "Create candidate"} busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

const SCORE_LABELS = [["technical", "Technical skills"], ["communication", "Communication"], ["problemSolving", "Problem solving"], ["attitude", "Attitude"]] as const;

function ScorecardDialog({ i, meId, onClose, onDone }: { i: AppInterview; meId: string; onClose: () => void; onDone: () => void }) {
  const mine = i.scorecards.find((s) => s.reviewer.id === meId);
  const [v, setV] = useState({ technical: mine?.technical ?? 3, communication: mine?.communication ?? 3, problemSolving: mine?.problemSolving ?? 3, attitude: mine?.attitude ?? 3 });
  const [notes, setNotes] = useState(mine?.notes ?? "");
  const { busy, error, run } = useSubmit(applicationError);
  return (
    <Dialog title={`Review · ${APP_INTERVIEW_LABELS[i.round]}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await applicationsApi.scorecard(i.id, { ...v, ...(notes.trim() ? { notes: notes.trim() } : {}) }); onDone(); }); }}>
        {SCORE_LABELS.map(([k, label]) => (
          <fieldset key={k} className="radios"><legend>{label}</legend>
            {[1, 2, 3, 4, 5].map((n) => <label key={n}><input type="radio" name={k} checked={v[k] === n} onChange={() => setV({ ...v, [k]: n })} />{n}</label>)}
          </fieldset>
        ))}
        <Field label="Notes (optional)">{(p) => <textarea {...p} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <DialogActions onCancel={onClose} submitLabel="Save review" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function PeopleDialog({ i, onClose, onDone }: { i: AppInterview; onClose: () => void; onDone: () => void }) {
  const opts = useQuery({ queryKey: jobKeys.options, queryFn: jobsApi.options, retry: false, staleTime: 5 * 60_000 });
  const staff = opts.data?.staff ?? [];
  const [lead, setLead] = useState(i.lead.id);
  const [panel, setPanel] = useState<string[]>(i.panel.map((p) => p.id));
  const { busy, error, run } = useSubmit(applicationError);
  return (
    <Dialog title="Lead and panel" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await applicationsApi.setPeople(i.id, { leadUserId: lead, panelUserIds: panel }); onDone(); }); }}>
        <p className="dialogbody">People removed here lose access to this application at once.</p>
        <Field label="Lead user">{(p) => <select {...p} value={lead} onChange={(e) => setLead(e.target.value)} data-autofocus>
          {[{ id: i.lead.id, name: i.lead.name ?? "Current lead" }, ...staff.filter((s) => s.id !== i.lead.id)].map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <Field label="Panel" hint="Hold Ctrl or Cmd to choose several.">{(p) => <select {...p} multiple size={6} value={panel}
          onChange={(e) => setPanel([...e.target.selectedOptions].map((o) => o.value).slice(0, 10))}>
          {[...i.panel, ...staff.filter((s) => !i.panel.some((x) => x.id === s.id))].map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <DialogActions onCancel={onClose} submitLabel="Save" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function InterviewDialog({ i, onClose, onDone, onPeople }: { i: AppInterview; onClose: () => void; onDone: (m: string) => void; onPeople: () => void }) {
  const { busy, error, run } = useSubmit(applicationError);
  return (
    <Dialog title={`Interview · ${APP_INTERVIEW_LABELS[i.round]}`} onClose={onClose} wide>
      <dl className="facts">
        <dt>Type</dt><dd>{APP_INTERVIEW_LABELS[i.interviewType]}</dd>
        <dt>Slot</dt><dd>{fmtWhen(i.startsAt)} · {i.durationMinutes} min</dd>
        <dt>Status</dt><dd><InterviewStatusBadge status={i.status} /></dd>
        <dt>Lead user</dt><dd>{i.lead.name ?? "—"}</dd>
        <dt>Panel</dt><dd>{i.panel.length ? i.panel.map((p) => p.name).join(", ") : "—"}</dd>
        <dt>Meeting link</dt><dd>{i.meetingLink && isSafeHttpsUrl(i.meetingLink) ? <a href={i.meetingLink} target="_blank" rel="noopener noreferrer">{i.meetingLink}</a> : "—"}</dd>
      </dl>
      <h3 className="formsection">Reviews</h3>
      {i.scorecards.length === 0 ? <p className="muted">No reviews yet.</p> : i.scorecards.map((s) => (
        <div key={s.id} className="manageblock">
          <b>{s.reviewer.name}</b>
          <div className="scoregrid">
            {SCORE_LABELS.map(([k, label]) => <div key={k}><small className="muted">{label}</small><div className="stars" aria-label={`${label}: ${s[k]} of 5`}>{stars(s[k])}</div></div>)}
          </div>
          {s.notes && <p className="block note">{s.notes}</p>}
        </div>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {i.actions.setStatus && (["completed", "no_show", "cancelled"] as const).map((s) => (
          <button key={s} type="button" className="btn" disabled={busy} onClick={() => void run(async () => { await applicationsApi.interviewStatus(i.id, s); onDone(`Interview marked ${(APP_INTERVIEW_LABELS[s] ?? s).toLowerCase()}.`); })}>
            Mark {(APP_INTERVIEW_LABELS[s] ?? s).toLowerCase()}
          </button>
        ))}
        {i.actions.setStatus && <button type="button" className="btn" disabled={busy} onClick={onPeople}>Change lead or panel…</button>}
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>Close</button>
      </div>
    </Dialog>
  );
}
