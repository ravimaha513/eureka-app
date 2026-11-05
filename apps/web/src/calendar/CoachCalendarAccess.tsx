import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryError } from "../ui/QueryError";
import {
  type CoachCalendarDetail, type CoachGrant, type NamedId, coachCalendarApi, coachCalendarError, coachCalendarKeys,
} from "./coachCalendarApi";

const DETAIL_LABEL: Record<CoachCalendarDetail, string> = { full: "Full details", busy: "Busy only" };

interface Draft { kind: "role" | "user"; role: string; person: NamedId | null; all: boolean; coachIds: string[]; detail: CoachCalendarDetail }
const EMPTY: Draft = { kind: "role", role: "", person: null, all: true, coachIds: [], detail: "busy" };

function PersonSearch({ id, value, onChange }: { id: string; value: NamedId | null; onChange: (p: NamedId | null) => void }) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  const q = useQuery({ queryKey: coachCalendarKeys.people(term), queryFn: () => coachCalendarApi.people(term), enabled: term !== "" });
  if (value) {
    return <div className="field inline"><span className="cc-label">Person</span>
      <span className="rowactions"><b>{value.name}</b> <button type="button" className="btn sm" onClick={() => onChange(null)}>Change</button></span></div>;
  }
  return (
    <div className="field inline cc-person">
      <label htmlFor={id}>Person</label>
      <input id={id} type="search" placeholder="Search by name" value={input} onChange={(e) => setInput(e.target.value)} />
      {term !== "" && q.data && (
        <ul className="cc-results">
          {q.data.items.map((p) => <li key={p.id}><button type="button" className="btn sm" onClick={() => { onChange(p); setInput(""); setTerm(""); }}>{p.name}</button></li>)}
          {q.data.items.length === 0 && <li className="hint">No one active by that name.</li>}
        </ul>
      )}
    </div>
  );
}

/** Who may see the coach calendar. The API and the database both refuse anyone but the CEO. */
export function CoachCalendarAccess() {
  const id = useId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: coachCalendarKeys.grants, queryFn: coachCalendarApi.grants });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: coachCalendarKeys.all });
  const save = useMutation({
    mutationFn: () => coachCalendarApi.setGrant({
      ...(draft.kind === "role" ? { granteeRole: draft.role } : { granteeUserId: draft.person!.id }),
      allCoaches: draft.all, ...(draft.all ? {} : { coachIds: draft.coachIds }), detail: draft.detail,
    }),
    onSuccess: async () => { setDraft(EMPTY); await refresh(); },
    onError: (e) => setProblem(coachCalendarError(e)),
  });
  const remove = useMutation({ mutationFn: coachCalendarApi.removeGrant, onSuccess: refresh, onError: (e) => setProblem(coachCalendarError(e)) });

  if (q.isError) return <QueryError query={q} message="Coach calendar access didn't load." />;
  if (q.isPending) return <p className="hint" role="status">Loading access…</p>;
  const { items, coaches, roles } = q.data;

  const edit = (g: CoachGrant) => {
    setProblem(null);
    setDraft({
      kind: g.grantee.type,
      role: g.grantee.type === "role" ? g.grantee.role : "",
      person: g.grantee.type === "user" ? { id: g.grantee.id, name: g.grantee.name } : null,
      all: g.allCoaches, coachIds: g.coaches.map((c) => c.id), detail: g.detail,
    });
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.kind === "role" ? !draft.role : !draft.person) { setProblem(draft.kind === "role" ? "Choose a role." : "Search for a person and pick them."); return; }
    if (!draft.all && draft.coachIds.length === 0) { setProblem("Choose at least one coach."); return; }
    setProblem(null);
    save.mutate();
  };
  const toggleCoach = (coach: string, on: boolean) =>
    setDraft({ ...draft, coachIds: on ? [...draft.coachIds, coach] : draft.coachIds.filter((c) => c !== coach) });

  return (
    <div className="cc-access">
      <p className="hint">Only you can change this. Each coach always sees their own calendar, and you always see all. Everyone else sees nothing until you add them here. If someone is covered twice, by their role and by name, they get the wider of the two.</p>
      <div className="card tablewrap">
        <table className="mini">
          <thead><tr><th scope="col">Who</th><th scope="col">Which coaches</th><th scope="col">Can see</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id}>
                <td><span className="badge">{g.grantee.type === "role" ? "Role" : "User"}</span> {g.grantee.name}</td>
                <td>{g.allCoaches ? "All coaches" : g.coaches.map((c) => c.name).join(", ") || "No active coaches"}</td>
                <td>{DETAIL_LABEL[g.detail]}</td>
                <td className="rowactions">
                  <button type="button" className="btn sm" aria-label={`Edit access for ${g.grantee.name}`} onClick={() => edit(g)}>Edit</button>
                  <button type="button" className="btn sm" aria-label={`Remove access for ${g.grantee.name}`} disabled={remove.isPending} onClick={() => remove.mutate(g.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="hint">No one else has access yet. Add a role or a person below.</td></tr>}
          </tbody>
        </table>
      </div>

      <form className="card pad cc-form" onSubmit={submit} aria-labelledby={`${id}-h`} noValidate>
        <h2 id={`${id}-h`} className="sectiontitle">Give access</h2>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-kind`}>Give to</label>
            <select id={`${id}-kind`} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}>
              <option value="role">A role</option><option value="user">A specific person</option>
            </select>
          </div>
          {draft.kind === "role"
            ? <div className="field inline">
                <label htmlFor={`${id}-role`}>Role</label>
                <select id={`${id}-role`} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                  <option value="">Choose a role</option>
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </div>
            : <PersonSearch id={`${id}-person`} value={draft.person} onChange={(person) => setDraft({ ...draft, person })} />}
          <div className="field inline">
            <label htmlFor={`${id}-cover`}>Which coaches</label>
            <select id={`${id}-cover`} value={draft.all ? "all" : "chosen"} onChange={(e) => setDraft({ ...draft, all: e.target.value === "all" })}>
              <option value="all">All coaches</option><option value="chosen">Chosen coaches</option>
            </select>
          </div>
          <div className="field inline">
            <label htmlFor={`${id}-detail`}>Can see</label>
            <select id={`${id}-detail`} value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value as CoachCalendarDetail })}>
              <option value="busy">{DETAIL_LABEL.busy}</option><option value="full">{DETAIL_LABEL.full}</option>
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={save.isPending}>Save access</button>
        </div>
        {!draft.all && (
          <fieldset className="cc-coaches">
            <legend>Chosen coaches</legend>
            {coaches.map((c) => (
              <label key={c.id}><input type="checkbox" checked={draft.coachIds.includes(c.id)} onChange={(e) => toggleCoach(c.id, e.target.checked)} /> {c.name}</label>
            ))}
            {coaches.length === 0 && <span className="hint">No active coaches.</span>}
          </fieldset>
        )}
        <p className="hint cc-formhint">Saving for a role or person who already has access replaces what they had.</p>
        {problem && <p className="error" role="alert">{problem}</p>}
      </form>
    </div>
  );
}
