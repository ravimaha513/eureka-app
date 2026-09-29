import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type MoveResult, type Ref, type Team } from "./adminApi";
import { Dialog, DialogActions, useSubmit } from "./Dialog";
import { friendlyError } from "./errors";
import { keys, useAccess, useMeta, usePeople } from "./shared";

type Modal =
  | { kind: "create" }
  | { kind: "lead"; team: Team }
  | { kind: "add"; team: Team }
  | { kind: "move"; team: Team; member: Ref };

export function TeamsTab() {
  const { me, announce } = useAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.teams, queryFn: adminApi.teams });
  const [modal, setModal] = useState<Modal | null>(null);
  // Presentation only: the API checks team:move_member over both teams (AD-8).
  const canMove = me.capabilities.includes("team:move_member");

  const close = () => setModal(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.teams });
    void qc.invalidateQueries({ queryKey: keys.users });
  };
  const done = (msg: string) => { close(); announce(msg); refresh(); };

  return (
    <>
      <div className="toolbar">
        {!canMove && <p className="hint" id="move-hint">Moving people between teams needs the “move team member” permission over both teams. Your role doesn't hold it.</p>}
        <button className="btn primary push" onClick={() => setModal({ kind: "create" })}>New team</button>
      </div>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{friendlyError(q.error)}</p> : (
        <div className="teamgrid">
          {q.data!.items.map((t) => (
            <section key={t.id} className="card team" aria-labelledby={`team-${t.id}`}>
              <header>
                <h2 id={`team-${t.id}`}>{t.name}</h2>
                {t.location && <span className="muted">{t.location.name}</span>}
              </header>
              <p><span className="muted">Lead</span> <b>{t.lead.displayName}</b></p>
              <ul className="members" aria-label={`Members of ${t.name}`}>
                {t.members.map((m) => (
                  <li key={m.id}>
                    <span>{m.displayName}</span>
                    <button className="btn sm" disabled={!canMove} aria-describedby={canMove ? undefined : "move-hint"}
                      aria-label={`Move ${m.displayName} to another team`} onClick={() => setModal({ kind: "move", team: t, member: m })}>Move to team…</button>
                  </li>
                ))}
                {t.members.length === 0 && <li className="muted">No members yet.</li>}
              </ul>
              <div className="rowactions">
                <button className="btn sm" aria-label={`Change lead of ${t.name}`} onClick={() => setModal({ kind: "lead", team: t })}>Change lead</button>
                <button className="btn sm" aria-label={`Add member to ${t.name}`} onClick={() => setModal({ kind: "add", team: t })}>Add member</button>
              </div>
            </section>
          ))}
          {q.data!.items.length === 0 && <p className="empty">No teams yet.</p>}
        </div>
      )}

      {modal?.kind === "create" && <CreateTeamDialog onClose={close} onDone={done} />}
      {modal?.kind === "lead" && <LeadDialog team={modal.team} onClose={close} onDone={done} />}
      {modal?.kind === "add" && <AddMemberDialog team={modal.team} onClose={close} onDone={done} />}
      {modal?.kind === "move" && (
        <MoveMemberDialog team={modal.team} member={modal.member} teams={q.data?.items ?? []} onClose={close}
          onMoved={(msg) => { announce(msg); refresh(); }} />
      )}
    </>
  );
}

function PersonSelect({ id, label, value, onChange, exclude = [], required, describe }: {
  id: string; label: string; value: string; onChange: (v: string) => void; exclude?: string[]; required?: boolean; describe?: (teams: string[]) => string;
}) {
  const people = usePeople();
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <select id={id} required={required} data-autofocus value={value} onChange={(e) => onChange(e.target.value)} disabled={people.isLoading}>
        <option value="" disabled>{people.isLoading ? "Loading people…" : "Choose a person…"}</option>
        {(people.data ?? []).filter((p) => !exclude.includes(p.id)).map((p) => {
          const extra = describe?.(p.teams.map((t) => t.name));
          return <option key={p.id} value={p.id}>{p.displayName} ({p.email}){extra ? ` · ${extra}` : ""}</option>;
        })}
      </select>
      {people.error && <p className="error" role="alert">{friendlyError(people.error)}</p>}
    </div>
  );
}

function CreateTeamDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const meta = useMeta();
  const [name, setName] = useState("");
  const [leadId, setLeadId] = useState("");
  const [locationId, setLocationId] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  return (
    <Dialog title="New team" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.createTeam({ name: name.trim(), leadId, ...(locationId ? { locationId } : {}) });
          onDone(`Created ${name.trim()}.`);
        });
      }}>
        <div className="field"><label htmlFor="nt-name">Team name</label>
          <input id="nt-name" required data-autofocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <PersonSelect id="nt-lead" label="Lead" value={leadId} onChange={setLeadId} required />
        <div className="field"><label htmlFor="nt-loc">Location <span className="muted">(optional)</span></label>
          <select id="nt-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">None</option>
            {meta.data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Create team" busy={busy} error={error} disabled={!name.trim() || !leadId} />
      </form>
    </Dialog>
  );
}

