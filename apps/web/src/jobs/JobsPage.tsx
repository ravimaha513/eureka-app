import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { JOB_KINDS, JOB_STATUSES, jobLabel } from "@eureka/shared";
import type { Me } from "../api";
import { Drawer, fmtDate } from "../sales/ui";
import { Person } from "../shell/ui";
import { JobDialog } from "./JobDialog";
import { RichTextView } from "./RichText";
import { jobError, jobKeys, jobsApi, type Job } from "./jobsApi";
import "./jobs.css";

const PAGE_SIZE = 50;

export const JobStatus = ({ status }: { status: string }) => <span className={`badge job-${status}`}>{jobLabel(status)}</span>;

export function payText(j: Pick<Job, "pay" | "payHidden">): string {
  if (j.pay) {
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: j.pay.currency, maximumFractionDigits: 2 }).format(j.pay.amount);
    return `${amount} ${jobLabel(j.pay.frequency).toLowerCase()}`;
  }
  return j.payHidden ? "Hidden (rate)" : "—";
}

export const employerName = (j: Pick<Job, "kind" | "client" | "company">) =>
  j.kind === "client_requirement" ? j.client?.name ?? "Client" : j.company?.name ?? "Internal opening";

/** Jobs (docs/jobs-portal-api.md): client requirements and internal openings with filters, create and edit. */
export function JobsPage({ me }: { me: Pick<Me, "capabilities" | "id"> }) {
  const id = useId();
  const qc = useQueryClient();
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); reset(); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const filters = { kind, status, search, cursor: cursors[page] ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: [...jobKeys.all, "list", filters], queryFn: () => jobsApi.list(filters), placeholderData: keepPreviousData });
  const items = q.data?.items ?? [];
  const canCreate = me.capabilities.includes("job:manage");
  const hasFilters = Boolean(kind || status || search);
  const n = items.length;

  return (
    <>
      <div className="pagehead">
        <div style={{ flex: 1 }}>
          <h1 tabIndex={-1}>Jobs</h1>
          <p className="sub">Client requirements your teams submit candidates to, and openings at our own companies.</p>
        </div>
        {canCreate && <button type="button" className="btn primary" onClick={() => setEditing("new")}><Plus size={16} aria-hidden="true" /> Add job</button>}
      </div>

      <form className="filters" role="search" aria-label="Job filters" onSubmit={(e) => e.preventDefault()}>
        <div className="chipfilter">
          <span id={`${id}-k`} className="chiplabel">Type</span>
          <div className="tabs wrap" role="group" aria-labelledby={`${id}-k`}>
            <button type="button" className="tab" aria-pressed={kind === ""} onClick={() => { setKind(""); reset(); }}>All</button>
            {JOB_KINDS.map((k) => <button key={k} type="button" className="tab" aria-pressed={kind === k} onClick={() => { setKind(kind === k ? "" : k); reset(); }}>{jobLabel(k)}</button>)}
          </div>
        </div>
        <div className="chipfilter">
          <span id={`${id}-s`} className="chiplabel">Status</span>
          <div className="tabs wrap" role="group" aria-labelledby={`${id}-s`}>
            <button type="button" className="tab" aria-pressed={status === ""} onClick={() => { setStatus(""); reset(); }}>All</button>
            {JOB_STATUSES.map((s) => <button key={s} type="button" className="tab" aria-pressed={status === s} onClick={() => { setStatus(status === s ? "" : s); reset(); }}>{jobLabel(s)}</button>)}
          </div>
        </div>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Job title</label>
            <input id={`${id}-q`} type="search" value={searchText} maxLength={80} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          {hasFilters && <button type="button" className="btn" onClick={() => { setKind(""); setStatus(""); setSearchText(""); setSearch(""); reset(); }}>Clear filters</button>}
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{notice}</p>

      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{jobError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <div className="tablewrap"><table aria-label="Jobs" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>Job title</th><th>Client / company</th><th>Hiring manager</th><th>Deadline</th><th>Applicants</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id}>
                  <td><b>{j.title}</b><span className="block muted">{jobLabel(j.kind)}{j.publishedToPortal ? " · on careers portal" : ""}</span></td>
                  <td>{employerName(j)}</td>
                  <td>{j.hiringManager ? <Person name={j.hiringManager.name}>{j.hiringManager.name}</Person> : <span className="muted">—</span>}</td>
                  <td>{fmtDate(j.deadline)}</td>
                  <td>{j.applicants}</td>
                  <td><JobStatus status={j.status} /></td>
                  <td className="rowactions">
                    <button type="button" className="btn sm" onClick={() => setOpenId(j.id)} aria-label={`View job ${j.title}`}>View</button>
                    {j.actions.edit && <button type="button" className="btn sm" onClick={() => setEditing(j)} aria-label={`Edit job ${j.title}`}>Edit</button>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="empty">{hasFilters ? "No jobs match these filters." : "No jobs yet."}</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{q.isLoading || q.error ? "" : `${n} ${n === 1 ? "job" : "jobs"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`}</p>
        <nav className="pager" aria-label="Job pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>

      {openId && <JobDrawer id={openId} initial={items.find((j) => j.id === openId)} onClose={() => setOpenId(null)} onEdit={(j) => setEditing(j)} />}
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

function JobDrawer({ id, initial, onClose, onEdit }: { id: string; initial?: Job; onClose: () => void; onEdit: (j: Job) => void }) {
  const q = useQuery({ queryKey: jobKeys.detail(id), queryFn: () => jobsApi.get(id), placeholderData: initial });
  const j = q.data;
  return (
    <Drawer title={j?.title ?? "Job"} onClose={onClose} wide closeLabel="Close job details">
      {!j ? (q.isLoading ? <p className="empty">Loading…</p> : <p className="error" role="alert">{jobError(q.error)}</p>) : (
        <>
          <p><JobStatus status={j.status} />{" "}{j.publishedToPortal && <span className="badge kind">On careers portal</span>}</p>
          <JobFacts j={j} />
          <section className="manageblock"><h3>Requirements</h3><RichTextView doc={j.requirements} /></section>
          <section className="manageblock"><h3>Description</h3><RichTextView doc={j.description} /></section>
          {j.actions.edit && <div className="rowactions"><button type="button" className="btn" onClick={() => { onClose(); onEdit(j); }}>Edit job</button></div>}
        </>
      )}
    </Drawer>
  );
}
