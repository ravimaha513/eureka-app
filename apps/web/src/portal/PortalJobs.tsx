import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jobLabel } from "@eureka/shared";
import { Drawer } from "../sales/ui";
import { RichTextView } from "../jobs/RichText";
import { portal, portalError, type PortalJob } from "./portalApi";
import "../jobs/jobs.css";

/** "4 days ago" from a posting time. */
export function postedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Posted today";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function ApplyButton({ job, onDone, onError }: { job: Pick<PortalJob, "id" | "applied">; onDone: () => void; onError: (m: string) => void }) {
  const m = useMutation({ mutationFn: () => portal.apply(job.id), onSuccess: onDone, onError: (e) => onError(portalError(e)) });
  return job.applied
    ? <button type="button" className="btn" disabled>Applied</button>
    : <button type="button" className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Applying…" : "Apply now"}</button>;
}

/** Finding Job: published open jobs as cards (only what the server shows the applicant). */
export function PortalJobs(_: { onApplied: () => void; go: (p: string) => void }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["portal", "jobs"], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => portal.jobs(pageParam), getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const applied = () => { setMsg("Application sent. Follow it under My applications."); void qc.invalidateQueries({ queryKey: ["portal"] }); };
  return (
    <>
      <div><h1 tabIndex={-1}>Finding Job</h1><p className="sub">Open positions at our companies.</p></div>
      <p role="status" aria-live="polite" className="livemsg">{msg}</p>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="error" role="alert">{portalError(q.error)}</p> : items.length === 0 ? (
        <p className="empty">No open positions right now. Check back soon.</p>
      ) : (
        <div className="jobcards">
          {items.map((j) => (
            <article key={j.id} className="jobcard" aria-label={j.title}>
              <h2>{j.title}</h2>
              <div className="meta">{[j.employer, j.location].filter(Boolean).join(" · ") || "Eureka"}</div>
              <div className="pills">
                <span className="badge pill">{jobLabel(j.workMode)}</span>
                <span className="badge pill">{jobLabel(j.employmentType)}</span>
                <span className="badge job-open">{jobLabel(j.status)}</span>
              </div>
              <p className="excerpt">{j.excerpt}</p>
              <div className="posted">{postedAgo(j.postedAt)}</div>
              <div className="cardactions">
                <button type="button" className="btn" onClick={() => setOpenId(j.id)} aria-label={`View details of ${j.title}`}>View details</button>
                <ApplyButton job={j} onDone={applied} onError={setMsg} />
              </div>
            </article>
          ))}
        </div>
      )}
      {q.hasNextPage && <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more</button>}
      {openId && <PortalJobDrawer id={openId} onClose={() => setOpenId(null)} onApplied={applied} onError={setMsg} />}
    </>
  );
}

function PortalJobDrawer({ id, onClose, onApplied, onError }: { id: string; onClose: () => void; onApplied: () => void; onError: (m: string) => void }) {
  const q = useQuery({ queryKey: ["portal", "job", id], queryFn: () => portal.job(id) });
  const j = q.data;
  return (
    <Drawer title={j?.title ?? "Job"} onClose={onClose} wide closeLabel="Close job details">
      {!j ? (q.isLoading ? <p className="empty">Loading…</p> : <p className="error" role="alert">{portalError(q.error)}</p>) : (
        <>
          <p className="muted">{[j.location, jobLabel(j.workMode), jobLabel(j.employmentType), jobLabel(j.experienceLevel)].filter(Boolean).join(" · ")}</p>
          {j.skills.length > 0 && <p>{j.skills.map((s) => <span key={s} className="badge pill">{s}</span>)}</p>}
          <section className="manageblock"><h3>Description</h3><RichTextView doc={j.description} /></section>
          <section className="manageblock"><h3>Requirements</h3><RichTextView doc={j.requirements} /></section>
          <ApplyButton job={j} onDone={() => { onApplied(); onClose(); }} onError={(m) => { onError(m); onClose(); }} />
        </>
      )}
    </Drawer>
  );
}
