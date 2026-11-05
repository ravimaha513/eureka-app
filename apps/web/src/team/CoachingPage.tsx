import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Person } from "../shell/ui";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import { CoachList } from "./Coaches";
import { coachApi, coachError, coachKeys } from "./coachApi";
import "./team.css";

/**
 * Coach assignments (coach:assign; docs/admin-api.md AD-11): an Interview Lead
 * assigns the coaches who report to them to sales teams. Every team is listed
 * with the lead's coaches on it; their own assignments are set by an admin.
 * Teams with no coach are flagged and listed first.
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
  const items = q.data?.items ?? [];
  // Uncovered teams first; otherwise keep the API's order.
  const teams = [...items].sort((a, b) => Number(a.coaches.length > 0) - Number(b.coaches.length > 0));
  const uncovered = items.filter((t) => t.coaches.length === 0).length;

  return (
    <section className="panel tm-page">
      <div className="pagehead"><div><h1 tabIndex={-1}>Coach assignments{q.data && <span className="h1count">{items.length}</span>}</h1>
        <p className="sub">Choose which sales teams each of your interview coaches supports. You see what they see.</p></div></div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      {q.isLoading && <Loading />}
      {q.error && <QueryError query={q} message={coachError(q.error)} />}
      {q.data && q.data.coaches.length === 0 && <p className="hint">Nobody with the Interview Coach role reports to you yet. Ask an admin to set reporting lines.</p>}
      {q.data && items.length > 0 && (
        <p className="tm-summary">{uncovered > 0
          ? <><span className="badge tm-warn">No coach</span> {uncovered} of {items.length} {items.length === 1 ? "team has" : "teams have"} no coach.</>
          : <>Every team has a coach.</>}</p>
      )}
      {q.data && (
        <div className="teamgrid">
          {teams.map((t) => (
            <section key={t.id} className={`card team tm-card${t.coaches.length === 0 ? " tm-uncovered" : ""}`} aria-labelledby={`coaching-${t.id}`}>
              <header className="tm-head">
                <h2 id={`coaching-${t.id}`}>{t.name}</h2>
                {t.coaches.length === 0 && <span className="badge tm-warn">No coach</span>}
              </header>
              <div className="tm-lead"><Person name={t.lead.displayName}><b>{t.lead.displayName}</b><span className="block muted">Lead</span></Person></div>
              <CoachList team={t} coaches={t.coaches} available={q.data.coaches} via="lead" onChanged={changed} />
            </section>
          ))}
          {items.length === 0 && <p className="empty">No teams yet.</p>}
        </div>
      )}
    </section>
  );
}
