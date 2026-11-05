import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { jobLabel } from "@eureka/shared";
import { Drawer } from "../sales/ui";
import { ConfirmDialog } from "../ui/Dialog";
import { RichTextView } from "../jobs/RichText";
import { portal, portalError, type Applicant, type PortalJob } from "./portalApi";
import "../jobs/jobs.css";
import { Loading } from "../ui/Loading";

/** "4 days ago" from a posting time. */
export function postedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Posted today";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

type JobRef = Pick<PortalJob, "id" | "title" | "employer" | "location" | "applied">;

const employerLine = (j: Pick<PortalJob, "employer" | "location">) => [j.employer ?? "Eureka", j.location].filter(Boolean).join(" · ");

/**
 * Apply is a two-step action: the review step names the job and what is shared, because an
 * application cannot be taken back (only withdrawn) and the button sits under a thumb on phones.
 */
function ApplyConfirm({ job, me, onClose, onDone }: { job: JobRef; me: Applicant; onClose: () => void; onDone: () => void }) {
  return (
    <ConfirmDialog title={`Apply for ${job.title}`} confirmLabel="Send application" formatError={portalError}
      action={() => portal.apply(job.id)} onClose={onClose} onDone={onDone}>
      <p className="pj-confirmjob"><b>{job.title}</b><span className="muted">{employerLine(job)}</span></p>
      <p>The hiring team will see your name, email ({me.email}) and phone number from your account.</p>
      <p className="muted">You can follow this application, or withdraw it, under My applications.</p>
    </ConfirmDialog>
  );
}

/** Open positions: published open jobs as cards (only what the server shows the applicant). */
export function PortalJobs({ me, go }: { me: Applicant; go: (p: string) => void }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [applying, setApplying] = useState<JobRef | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["portal", "jobs"], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => portal.jobs(pageParam), getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const applied = (id: string) => { setApplying(null); setSentId(id); void qc.invalidateQueries({ queryKey: ["portal"] }); };
  const toApplications = () => go("/portal/applications");
  return (
    <>
      <div className="portalhead">
        <h1 tabIndex={-1}>Open positions{items.length > 0 && <span className="h1count" aria-label={`, ${items.length}${q.hasNextPage ? " or more" : ""} positions`}>{items.length}{q.hasNextPage ? "+" : ""}</span>}</h1>
        <p className="sub">Openings at our companies. Read the details, then apply in two steps.</p>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <p className="error" role="alert">{portalError(q.error)}</p> : items.length === 0 ? (
        <p className="empty pj-empty">No open positions right now. Check back soon.</p>
      ) : (
        <div className="jobcards">
          {items.map((j) => (
            <article key={j.id} className="jobcard" aria-label={j.title}>
              <div className="jc-head">
                <h2><button type="button" className="linkbtn jc-title" onClick={() => setOpenId(j.id)}>{j.title}</button></h2>
                <div className="meta">{employerLine(j)}</div>
              </div>
              <div className="pills">
                <span className="badge pill">{jobLabel(j.workMode)}</span>
                <span className="badge pill">{jobLabel(j.employmentType)}</span>
                <span className="badge pill">{jobLabel(j.experienceLevel)}</span>
              </div>
              <p className="excerpt">{j.excerpt}</p>
              <div className="posted">{postedAgo(j.postedAt)}</div>
              {sentId === j.id && (
                <p className="okbox jc-sent" role="status"><CheckCircle2 size={16} aria-hidden="true" />
                  <span>Application sent. <button type="button" className="linkbtn" onClick={toApplications}>Follow it under My applications</button></span>
                </p>
              )}
              <div className="cardactions">
                <button type="button" className="btn" onClick={() => setOpenId(j.id)} aria-label={`View details of ${j.title}`}>View details</button>
                {j.applied
                  ? <button type="button" className="btn" disabled>Applied</button>
                  : <button type="button" className="btn primary" onClick={() => setApplying(j)}>Apply now</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {q.hasNextPage && <button type="button" className="btn pj-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Show more positions"}</button>}
      {openId && (
        <PortalJobDrawer id={openId} sent={sentId === openId} suspended={applying !== null} onClose={() => setOpenId(null)}
          onApply={setApplying} onApplications={toApplications} />
      )}
      {applying && <ApplyConfirm job={applying} me={me} onClose={() => setApplying(null)} onDone={() => applied(applying.id)} />}
    </>
  );
}

function PortalJobDrawer({ id, sent, suspended, onClose, onApply, onApplications }: {
  id: string; sent: boolean; suspended: boolean; onClose: () => void; onApply: (j: JobRef) => void; onApplications: () => void;
}) {
  const q = useQuery({ queryKey: ["portal", "job", id], queryFn: () => portal.job(id) });
  const j = q.data;
  return (
    <Drawer title={j?.title ?? "Job"} onClose={onClose} wide suspended={suspended} closeLabel="Close job details">
      {!j ? (q.isLoading ? <Loading /> : <p className="error" role="alert">{portalError(q.error)}</p>) : (
        <div className="pj-detail">
          <p className="pj-employer">{employerLine(j)}</p>
          <dl className="facts">
            <dt>Work mode</dt><dd>{jobLabel(j.workMode)}</dd>
            <dt>Employment</dt><dd>{jobLabel(j.employmentType)}</dd>
            <dt>Experience</dt><dd>{jobLabel(j.experienceLevel)}</dd>
            {j.workHours ? <><dt>Hours</dt><dd>{j.workHours} per week</dd></> : null}
            {j.postedAt ? <><dt>Posted</dt><dd>{postedAgo(j.postedAt)}</dd></> : null}
          </dl>
          {j.skills.length > 0 && <p className="pills" aria-label="Skills">{j.skills.map((s) => <span key={s} className="badge pill">{s}</span>)}</p>}
          <section className="manageblock"><h3>Description</h3><RichTextView doc={j.description} /></section>
          <section className="manageblock"><h3>Requirements</h3><RichTextView doc={j.requirements} /></section>
          <div className="pj-applybar">
            {sent || j.applied ? (
              <p className="okbox"><CheckCircle2 size={16} aria-hidden="true" />
                <span>{sent ? "Application sent." : "You applied for this job."} <button type="button" className="linkbtn" onClick={onApplications}>See My applications</button></span>
              </p>
            ) : <button type="button" className="btn primary" onClick={() => onApply(j)}>Apply for this job</button>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