function LeadDialog({ team, onClose, onDone }: { team: Team; onClose: () => void; onDone: (m: string) => void }) {
  const [leadId, setLeadId] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const people = usePeople();
  return (
    <Dialog title={`Change lead of ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.setLead(team.id, leadId);
          const name = people.data?.find((p) => p.id === leadId)?.displayName ?? "the new lead";
          onDone(`${name} now leads ${team.name}.`);
        });
      }}>
        <p className="hint">Current lead: <b>{team.lead.displayName}</b>. Reporting lines are checked for loops when the lead changes.</p>
        <PersonSelect id="ld-lead" label="New lead" value={leadId} onChange={setLeadId} exclude={[team.lead.id]} required />
        <DialogActions onCancel={onClose} submitLabel="Change lead" busy={busy} error={error} disabled={!leadId} />
      </form>
    </Dialog>
  );
}

function AddMemberDialog({ team, onClose, onDone }: { team: Team; onClose: () => void; onDone: (m: string) => void }) {
  const [userId, setUserId] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e, "addMember"));
  const people = usePeople();
  return (
    <Dialog title={`Add member to ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.addMember(team.id, userId);
          const name = people.data?.find((p) => p.id === userId)?.displayName ?? "The person";
          onDone(`${name} joined ${team.name}.`);
        });
      }}>
        <PersonSelect id="am-user" label="Person" value={userId} onChange={setUserId} required
          exclude={[team.lead.id, ...team.members.map((m) => m.id)]}
          describe={(teams) => (teams.length ? `in ${teams.join(", ")}` : "")} />
        <p className="hint">Someone already in another team has to be moved with “Move to team…” instead.</p>
        <DialogActions onCancel={onClose} submitLabel="Add member" busy={busy} error={error} disabled={!userId} />
      </form>
    </Dialog>
  );
}

export function MoveMemberDialog({ team, member, teams, onClose, onMoved }: {
  team: Team; member: Ref; teams: Team[]; onClose: () => void; onMoved: (msg: string) => void;
}) {
  const [toTeamId, setToTeamId] = useState("");
  // "" means the server default: the old team's lead (AD-8).
  const [reassignTo, setReassignTo] = useState("");
  const [result, setResult] = useState<MoveResult | null>(null);
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const targets = teams.filter((t) => t.id !== team.id);
  const others = team.members.filter((m) => m.id !== member.id && m.id !== team.lead.id);
  const toName = targets.find((t) => t.id === toTeamId)?.name ?? "";

  if (result) {
    const n = result.movedCandidates;
    return (
      <Dialog key="result" title={`${member.displayName} moved to ${toName}`} onClose={onClose}>
        {/* The page-level live region announces the outcome; this is the visible detail. */}
        <div className="dialogbody">
          <p><b>{member.displayName}</b> is now in <b>{toName}</b>.</p>
          <p>{n === 0 ? "They had no candidates to hand over."
            : `${n} candidate${n === 1 ? "" : "s"} stayed with ${team.name} and ${n === 1 ? "was" : "were"} reassigned to ${result.reassignedTo.displayName}.`}</p>
        </div>
        <div className="actions"><button className="btn primary" data-autofocus onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog key="form" title={`Move ${member.displayName} to another team`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const res = await adminApi.moveMember(team.id, { userId: member.id, toTeamId, ...(reassignTo ? { reassignTo } : {}) });
          setResult(res);
          onMoved(`Moved ${member.displayName} to ${toName}. ${res.movedCandidates} candidate${res.movedCandidates === 1 ? "" : "s"} reassigned to ${res.reassignedTo.displayName}.`);
        });
      }}>
        <p className="hint">Their candidates stay with <b>{team.name}</b> and go to the person you pick below.</p>
        <div className="field"><label htmlFor="mv-team">Move to team</label>
          <select id="mv-team" required data-autofocus value={toTeamId} onChange={(e) => setToTeamId(e.target.value)}>
            <option value="" disabled>Choose a team…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="mv-reassign">Reassign candidates to</label>
          <select id="mv-reassign" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
            <option value="">{team.lead.displayName} (lead of {team.name}, default)</option>
            {others.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Move" busy={busy} error={error} disabled={!toTeamId} />
      </form>
    </Dialog>
  );
}
