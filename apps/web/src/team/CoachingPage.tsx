import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CoachList } from "./Coaches";
import { coachApi, coachError, coachKeys } from "./coachApi";

/**
 * Coach assignments (coach:assign; docs/admin-api.md AD-11): an Interview Lead
 * assigns the coaches who report to them to sales teams. Every team is listed
 * with the lead's coaches on it; their own assignments are set by an admin.
 */
export function CoachingPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: coachKeys.mine, queryFn: coachApi.mine });
  const [message, setMessage] = useState("");
  const changed = (msg: string) => {
    setMessage("");
    setTimeout(() => setMessage(msg), 30);
    void qc.invalidateQueries({ queryKey: coachKeys.mine });
  };

  return (
    <section className="panel">
      <div className="pagehead"><div><h1 tabIndex={-1}>Coach assignments</h1>
        <p className="sub">Choose which sales teams each of your interview coaches supports. You see what they see.</p></div></div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      {q.isLoading && <p className="empty">Loading…</p>}
      {q.error && <p className="empty error" role="alert">{coachError(q.error)}</p>}
      {q.data && q.data.coaches.length === 0 && <p className="hint">Nobody with the Interview Coach role reports to you yet. Ask an admin to set reporting lines.</p>}
      {q.data && (
        <div className="teamgrid">
          {q.data.items.map((t) => (
            <section key={t.id} className="card team" aria-labelledby={`coaching-${t.id}`}>
              <header><h2 id={`coaching-${t.id}`}>{t.name}</h2></header>
              <p><span className="muted">Lead</span> <b>{t.lead.displayName}</b></p>
              <CoachList team={t} coaches={t.coaches} available={q.data.coaches} via="lead" onChanged={changed} />
            </section>
          ))}
          {q.data.items.length === 0 && <p className="empty">No teams yet.</p>}
        </div>
      )}
    </section>
  );
}
