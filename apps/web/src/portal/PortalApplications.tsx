import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, isSafeHttpsUrl, jobLabel, type ApplicationStatus } from "@eureka/shared";
import { ConfirmDialog } from "../ui/Dialog";
import { Drawer, fmtDate } from "../sales/ui";
import { portal, portalError, type PortalApplication } from "./portalApi";
import "../jobs/jobs.css";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import { fmtDateTime } from "../lib/format";

const Status = ({ s }: { s: string }) => <span className={`badge app-${s}`}>{APPLICATION_STATUS_LABELS[s as ApplicationStatus] ?? s}</span>;

/** My Applications: status first; on phones each application is a card. The detail shows interviews only (no internal data). */
export function PortalApplications() {
  const id = useId();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState<PortalApplication | null>(null);
  const [msg, setMsg] = useState("");
  const q = useQuery({ queryKey: ["portal", "applications", filter], queryFn: () => portal.applications(filter || undefined) });
  const items = q.data?.items ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: ["portal"] });
  const open = items.find((a) => a.id === openId);
  return (
    <>
      <div className="portalhead">
        <h1 tabIndex={-1}>My applications{q.data && <span className="h1count" aria-label={`, ${items.length} applications`}>{items.length}</span>}</h1>
        <p className="sub">Follow the jobs you applied for. We also email you when a status changes.</p>
      </div>
      <div className="filterbar">
        <form className="fb-row pa-filter" role="search" aria-label="Application filters" onSubmit={(e) => e.preventDefault()}>
          <div className="field inline">
            <label htmlFor={`${id}-status`}>Status</label>
            <select id={`${id}-status`} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(APPLICATION_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </form>
      </div>
      <p role="status" aria-live="polite" className="livemsg">{msg}</p>
      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? <QueryError query={q} message={portalError(q.error)} /> : (
          <table className="dtable portalapps" aria-label="Applications">
            <thead><tr><th>Job</th><th>Status</th><th>Company</th><th>Applied</th><th>Last update</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="c-primary"><b>{a.job.title}</b><small className="block muted">{[jobLabel(a.job.workMode), jobLabel(a.job.employmentType), a.job.location].filter(Boolean).join(" · ")}</small></td>
                  <td className="c-badge"><Status s={a.status} /></td>
                  <td data-label="Company">{a.job.employer ?? "Eureka"}</td>
                  <td data-label="Applied">{fmtDate(a.appliedAt)}</td>
                  <td data-label="Last update">{fmtDate(a.statusChangedAt)}</td>
                  <td className="c-act">
                    {a.canWithdraw && <button type="button" className="btn sm" onClick={() => setWithdraw(a)} aria-label={`Withdraw application for ${a.job.title}`}>Withdraw…</button>}
                    <button type="button" className="btn sm" onClick={() => setOpenId(a.id)} aria-label={`View application for ${a.job.title}`}>View</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="empty">{filter ? "No applications with this status." : "You have not applied for any job yet. Find one under Jobs."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {openId && <AppDrawer id={openId} suspended={withdraw !== null} onClose={() => setOpenId(null)} onWithdraw={open?.canWithdraw ? () => setWithdraw(open) : undefined} />}
      {withdraw && (
        <ConfirmDialog title="Withdraw application" confirmLabel="Withdraw" danger formatError={portalError}
          action={() => portal.withdraw(withdraw.id)} onClose={() => setWithdraw(null)}
          onDone={() => { setWithdraw(null); setOpenId(null); setMsg("Application withdrawn."); refresh(); }}>
          <p>Withdraw your application for <b>{withdraw.job.title}</b>?</p>
          <p>Scheduled interviews are cancelled and this cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function AppDrawer({ id, suspended, onClose, onWithdraw }: { id: string; suspended: boolean; onClose: () => void; onWithdraw?: () => void }) {
  const q = useQuery({ queryKey: ["portal", "application", id], queryFn: () => portal.application(id) });
  const a = q.data;
  const interviews = a?.interviews ?? [];
  return (
    <Drawer title={a?.job.title ?? "Application"} onClose={onClose} wide suspended={suspended} closeLabel="Close application details">
      {!a ? (q.isLoading ? <Loading /> : <p className="error" role="alert">{portalError(q.error)}</p>) : (
        <>
          <div className="actionstrip">
            <div className="as-status"><Status s={a.status} /><span className="as-note">Applied {fmtDate(a.appliedAt)} · updated {fmtDate(a.statusChangedAt)}</span></div>
            {onWithdraw && a.canWithdraw && <div className="as-actions"><button type="button" className="btn danger" onClick={onWithdraw}>Withdraw application…</button></div>}
          </div>
          <p className="muted">{[a.job.employer ?? "Eureka", a.job.location, jobLabel(a.job.workMode), jobLabel(a.job.employmentType)].filter(Boolean).join(" · ")}</p>
          <h3>Interviews</h3>
          {interviews.length === 0 ? <p className="muted">No interviews scheduled yet. We email you when one is.</p> : (
            <div className="tablewrap listcard"><table className="mini dtable" aria-label="Interviews">
              <thead><tr><th>Round</th><th>Status</th><th>Interview slot</th><th>Interview type</th><th className="c-act"><span className="sr-only">Join</span></th></tr></thead>
              <tbody>
                {interviews.map((i) => (
                  <tr key={i.id}>
                    <td className="c-primary"><b>{APP_INTERVIEW_LABELS[i.round] ?? i.round}</b></td>
                    <td className="c-badge"><span className={`badge ai-${i.status}`}>{APP_INTERVIEW_LABELS[i.status] ?? i.status}</span></td>
                    <td data-label="Slot"><div>{fmtDateTime(i.startsAt)}<small className="block muted">{i.durationMinutes} min</small></div></td>
                    <td data-label="Type">{APP_INTERVIEW_LABELS[i.interviewType] ?? i.interviewType}</td>
                    <td className="c-act">{i.meetingLink && isSafeHttpsUrl(i.meetingLink)
                      ? <a className="btn sm" href={i.meetingLink} target="_blank" rel="noopener noreferrer">Join link</a> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </Drawer>
  );
}
