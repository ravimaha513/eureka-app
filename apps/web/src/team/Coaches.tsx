import { useState } from "react";
import "./team.css";
import { UserPlus } from "lucide-react";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Person } from "../shell/ui";
import { coachApi, coachError, type Coach, type CoachVia, type Ref } from "./coachApi";

/**
 * The interview coaches supporting one sales team (docs/admin-api.md AD-11),
 * with remove buttons and "Add coach". Shared by Users & Access (Teams tab,
 * any coach) and the Interview Lead's Coach assignments page (their coaches).
 * Removing asks first, like removing a team member (RemoveMemberDialog).
 */
export function CoachList({ team, coaches, available, via, onChanged }: {
  team: { id: string; name: string };
  coaches: Ref[];
  /** People who may be assigned (holders of a coach role the caller manages). */
  available: Coach[];
  via: CoachVia;
  onChanged: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Ref | null>(null);
  const assigned = new Set(coaches.map((c) => c.id));
  return (
    <div className="coaches tm-coaches">
      <h3 className="tm-label">Coaches</h3>
      <ul className="members" aria-label={`Coaches of ${team.name}`}>
        {coaches.map((c) => (
          <li key={c.id}>
            <Person name={c.displayName}>{c.displayName}</Person>
            <button className="btn sm" aria-label={`Remove coach ${c.displayName} from ${team.name}`}
              onClick={() => setRemoving(c)}>Remove</button>
          </li>
        ))}
        {coaches.length === 0 && <li className="muted">No coaches yet.</li>}
      </ul>
      <button className="btn sm tm-add" aria-label={`Add coach to ${team.name}`} onClick={() => setAdding(true)}>
        <UserPlus size={14} aria-hidden="true" />Add coach</button>
      {adding && (
        <AddCoachDialog team={team} via={via} people={available.filter((p) => !assigned.has(p.id))}
          onClose={() => setAdding(false)} onDone={(msg) => { setAdding(false); onChanged(msg); }} />
      )}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.displayName} from ${team.name}?`} confirmLabel="Remove coach" danger formatError={coachError}
          action={() => coachApi.unassign(via, team.id, removing.id)} onClose={() => setRemoving(null)}
          onDone={() => { const c = removing; setRemoving(null); onChanged(`${c.displayName} no longer coaches ${team.name}.`); }}>
          <p>{removing.displayName} stops seeing this team's candidates, Hot List and interviews. You can add them again later.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function AddCoachDialog({ team, via, people, onClose, onDone }: {
  team: { id: string; name: string }; via: CoachVia; people: Coach[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [userId, setUserId] = useState("");
  const { busy, error, run } = useSubmit(coachError);
  return (
    <Dialog title={`Add coach to ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await coachApi.assign(via, team.id, userId);
          const name = people.find((p) => p.id === userId)?.displayName ?? "The coach";
          onDone(`${name} now coaches ${team.name}.`);
        });
      }}>
        <div className="field"><label htmlFor="ac-user">Coach</label>
          <select id="ac-user" required data-autofocus value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="" disabled>{people.length ? "Choose a coach…" : "No coaches to add"}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName} ({p.email}){p.role === "interview_lead" ? " · Interview Lead" : ""}</option>
            ))}
          </select></div>
        <p className="hint">The coach sees this team's candidates, Hot List, interviews and training progress, and gives interview feedback the team's lead sees.</p>
        <DialogActions onCancel={onClose} submitLabel="Add coach" busy={busy} error={error} disabled={!userId} />
      </form>
    </Dialog>
  );
}
