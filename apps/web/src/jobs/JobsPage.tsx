import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { JOB_KINDS, JOB_STATUSES, jobLabel } from "@eureka/shared";
import { can, type Me } from "../api";
import { Drawer, fmtDate } from "../sales/ui";
import { Person } from "../shell/ui";
import { useRoutedId, useSearchParams } from "../lib/router";
import { FilterBar } from "../ui/FilterBar";
import { RecordLink } from "../ui/RecordLink";
import { JobDialog } from "./JobDialog";
import { RichTextView } from "./RichText";
import { jobError, jobKeys, jobsApi, type Job } from "./jobsApi";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { ScreenLink, fromControl } from "./hiringUi";
import "./jobs.css";
import { Loading } from "../ui/Loading";

const PAGE_SIZE = 50;

export const JobStatus = ({ status }: { status: string }) => <span className={`badge job-${status}`}>{jobLabel(status)}</span>;
/** Shown wherever a job is live for applicants (published internal opening). */
export const PortalBadge = () => <span className="badge kind">On careers portal</span>;

export function payText(j: Pick<Job, "pay" | "payHidden">): string {
  if (j.pay) {
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: j.pay.currency, maximumFractionDigits: 2 }).format(j.pay.amount);
    return `${amount} ${jobLabel(j.pay.frequency).toLowerCase()}`;
  }
  return j.payHidden ? "Hidden (rate)" : "—";
}

export const employerName = (j: Pick<Job, "kind" | "client" | "company">) =>
  j.kind === "client_requirement" ? j.client?.name ?? "Client" : j.company?.name ?? "Internal opening";

/** Applications to an internal opening open in Applications filtered to the job; client requirements count submissions. */
const applicationsHref = (jobId: string) => `/applications?jobId=${encodeURIComponent(jobId)}`;

