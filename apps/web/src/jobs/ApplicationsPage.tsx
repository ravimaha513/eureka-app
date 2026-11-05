import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Mail } from "lucide-react";
import {
  APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, APP_INTERVIEW_ROUNDS, APP_INTERVIEW_TYPES, PHONE_PROBLEM_MESSAGES, isSafeHttpsUrl, normalizePhoneE164, phoneProblem,
  type ApplicationStatus,
} from "@eureka/shared";
import { can, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { useRoutedId, useSearchParams } from "../lib/router";
import { useLookups } from "../lookups";
import { Drawer, Field, fmtDate } from "../sales/ui";
import { FilterBar } from "../ui/FilterBar";
import { RecordLink } from "../ui/RecordLink";
import { Tabs } from "../ui/Tabs";
import { JobFacts } from "./JobsPage";
import { RichTextView } from "./RichText";
import {
  applicationError, applicationKeys, applicationsApi, type AppInterview, type Application, type ApplicationDetail,
} from "./applicationsApi";
import { jobKeys, jobsApi, type Job } from "./jobsApi";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { NoticeLine, PeoplePicker, fromControl, type Notice } from "./hiringUi";
import "./jobs.css";
import { Loading } from "../ui/Loading";
import { fmtDateTime } from "../lib/format";

const PAGE_SIZE = 50;

export const AppStatus = ({ status }: { status: string }) =>
  <span className={`badge app-${status}`}>{APPLICATION_STATUS_LABELS[status as ApplicationStatus] ?? status}</span>;
export const InterviewStatusBadge = ({ status }: { status: string }) => <span className={`badge ai-${status}`}>{APP_INTERVIEW_LABELS[status] ?? status}</span>;

export const stars = (n: number) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;

type FilterKey = "status" | "jobId" | "q";

/** Applications (staff): HR sees all; a hiring manager their jobs'; an interviewer those they review (the server decides). */
export function ApplicationsPage({ me, initialOpenId, onOpenChange }: {
  me: Pick<Me, "capabilities" | "id">; initialOpenId?: string | null;
  /** The open application changed (the shell keeps it in the URL). */
  onOpenChange?: (id: string | null) => void;
}) {
  const id = useId();
  // Filters live in the address bar (?status=&jobId=&q=), so a refresh, a shared link or opening an application keeps them.
  const [params, setParams] = useSearchParams<FilterKey>(["status", "jobId", "q"]);
  const status = (APPLICATION_STATUSES as readonly string[]).includes(params.status) ? params.status : "";
  const jobId = params.jobId;
  const search = params.q;
  const [searchText, setSearchText] = useState(search);
  const pager = useCursorPager();
  const { page, reset } = pager;
  const [openId, setOpenId] = useRoutedId(initialOpenId ?? null, onOpenChange);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    if (searchText.trim() === search) return;
    const t = setTimeout(() => { setParams({ q: searchText.trim() }); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const setFilter = (patch: Partial<Record<FilterKey, string>>) => { setParams(patch); reset(); };
  const filters = { status, jobId, search, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: [...applicationKeys.all, "list", filters], queryFn: () => applicationsApi.list(filters), placeholderData: keepPreviousData });
  const jobs = useQuery({
    queryKey: [...jobKeys.all, "list", { kind: "internal_opening", picker: true }],
    queryFn: () => jobsApi.list({ kind: "internal_opening", limit: 200 }), enabled: can(me, "job:read"), retry: false,
  });
  const jobItems = jobs.data?.items ?? [];
  const items = q.data?.items ?? [];
  const canExport = can(me, "application:read");
  const hasFilters = Boolean(status || jobId || search);
  const n = items.length;
  const count = q.isLoading || q.error ? "" : `${n}${q.data?.nextCursor ? "+" : ""}`;
  const anyRating = items.some((a) => a.overallRating !== null);
  // A job from a link (Jobs → applicants count) that the picker does not list still shows, as a removable chip.
  const pickerJob = jobItems.find((j) => j.id === jobId);
  const linkedJob = jobId && !pickerJob ? items.find((a) => a.job.id === jobId)?.job.title ?? "selected job" : null;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Applications{count && <span className="h1count" aria-label={`, ${count} applications`}>{count}</span>}</h1>
          <p className="sub">Applications from the careers portal to our internal openings.</p>
        </div>
        {canExport && (
          <div className="pageactions">
            <button type="button" className="btn" onClick={async () => {
              try { const r = await applicationsApi.exportCsv({ status, jobId, search }); setNotice({ tone: "ok", text: `Exported ${r.rows} applications${r.truncated ? " (first 5,000 only)" : ""}.` }); }
              catch (e) { setNotice({ tone: "error", text: applicationError(e) }); }
            }}><Download size={16} aria-hidden="true" /> Export</button>
          </div>
        )}
      </div>

      <FilterBar label="Application filters" summaryEnd={<NoticeLine notice={notice} />} hasFilters={hasFilters} activeCount={[status, jobId].filter(Boolean).length} moreCount={0}
        onClear={() => { setSearchText(""); setFilter({ status: "", jobId: "", q: "" }); }}
        chips={linkedJob ? [{ key: "jobId", label: `Job: ${linkedJob}`, onRemove: () => setFilter({ jobId: "" }) }] : []}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Applicant</label>
            <input id={`${id}-q`} type="search" placeholder="Applicant name" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
        }
        primary={
          <>
            <div className="field inline fb-status">
              <label htmlFor={`${id}-status`}>Status</label>
              <select id={`${id}-status`} value={status} onChange={(e) => setFilter({ status: e.target.value })}>
                <option value="">Any status</option>
                {APPLICATION_STATUSES.map((s) => <option key={s} value={s}>{APPLICATION_STATUS_LABELS[s]}</option>)}
              </select>
            </div>
            {jobItems.length > 0 && (
              <div className="field inline fb-job">
                <label htmlFor={`${id}-job`}>Job</label>
                <select id={`${id}-job`} value={pickerJob ? jobId : ""} onChange={(e) => setFilter({ jobId: e.target.value })}>
                  <option value="">All jobs</option>
                  {jobItems.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
              </div>
            )}
          </>
        }
      />

      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={applicationError(q.error)} />
        ) : (
          <table className="dtable appstable" aria-label="Applications" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Applicant</th><th>Status</th><th>Job</th><th>Applied</th>{anyRating && <th className="num">Rating</th>}
            </tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="rowopen" aria-current={openId === a.id || undefined} onClick={(e) => { if (!fromControl(e)) setOpenId(a.id); }}>
                  <td className="c-primary">
                    <RecordLink kind="application" id={a.id} onOpen={setOpenId} label={`Open application of ${a.applicant.name ?? "applicant"}`}><b>{a.applicant.name ?? "—"}</b></RecordLink>
                    {a.applicant.email && <small className="block muted">{a.applicant.email}</small>}
                  </td>
                  <td className="c-badge"><AppStatus status={a.status} /></td>
                  <td data-label="Job"><div><span className="jobtitle">{a.job.title ?? "—"}</span><small className="block muted">{a.company?.name ?? "Internal opening"}</small></div></td>
                  <td data-label="Applied">{fmtDate(a.appliedAt)}</td>
                  {anyRating && <td className="num" data-label="Rating">{a.overallRating ?? <span className="muted">—</span>}</td>}
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={5} className="empty">{hasFilters ? "No applications match these filters."
                  : "No applications for you yet. You see applications to the jobs you manage, or that you interview for."}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{q.isLoading || q.error ? "" : `${n} ${n === 1 ? "application" : "applications"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`}</p>
        <Pager pager={pager} label="Application pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
      {openId && <ApplicationDrawer id={openId} initial={items.find((a) => a.id === openId)} me={me} siblings={items.map((a) => a.id)}
        onStep={setOpenId} onClose={() => setOpenId(null)} onNotice={(m) => setNotice({ tone: "ok", text: m })} />}
    </>
  );
}

type Action = { kind: "people"; interview: AppInterview } | { kind: "status" } | { kind: "schedule" } | { kind: "candidate" } | { kind: "scorecard"; interview: AppInterview } | { kind: "interview"; interview: AppInterview };

const historyText = (h: ApplicationDetail["history"][number]) =>
  h.kind === "status" ? `${APPLICATION_STATUS_LABELS[h.fromStatus as ApplicationStatus] ?? h.fromStatus} → ${APPLICATION_STATUS_LABELS[h.toStatus as ApplicationStatus] ?? h.toStatus}`
    : h.kind === "applied" ? "Applied" : h.kind === "withdrawn" ? "Withdrawn by the applicant" : h.kind === "interview_scheduled" ? "Interview scheduled"
    : h.kind === "interview_status" ? `Interview ${APP_INTERVIEW_LABELS[h.toStatus ?? ""]?.toLowerCase() ?? ""}` : "Candidate created";

const interviewAverage = (i: AppInterview) => i.scorecards.length
  ? (i.scorecards.reduce((s, c) => s + (c.technical + c.communication + c.problemSolving + c.attitude) / 4, 0) / i.scorecards.length).toFixed(1) : null;

function ApplicationDrawer({ id, initial, me, siblings, onStep, onClose, onNotice }: {
  id: string; initial?: Application; me: Pick<Me, "id" | "capabilities">;
  /** The ids on the current list page, for Previous / Next. */
  siblings: string[]; onStep: (id: string) => void;
  onClose: () => void; onNotice: (m: string) => void;
}) {
  const qc = useQueryClient();
  const uid = useId();
  const q = useQuery({ queryKey: applicationKeys.detail(id), queryFn: () => applicationsApi.get(id),
    placeholderData: initial ? { ...initial, interviews: [], history: [] } as ApplicationDetail : undefined });
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { setMessage(""); }, [id]);
  const a = q.data;
  const full = Boolean(a && !q.isPlaceholderData);
  const done = (m: string) => {
    setAction(null); setMessage(m); onNotice(m);
    void qc.invalidateQueries({ queryKey: applicationKeys.all });
    void qc.invalidateQueries({ queryKey: jobKeys.all });
  };
  const job = a && "category" in a.job ? (a.job as Job) : null;
  const at = siblings.indexOf(id);
  const prev = at > 0 ? siblings[at - 1] : undefined;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : undefined;
  const hasActions = Boolean(a && (a.actions.transition.length > 0 || a.actions.scheduleInterview || a.actions.createCandidate));
  return (
    <>
      <Drawer title={a ? `${a.applicant.name ?? "Applicant"} · ${a.job.title ?? "Application"}` : "Application"} onClose={onClose} suspended={action !== null} wide closeLabel="Close application details">
        {!a ? (q.isLoading ? <Loading /> : <p className="error" role="alert">{applicationError(q.error)}</p>) : (
          <>
            {siblings.length > 1 && at >= 0 && (
              <nav className="ad-stepper" aria-label="Applications on this page">
                <button type="button" className="btn sm" disabled={!prev} onClick={() => prev && onStep(prev)}><ChevronLeft size={15} aria-hidden="true" />Previous</button>
                <span className="muted">{at + 1} of {siblings.length}</span>
                <button type="button" className="btn sm" disabled={!next} onClick={() => next && onStep(next)}>Next<ChevronRight size={15} aria-hidden="true" /></button>
              </nav>
            )}
            <div className="actionstrip">
              <div className="as-status">
                <AppStatus status={a.status} />
                <span className="as-note">Applied {fmtDate(a.appliedAt)}{a.overallRating !== null ? ` · Overall rating ${a.overallRating} / 5` : ""}{a.company?.name ? ` · ${a.company.name}` : ""}</span>
              </div>
              {hasActions && (
                <div className="as-actions" role="group" aria-label="Application actions">
                  {a.actions.createCandidate && <button type="button" className="btn primary" onClick={() => setAction({ kind: "candidate" })}>Create candidate…</button>}
                  {a.actions.transition.length > 0 && <button type="button" className={a.actions.createCandidate ? "btn" : "btn primary"} onClick={() => setAction({ kind: "status" })}>Change status…</button>}
                  {a.actions.scheduleInterview && <button type="button" className="btn" onClick={() => setAction({ kind: "schedule" })}>Schedule interview…</button>}
                </div>
              )}
            </div>
            {a.status === "hired" && !a.candidateId && !a.actions.createCandidate && <p className="hint">Creating the Eureka candidate needs a Sales role that creates candidates.</p>}
            {a.candidateId && <p className="note">A Eureka candidate was created from this application.</p>}
            <p role="status" aria-live="polite" className="livemsg">{message}</p>
            <Tabs label="Application sections" panelClassName="ad-panel"
              tabs={[{ key: "overview", label: "Overview" }, { key: "job", label: "Job details" }] as const}>
              {(tab) => tab === "overview" ? (
                <>
                  <section className="manageblock" aria-labelledby={`${uid}-ap`}>
                    <h3 id={`${uid}-ap`}>Applicant</h3>
                    <dl className="facts">
                      <dt>Name</dt><dd>{a.applicant.name ?? "—"}</dd>
                      <dt>Email</dt><dd>{a.applicant.email ?? "—"}{a.applicant.emailVerified ? " (verified)" : a.applicant.email ? <> <span className="badge unverified">Unverified</span></> : null}</dd>
                      <dt>Phone</dt><dd>{a.applicant.phone ? <span className={a.applicant.phoneMasked ? "masked" : undefined}>{a.applicant.phone}</span> : "—"}</dd>
                      <dt>Applied</dt><dd>{fmtDateTime(a.appliedAt)}</dd>
                      <dt>Status since</dt><dd>{fmtDateTime(a.statusChangedAt)}</dd>
                    </dl>
                  </section>
                  <section className="manageblock" aria-labelledby={`${uid}-iv`}>
                    <h3 id={`${uid}-iv`}>Interviews{full ? ` (${a.interviews.length})` : ""}</h3>
                    {!full ? <p className="muted">Loading interviews…</p> : a.interviews.length === 0 ? (
                      <p className="muted">No interviews yet.</p>
                    ) : (
                      <div className="tablewrap listcard"><table className="mini dtable" aria-label="Interviews">
                        <thead><tr><th>Round</th><th>Status</th><th>Slot</th><th className="num">Rating</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody>
                          {a.interviews.map((i) => {
                            const avg = interviewAverage(i);
                            return (
                              <tr key={i.id}>
                                <td className="c-primary"><b>{APP_INTERVIEW_LABELS[i.round]}</b><small className="block muted">{APP_INTERVIEW_LABELS[i.interviewType]}</small></td>
                                <td className="c-badge"><InterviewStatusBadge status={i.status} /></td>
                                <td data-label="Slot"><div>{fmtDateTime(i.startsAt)}<small className="block muted">{i.durationMinutes} min · Lead {i.lead.name ?? "—"}</small></div></td>
                                <td className="num" data-label="Rating">{avg ?? <span className="muted">—</span>}</td>
                                <td className="c-act">
                                  {i.actions.scorecard && <button type="button" className="btn sm" onClick={() => setAction({ kind: "scorecard", interview: i })} aria-label={`Review ${APP_INTERVIEW_LABELS[i.round]}`}>Review</button>}
                                  <button type="button" className="btn sm" onClick={() => setAction({ kind: "interview", interview: i })} aria-label={`Interview details ${APP_INTERVIEW_LABELS[i.round]}`}>Details</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table></div>
                    )}
                  </section>
                  {full && a.history.length > 0 && (
                    <section className="manageblock" aria-labelledby={`${uid}-hi`}>
                      <h3 id={`${uid}-hi`}>History</h3>
                      <ol className="timeline">
                        {a.history.map((h) => (
                          <li key={h.id}>
                            <b>{historyText(h)}</b>
                            {h.comment && <span className="block note">{h.comment}</span>}
                            <span className="block muted">{fmtDateTime(h.at)}{h.actor ? ` · ${h.actor}` : ""}</span>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                </>
              ) : (job ? (
                <>
                  <JobFacts j={job} />
                  <section className="manageblock"><h3>Requirements</h3><RichTextView doc={job.requirements} /></section>
                  <section className="manageblock"><h3>Description</h3><RichTextView doc={job.description} /></section>
                </>
              ) : <p className="muted">{full ? "Job details are not available to you." : "Loading…"}</p>)}
            </Tabs>
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

/** No status is preselected (Enter must not send an offer), and the email to the applicant is stated before Save. */
function StatusDialog({ a, onClose, onDone }: { a: ApplicationDetail; onClose: () => void; onDone: (s: ApplicationStatus) => void }) {
  const [to, setTo] = useState<ApplicationStatus | "">("");
  const [comment, setComment] = useState("");
  const [fieldError, setFieldError] = useState("");
  const { busy, error, run } = useSubmit(applicationError);
  const formRef = useRef<HTMLFormElement>(null);
  const who = a.applicant.name ?? "The applicant";
  return (
    <Dialog title="Application status" onClose={onClose} dirty={Boolean(to || comment.trim())}>
      <form ref={formRef} noValidate onSubmit={(e) => {
        e.preventDefault();
        if (!to) { setFieldError("Choose the new status."); formRef.current?.querySelector("select")?.focus(); return; }
        void run(async () => { await applicationsApi.setStatus(a.id, a.rowVersion, to, comment.trim() || undefined); onDone(to); });
      }}>
        <p className="ad-current">Current status <AppStatus status={a.status} /></p>
        <Field label="Status" error={fieldError}>{(p) => (
          <select {...p} value={to} onChange={(e) => { setTo(e.target.value as ApplicationStatus); setFieldError(""); }} data-autofocus>
            <option value="" disabled>Choose a status…</option>
            {a.actions.transition.map((s) => <option key={s} value={s}>{APPLICATION_STATUS_LABELS[s]}</option>)}
          </select>
        )}</Field>
        <Field label="Comment (internal, optional)" hint="Staff only: never shown or emailed to the applicant.">
          {(p) => <textarea {...p} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </Field>
        <p className="hiring-mailnote"><Mail size={16} aria-hidden="true" />
          <span><b>This emails the applicant.</b> {who}{a.applicant.email ? ` (${a.applicant.email})` : ""} is told the new status{to ? `, ${APPLICATION_STATUS_LABELS[to]}` : ""}, when you save.</span>
        </p>
        <DialogActions onCancel={onClose} submitLabel="Save status" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Tomorrow at 10:00 local time: a slot that rarely needs editing to the minute. */
const tomorrowTen = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; };

function ScheduleDialog({ a, me, onClose, onDone }: { a: ApplicationDetail; me: Pick<Me, "id">; onClose: () => void; onDone: () => void }) {
  const opts = useQuery({ queryKey: jobKeys.options, queryFn: jobsApi.options, retry: false, staleTime: 5 * 60_000 });
  const staff = opts.data?.staff ?? [{ id: me.id, name: "Me" }];
  const [initial] = useState(() => ({ interviewType: "video", round: "screening", leadUserId: me.id, panel: [] as string[], startsAt: localInput(tomorrowTen()), duration: "30", link: "" }));
  const [v, setV] = useState(initial);
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
    <Dialog title="Schedule interview" onClose={onClose} wide dirty={JSON.stringify(v) !== JSON.stringify(initial)}>
      <form onSubmit={submit} noValidate>
        <fieldset className="radios"><legend>Interview type</legend>
          {APP_INTERVIEW_TYPES.map((t) => <label key={t}><input type="radio" name="itype" checked={v.interviewType === t} onChange={() => setV({ ...v, interviewType: t })} />{APP_INTERVIEW_LABELS[t]}</label>)}
        </fieldset>
        <div className="grid2">
          <Field label="Round of interview">{(p) => <select {...p} value={v.round} onChange={(e) => setV({ ...v, round: e.target.value })}>{APP_INTERVIEW_ROUNDS.map((r) => <option key={r} value={r}>{APP_INTERVIEW_LABELS[r]}</option>)}</select>}</Field>
          <Field label="Lead user">{(p) => <select {...p} value={v.leadUserId} onChange={(e) => setV({ ...v, leadUserId: e.target.value })}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <Field label="Interview slot" error={errors.startsAt} hint="Your local time.">{(p) => <input {...p} type="datetime-local" value={v.startsAt} onChange={(e) => setV({ ...v, startsAt: e.target.value })} />}</Field>
          <Field label="Duration (minutes)">{(p) => <select {...p} value={v.duration} onChange={(e) => setV({ ...v, duration: e.target.value })}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m}</option>)}</select>}</Field>
        </div>
        <PeoplePicker legend="Panel (optional)" hint="Panel members can review the interview. Up to 10."
          people={staff.filter((s) => s.id !== v.leadUserId)} value={v.panel.filter((x) => x !== v.leadUserId)} onChange={(panel) => setV({ ...v, panel })} />
        <Field label="Meeting link (optional)" error={errors.link}>{(p) => <input {...p} type="url" placeholder="https://" maxLength={2000} value={v.link} onChange={(e) => setV({ ...v, link: e.target.value })} />}</Field>
        <p className="hiring-mailnote"><Mail size={16} aria-hidden="true" /><span><b>This emails the applicant</b> the interview time and meeting link.</span></p>
        <DialogActions onCancel={onClose} submitLabel="Schedule interview" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function CandidateDialog({ a, onClose, onDone }: { a: ApplicationDetail; onClose: () => void; onDone: () => void }) {
  const lookups = useLookups();
  const [tech, setTech] = useState("");
  const [loc, setLoc] = useState("");
  // Email and phone are required and unique (CA-6); asked for when the applicant has none or the phone is masked.
  const needPhone = !a.applicant.phone || a.applicant.phoneMasked;
  const needEmail = !a.applicant.email;
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const { busy, error, run, setError } = useSubmit(applicationError);
  return (
    <Dialog title={`Create candidate · ${a.applicant.name ?? ""}`} onClose={onClose} dirty={Boolean(tech || loc || phone || email)}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        if (!tech || !loc) { setError("Choose the technology and the location."); return; }
        const p = needPhone ? normalizePhoneE164(phone) : null;
        if (needPhone && !p) { setError(PHONE_PROBLEM_MESSAGES[phoneProblem(phone) ?? "invalid"]); return; }
        if (needEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
        void run(async () => {
          await applicationsApi.createCandidate(a.id, { technologyId: tech, locationId: loc, ...(p ? { phone: p } : {}), ...(needEmail ? { email: email.trim() } : {}) });
          onDone();
        });
      }}>
        <p className="dialogbody">Creates a Eureka candidate with the applicant's name, email and phone, in your team.</p>
        <Field label="Technology">{(p) => <select {...p} value={tech} onChange={(e) => setTech(e.target.value)} data-autofocus><option value="" disabled>Choose…</option>{(lookups.data?.technologies ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Location">{(p) => <select {...p} value={loc} onChange={(e) => setLoc(e.target.value)}><option value="" disabled>Choose…</option>{(lookups.data?.locations ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        {needPhone && <Field label="Phone" hint="With the country code, e.g. +1 469 555 0142">{(p) => <input {...p} type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>}
        {needEmail && <Field label="Personal email">{(p) => <input {...p} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>}
        <DialogActions onCancel={onClose} submitLabel="Create candidate" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

const SCORE_LABELS = [["technical", "Technical skills"], ["communication", "Communication"], ["problemSolving", "Problem solving"], ["attitude", "Attitude"]] as const;
type ScoreKey = (typeof SCORE_LABELS)[number][0];

/** A new review starts unrated: each area must be picked, so an untouched form cannot save a fake 3/3/3/3. */
function ScorecardDialog({ i, meId, onClose, onDone }: { i: AppInterview; meId: string; onClose: () => void; onDone: () => void }) {
  const mine = i.scorecards.find((s) => s.reviewer.id === meId);
  const [initial] = useState<Record<ScoreKey, number | null>>(() => ({
    technical: mine?.technical ?? null, communication: mine?.communication ?? null, problemSolving: mine?.problemSolving ?? null, attitude: mine?.attitude ?? null,
  }));
  const [v, setV] = useState(initial);
  const [notes, setNotes] = useState(mine?.notes ?? "");
  const [missing, setMissing] = useState<ScoreKey[]>([]);
  const { busy, error, run, setError } = useSubmit(applicationError);
  const formRef = useRef<HTMLFormElement>(null);
  const uid = useId();
  const dirty = JSON.stringify(v) !== JSON.stringify(initial) || notes !== (mine?.notes ?? "");
  return (
    <Dialog title={`Review · ${APP_INTERVIEW_LABELS[i.round]}`} onClose={onClose} dirty={dirty}>
      <form ref={formRef} noValidate onSubmit={(e) => {
        e.preventDefault();
        const gaps = SCORE_LABELS.map(([k]) => k).filter((k) => v[k] === null);
        setMissing(gaps);
        if (gaps.length) {
          setError(`Rate all four areas (${gaps.length} left).`);
          formRef.current?.querySelector<HTMLInputElement>(`input[name="${gaps[0]}"]`)?.focus();
          return;
        }
        const scores = { technical: v.technical!, communication: v.communication!, problemSolving: v.problemSolving!, attitude: v.attitude! };
        void run(async () => { await applicationsApi.scorecard(i.id, { ...scores, ...(notes.trim() ? { notes: notes.trim() } : {}) }); onDone(); });
      }}>
        <p id={`${uid}-scale`} className="hint">1 = poor · 3 = meets the bar · 5 = excellent</p>
        {SCORE_LABELS.map(([k, label]) => (
          <fieldset key={k} className={`radios scorerow${missing.includes(k) && v[k] === null ? " invalid" : ""}`} aria-describedby={`${uid}-scale`}>
            <legend>{label}</legend>
            {[1, 2, 3, 4, 5].map((n) => <label key={n}><input type="radio" name={k} checked={v[k] === n} onChange={() => setV({ ...v, [k]: n })} />{n}</label>)}
            {missing.includes(k) && v[k] === null && <small className="error fielderr">Choose a score.</small>}
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
  const people = [...i.panel, ...staff.filter((s) => !i.panel.some((x) => x.id === s.id))].filter((p) => p.id !== lead);
  const dirty = lead !== i.lead.id || panel.join() !== i.panel.map((p) => p.id).join();
  return (
    <Dialog title="Lead and panel" onClose={onClose} dirty={dirty}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await applicationsApi.setPeople(i.id, { leadUserId: lead, panelUserIds: panel.filter((x) => x !== lead) }); onDone(); }); }}>
        <p className="dialogbody">People removed here lose access to this application at once.</p>
        <Field label="Lead user">{(p) => <select {...p} value={lead} onChange={(e) => setLead(e.target.value)} data-autofocus>
          {[{ id: i.lead.id, name: i.lead.name ?? "Current lead" }, ...staff.filter((s) => s.id !== i.lead.id)].map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
        <PeoplePicker legend="Panel" hint="Up to 10 people." people={people} value={panel.filter((x) => x !== lead)} onChange={setPanel} />
        <DialogActions onCancel={onClose} submitLabel="Save" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

type InterviewOutcome = "completed" | "no_show" | "cancelled";

function InterviewDialog({ i, onClose, onDone, onPeople }: { i: AppInterview; onClose: () => void; onDone: (m: string) => void; onPeople: () => void }) {
  const { busy, error, run } = useSubmit(applicationError);
  // No show and Cancelled affect the applicant: they are confirmed first. Completed runs at once.
  const [confirming, setConfirming] = useState<Exclude<InterviewOutcome, "completed"> | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  const mark = (s: InterviewOutcome) => void run(async () => {
    await applicationsApi.interviewStatus(i.id, s);
    onDone(`Interview marked ${(APP_INTERVIEW_LABELS[s] ?? s).toLowerCase()}.`);
  });
  const label = (s: InterviewOutcome) => `Mark ${(APP_INTERVIEW_LABELS[s] ?? s).toLowerCase()}`;
  return (
    <Dialog title={`Interview · ${APP_INTERVIEW_LABELS[i.round]}`} onClose={onClose} wide>
      <dl className="facts">
        <dt>Type</dt><dd>{APP_INTERVIEW_LABELS[i.interviewType]}</dd>
        <dt>Slot</dt><dd>{fmtDateTime(i.startsAt)} · {i.durationMinutes} min</dd>
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
      {confirming && (
        <div className="hiring-confirm" role="group" aria-label="Confirm interview status">
          <p>{confirming === "cancelled" ? "Cancel this interview? The applicant sees it as cancelled." : "Mark the applicant as a no show for this interview?"}</p>
          <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep as is</button>
          <button ref={confirmRef} type="button" className="btn danger" disabled={busy} onClick={() => mark(confirming)}>{label(confirming)}</button>
        </div>
      )}
      <div className="actions">
        {i.actions.setStatus && <button type="button" className="btn" disabled={busy} onClick={() => mark("completed")}>{label("completed")}</button>}
        {i.actions.setStatus && (["no_show", "cancelled"] as const).map((s) => (
          <button key={s} type="button" className="btn" disabled={busy} aria-expanded={confirming === s} onClick={() => setConfirming(s)}>{label(s)}…</button>
        ))}
        {i.actions.setStatus && <button type="button" className="btn" disabled={busy} onClick={onPeople}>Change lead or panel…</button>}
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>Close</button>
      </div>
    </Dialog>
  );
}
