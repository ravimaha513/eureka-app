import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, isSafeHttpsUrl, jobLabel, type ApplicationStatus } from "@eureka/shared";
import { ConfirmDialog } from "../admin/Dialog";
import { Drawer, fmtDate } from "../sales/ui";
import { portal, portalError, type PortalApplication } from "./portalApi";
import "../jobs/jobs.css";

const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const Status = ({ s }: { s: string }) => <span className={`badge app-${s}`}>{APPLICATION_STATUS_LABELS[s as ApplicationStatus] ?? s}</span>;

/** My Applications: list with status and Withdraw; the detail shows interviews only (no internal notes or ratings). */
export function PortalApplications() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState<PortalApplication | null>(null);
  const [msg, setMsg] = useState("");
  const q = useQuery({ queryKey: ["portal", "applications", filter], queryFn: () => portal.applications(filter || undefined) });
  const items = q.data?.items ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: ["portal"] });
  return (
    <>
      <div><h1 tabIndex={-1}>My Applications</h1><p className="sub">Follow the jobs you applied for.</p></div>
      <div className="toolbar">
        <label className="field inline">Status
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(APPLICATION_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      <p role="status" aria-live="polite" className="livemsg">{msg}</p>
      <div className="card tablewrap">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{portalError(q.error)}</p> : (
          <div className="tablewrap"><table aria-label="Applications">
            <thead><tr><th>Job title</th><th>Company</th><th>Applied</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.job.title}</b><span className="block muted">{[jobLabel(a.job.workMode), jobLabel(a.job.employmentType)].join(" · ")}</span></td>
                  <td>{a.job.employer ?? "Eureka"}</td>
                  <td>{fmtDate(a.appliedAt)}</td>
                  <td><Status s={a.status} /></td>
                  <td className="rowactions">
                    <button type="button" className="btn sm" onClick={() => setOpenId(a.id)} aria-label={`View application for ${a.job.title}`}>View</button>
                    {a.canWithdraw && <button type="button" className="btn sm" onClick={() => setWithdraw(a)} aria-label={`Withdraw application for ${a.job.title}`}>Withdraw</button>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="empty">You have not applied for any job yet.</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      {openId && <AppDrawer id={openId} onClose={() => setOpenId(null)} />}
      {withdraw && (
        <ConfirmDialog title="Withdraw application" confirmLabel="Withdraw" danger formatError={portalError}
          action={() => portal.withdraw(withdraw.id)} onClose={() => setWithdraw(null)}
          onDone={() => { setWithdraw(null); setMsg("Application withdrawn."); refresh(); }}>
          <p>Withdraw your application for {withdraw.job.title}? Scheduled interviews are cancelled and this cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function AppDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["portal", "application", id], queryFn: () => portal.application(id) });
  const a = q.data;
  return (
    <Drawer title={a?.job.title ?? "Application"} onClose={onClose} wide closeLabel="Close application details">
      {!a ? (q.isLoading ? <p className="empty">Loading…</p> : <p className="error" role="alert">{portalError(q.error)}</p>) : (
        <>
          <p><Status s={a.status} /></p>
          <h3>Interviews</h3>
          {(a.interviews ?? []).length === 0 ? <p className="muted">No interviews scheduled yet.</p> : (
            <div className="tablewrap"><table className="mini" aria-label="Interviews">
              <thead><tr><th>Interview type</th><th>Round</th><th>Interview slot</th><th>Status</th></tr></thead>
              <tbody>
                {a.interviews!.map((i) => (
                  <tr key={i.id}>
                    <td>{APP_INTERVIEW_LABELS[i.interviewType] ?? i.interviewType}</td>
                    <td>{APP_INTERVIEW_LABELS[i.round] ?? i.round}</td>
                    <td>{fmtWhen(i.startsAt)}<span className="block muted">{i.durationMinutes} min</span>
                      {i.meetingLink && isSafeHttpsUrl(i.meetingLink) && <a href={i.meetingLink} target="_blank" rel="noopener noreferrer">Join link</a>}</td>
                    <td><span className={`badge ai-${i.status}`}>{APP_INTERVIEW_LABELS[i.status] ?? i.status}</span></td>
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