/** Jobs (docs/jobs-portal-api.md): client requirements and internal openings with filters, create and edit. */
export function JobsPage({ me, initialOpenId, onOpenChange }: {
  me: Pick<Me, "capabilities" | "id">; initialOpenId?: string | null;
  /** The open job changed (the shell keeps it in the URL as /jobs/<id>). */
  onOpenChange?: (id: string | null) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  // Filters live in the address bar (?kind=&status=&q=): refresh, back from a record and shared links keep them.
  const [params, setParams] = useSearchParams(["kind", "status", "q"] as const);
  const kind = (JOB_KINDS as readonly string[]).includes(params.kind) ? params.kind : "";
  const status = (JOB_STATUSES as readonly string[]).includes(params.status) ? params.status : "";
  const search = params.q;
  const [searchText, setSearchText] = useState(search);
  const pager = useCursorPager();
  const { page, reset } = pager;
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [openId, setOpenId] = useRoutedId(initialOpenId ?? null, onOpenChange);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (searchText.trim() === search) return;
    const t = setTimeout(() => { setParams({ q: searchText.trim() }); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const setFilter = (patch: Partial<Record<"kind" | "status" | "q", string>>) => { setParams(patch); reset(); };

  const filters = { kind, status, search, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: [...jobKeys.all, "list", filters], queryFn: () => jobsApi.list(filters), placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  const canCreate = can(me, "job:manage");
  const hasFilters = Boolean(kind || status || search);
  const n = items.length;
  const count = q.isLoading || q.error ? "" : `${n}${q.data?.nextCursor ? "+" : ""}`;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Jobs{count && <span className="h1count" aria-label={`, ${count} jobs`}>{count}</span>}</h1>
          <p className="sub">Client requirements your teams submit candidates to, and openings at our own companies.</p>
        </div>
        {canCreate && <div className="pageactions"><button type="button" className="btn primary" onClick={() => setEditing("new")}><Plus size={16} aria-hidden="true" /> Add job</button></div>}
      </div>

      <FilterBar label="Job filters" hasFilters={hasFilters} activeCount={[kind, status].filter(Boolean).length}
        onClear={() => { setSearchText(""); setFilter({ kind: "", status: "", q: "" }); }}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Job title</label>
            <input id={`${id}-q`} type="search" placeholder="Search job title" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
        }
        primary={
          <>
            <div className="field inline">
              <label htmlFor={`${id}-kind`}>Type</label>
              <select id={`${id}-kind`} value={kind} onChange={(e) => setFilter({ kind: e.target.value })}>
                <option value="">Any type</option>
                {JOB_KINDS.map((k) => <option key={k} value={k}>{jobLabel(k)}</option>)}
              </select>
            </div>
            <div className="field inline fb-status">
              <label htmlFor={`${id}-status`}>Status</label>
              <select id={`${id}-status`} value={status} onChange={(e) => setFilter({ status: e.target.value })}>
                <option value="">Any status</option>
                {JOB_STATUSES.map((s) => <option key={s} value={s}>{jobLabel(s)}</option>)}
              </select>
            </div>
          </>
        }
        summaryEnd={<p role="status" aria-live="polite" className="livemsg hiring-inline">{notice}</p>}
      />

      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={jobError(q.error)} />
        ) : (
          <table className="dtable jobstable" aria-label="Jobs" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Job title</th><th>Status</th><th>Client / company</th><th className="p2">Hiring manager</th><th>Deadline</th>
              <th className="num">Applicants</th><th className="c-act"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id} className="rowopen" aria-current={openId === j.id || undefined} onClick={(e) => { if (!fromControl(e)) setOpenId(j.id); }}>
                  <td className="c-primary">
                    <RecordLink kind="job" id={j.id} onOpen={setOpenId} label={`View job ${j.title}`}><b>{j.title}</b></RecordLink>
                    <small className="block muted">{jobLabel(j.kind)}</small>
                  </td>
                  <td className="c-badge"><span className="badges"><JobStatus status={j.status} />{j.publishedToPortal && <PortalBadge />}</span></td>
                  <td data-label={j.kind === "client_requirement" ? "Client" : "Company"}>{employerName(j)}</td>
                  <td className="p2" data-label="Hiring manager">{j.hiringManager ? <Person name={j.hiringManager.name}>{j.hiringManager.name}</Person> : <span className="muted">—</span>}</td>
                  <td data-label="Deadline">{j.deadline ? fmtDate(j.deadline) : <span className="muted">—</span>}</td>
                  <td className="num" data-label={j.kind === "client_requirement" ? "Submissions" : "Applicants"}>
                    {j.kind === "internal_opening" && j.applicants > 0
                      ? <ScreenLink href={applicationsHref(j.id)} label={`${j.applicants} ${j.applicants === 1 ? "application" : "applications"} for ${j.title}`}>{j.applicants}</ScreenLink>
                      : j.applicants}
                  </td>
                  <td className="c-act">
                    {j.actions.edit && <button type="button" className="btn sm" onClick={() => setEditing(j)} aria-label={`Edit job ${j.title}`}>Edit</button>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="empty">{hasFilters ? "No jobs match these filters." : "No jobs yet."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{q.isLoading || q.error ? "" : `${n} ${n === 1 ? "job" : "jobs"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`}</p>
        <Pager pager={pager} label="Job pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>

      {openId && <JobDrawer id={openId} initial={items.find((j) => j.id === openId)} suspended={editing !== null} onClose={() => setOpenId(null)} onEdit={(j) => setEditing(j)} />}
      {editing && (
        <JobDialog job={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={(_id, created) => {
          setEditing(null);
          setNotice(created ? "Job created." : "Job saved.");
          void qc.invalidateQueries({ queryKey: jobKeys.all });
        }} />
      )}
    </>
  );
}

export function JobFacts({ j }: { j: Job }) {
  return (
    <dl className="facts">
      <dt>Type</dt><dd>{jobLabel(j.kind)}</dd>
      <dt>{j.kind === "client_requirement" ? "Client" : "Company"}</dt><dd>{employerName(j)}</dd>
      <dt>Category</dt><dd>{jobLabel(j.category)}</dd>
      <dt>Experience</dt><dd>{jobLabel(j.experienceLevel)}</dd>
      <dt>Employment</dt><dd>{jobLabel(j.employmentType)} · {jobLabel(j.workMode)}</dd>
      <dt>Location</dt><dd>{j.location ?? "—"}</dd>
      <dt>Deadline</dt><dd>{fmtDate(j.deadline)}</dd>
      <dt>Work hours</dt><dd>{j.workHours ? `${j.workHours} per week` : "—"}</dd>
      <dt>Pay</dt><dd>{payText(j)}</dd>
      <dt>Hiring manager</dt><dd>{j.hiringManager?.name ?? "—"}</dd>
      <dt>Skills</dt><dd>{j.skills.length ? j.skills.join(", ") : "—"}</dd>
    </dl>
  );
}

/** What applicants see: only open, published internal openings are on the careers portal. */
export function portalNote(j: Pick<Job, "kind" | "status" | "publishedToPortal">): string {
  if (j.kind !== "internal_opening") return "Client requirement: never shown on the careers portal.";
  if (!j.publishedToPortal) return "Not published: applicants cannot see this job.";
  return j.status === "open" ? "Applicants can see and apply on the careers portal." : "Published, but hidden from applicants until the status is Open.";
}

function JobDrawer({ id, initial, suspended, onClose, onEdit }: { id: string; initial?: Job; suspended: boolean; onClose: () => void; onEdit: (j: Job) => void }) {
  const q = useQuery({ queryKey: jobKeys.detail(id), queryFn: () => jobsApi.get(id), placeholderData: initial });
  const j = q.data;
  return (
    <Drawer title={j?.title ?? "Job"} onClose={onClose} wide suspended={suspended} closeLabel="Close job details">
      {!j ? (q.isLoading ? <Loading /> : <p className="error" role="alert">{jobError(q.error)}</p>) : (
        <>
          <div className="actionstrip">
            <div className="as-status">
              <JobStatus status={j.status} />{j.publishedToPortal && <PortalBadge />}
              <span className="as-note">{portalNote(j)}</span>
            </div>
            <div className="as-actions">
              {j.kind === "internal_opening" && j.applicants > 0 && (
                <ScreenLink className="btn" href={applicationsHref(j.id)}>{j.applicants} {j.applicants === 1 ? "application" : "applications"}</ScreenLink>
              )}
              {j.actions.edit && <button type="button" className="btn primary" onClick={() => onEdit(j)}>Edit job</button>}
            </div>
          </div>
          <JobFacts j={j} />
          <section className="manageblock"><h3>Requirements</h3><RichTextView doc={j.requirements} /></section>
          <section className="manageblock"><h3>Description</h3><RichTextView doc={j.description} /></section>
        </>
      )}
    </Drawer>
  );
}
