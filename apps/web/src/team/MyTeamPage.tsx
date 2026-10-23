import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { teamApi, teamError, teamKeys, type Addable, type MyTeam } from "./teamApi";

/**
 * My team (team:add_member; docs/admin-api.md AD-10): the teams a lead leads
 * (for managers and associate directors, every team led in their hierarchy),
 * with their members, and adding an active recruiter who is in no team yet.
 * Moving someone out of another team is the move-member action (AD-8).
 */
export function MyTeamPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: teamKeys.mine, queryFn: teamApi.mine });
  const [adding, setAdding] = useState<MyTeam | null>(null);
  const [message, setMessage] = useState("");

  return (
    <section className="panel">
      <div className="pagehead"><div><h1 tabIndex={-1}>My team</h1>
        <p className="sub">Add recruiters who aren't in a team yet. To take someone from another team, ask your manager to move them.</p></div></div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      {q.isLoading && <p className="empty">Loading…</p>}
      {q.error && <p className="empty error" role="alert">{teamError(q.error)}</p>}
      {q.data && (
        <div className="teamgrid">
          {q.data.items.map((t) => (
            <section key={t.id} className="card team" aria-labelledby={`myteam-${t.id}`}>
              <header><h2 id={`myteam-${t.id}`}>{t.name}</h2></header>
              <p><span className="muted">Lead</span> <b>{t.lead.displayName}</b></p>
              <ul className="members" aria-label={`Members of ${t.name}`}>
                {t.members.map((m) => <li key={m.id}><span>{m.displayName}</span></li>)}
                {t.members.length === 0 && <li className="muted">No members yet.</li>}
              </ul>
              <div className="rowactions">
                <button className="btn sm" aria-label={`Add member to ${t.name}`} onClick={() => setAdding(t)}>Add member</button>
              </div>
            </section>
          ))}
          {q.data.items.length === 0 && <p className="empty">No teams to manage yet.</p>}
        </div>
      )}
      {adding && (
        <AddDialog team={adding} people={q.data?.addable ?? []} onClose={() => setAdding(null)}
          onDone={(msg) => {
            setAdding(null);
            setMessage("");
            setTimeout(() => setMessage(msg), 30);
            void qc.invalidateQueries({ queryKey: teamKeys.mine });
          }} />
      )}
    </section>
  );
}

function AddDialog({ team, people, onClose, onDone }: {
  team: MyTeam; people: Addable[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [userId, setUserId] = useState("");
  const { busy, error, run } = useSubmit(teamError);
  return (
    <Dialog title={`Add member to ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await teamApi.addMember(team.id, userId);
          const name = people.find((p) => p.id === userId)?.displayName ?? "The person";
          onDone(`${name} joined ${team.name}.`);
        });
      }}>
        <div className="field"><label htmlFor="mt-user">Recruiter</label>
          <select id="mt-user" required data-autofocus value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="" disabled>{people.length ? "Choose a recruiter…" : "No unassigned recruiters"}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
          </select></div>
        <p className="hint">Only active recruiters who aren't in any team are listed.</p>
        <DialogActions onCancel={onClose} submitLabel="Add member" busy={busy} error={error} disabled={!userId} />
      </form>
    </Dialog>
  );
}
