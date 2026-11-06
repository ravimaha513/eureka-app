import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { adminApi, SCOPE_LABELS, type AccessExplanation, type ExplainKind, type ExplainMiss, type ExplainPath, type NamedRef } from "./adminApi";
import { friendlyError } from "./errors";
import { PersonPicker, type PersonPickerValue } from "./PersonPicker";

/**
 * "Why can this user see this record?" (docs/admin-api.md AD-16). Pick a person and paste a
 * record id (or a link containing one). The answer lists, role by role, the grant and the fact of
 * the record that make it visible, and whether the database (RLS, probed as that person) agrees.
 * Only ids and org names are shown: no candidate name, contact or rate.
 */

const KINDS: { key: ExplainKind; label: string }[] = [
  { key: "candidate", label: "Candidate" },
  { key: "submission", label: "Submission" },
  { key: "interview", label: "Interview" },
  { key: "placement", label: "Placement" },
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The last id in a pasted link or text (records sit after their parents in URLs). */
export const extractId = (s: string): string | null => {
  const all = s.match(new RegExp(UUID.source, "gi"));
  return all ? all[all.length - 1]!.toLowerCase() : null;
};

const name = (r: NamedRef) => (r ? r.name : "none");
const subject = (on: "record" | "candidate", kind: ExplainKind) =>
  on === "candidate" && kind !== "candidate" ? "the candidate's" : `the ${kind}'s`;

export function pathText(p: ExplainPath, kind: ExplainKind): string {
  switch (p.via) {
    case "org": return "Covers the whole organisation.";
    case "all_teams": return "The candidate is Open to all teams and marketable, and this is a Sales role.";
    case "selected_teams": return "The candidate is shared with one of their teams and marketable, and this is a Sales role.";
    case "self": return `They are ${subject(p.on, kind)} recruiter.`;
    case "report": return `${name(p.user)}, ${subject(p.on, kind)} recruiter, reports to them.`;
    case "team": return `${subject(p.on, kind).replace(/^./, (c) => c.toUpperCase())} team ${name(p.team)} is in their scope.`;
    case "location": return `${subject(p.on, kind).replace(/^./, (c) => c.toUpperCase())} location ${name(p.location)} is this role's location.`;
  }
}

export const MISS_TEXT: Record<ExplainMiss, string> = {
  out_of_scope: "Holds the permission, but none of its recruiters, teams or locations match this record.",
  open_to_all_not_marketable: "The candidate is Open to all teams, but only Active or Full of interviews candidates are shown to other teams.",
  open_to_all_not_sales: "The candidate is shared, but sharing reaches Sales roles only.",
  open_to_all_not_for_activity: "Sharing a candidate never reveals other teams' submissions, interviews or placements.",
};

const VISIBILITY: Record<string, string> = { team: "Team only", all_teams: "Open to all teams", selected_teams: "Selected teams" };

export function ExplainTab() {
  const [person, setPerson] = useState<PersonPickerValue | null>(null);
  const [kind, setKind] = useState<ExplainKind>("candidate");
  const [raw, setRaw] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const run = useMutation({ mutationFn: (v: { userId: string; kind: ExplainKind; id: string }) => adminApi.explainAccess(v.userId, v.kind, v.id) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = extractId(raw);
    if (!person) return setInvalid("Pick a person.");
    if (!id) return setInvalid("Paste a record id or a link that contains one.");
    setInvalid(null);
    run.mutate({ userId: person.id, kind, id });
  };

  return (
    <div className="explain">
      <p className="hint">Why can (or can't) someone see a record? Pick the person, then paste the record's id or its link.</p>
      <form className="formgrid cols2 explain-form" onSubmit={submit} aria-label="Explain access">
        <PersonPicker id="ex-user" label="Person" value={person} onChange={setPerson} />
        <div className="field"><label htmlFor="ex-kind">Record type</label>
          <select id="ex-kind" value={kind} onChange={(e) => setKind(e.target.value as ExplainKind)}>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select></div>
        <div className="field spanall"><label htmlFor="ex-id">Record id or link</label>
          <input id="ex-id" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="e.g. https://…/candidates/3f2c…" autoComplete="off" /></div>
        <div className="actions spanall">
          <button className="btn primary" type="submit" disabled={run.isPending}>{run.isPending ? "Checking…" : "Explain"}</button>
        </div>
        {(invalid || run.isError) && <p className="error spanall" role="alert">{invalid ?? friendlyError(run.error)}</p>}
      </form>
      {run.data && !invalid && <Result r={run.data} />}
    </div>
  );
}

function Result({ r }: { r: AccessExplanation }) {
  const kind = r.record.kind;
  return (
    <section className="explain-result" aria-live="polite" aria-labelledby="ex-verdict">
      <h3 id="ex-verdict" className={`explain-verdict ${r.allowed ? "yes" : "no"}`}>
        {r.user.displayName} {r.allowed ? "can" : "cannot"} see this {kind}
        {r.user.status !== "active" && <span className="tag">{r.user.status}</span>}
      </h3>
      {r.rls.agrees
        ? <p className="muted">The database agrees (row-level security, checked as {r.user.displayName}).</p>
        : <p className="note warn" role="alert">
            Mismatch: the app says {r.allowed ? "visible" : "hidden"}, the database says {r.rls.allowed ? "visible" : "hidden"}.
            This is a bug; send this record and person to the developers.
          </p>}
      {r.allowed && r.phone && <p className="muted">Phone: {r.phone === "full" ? "shown in full" : "masked"}.</p>}

      <dl className="explain-facts">
        {r.record.actor && <><dt>Logged by</dt><dd>{name(r.record.actor.recruiter)} · team {name(r.record.actor.team)}</dd></>}
        <dt>Candidate owner</dt><dd>{name(r.record.owner.recruiter)} · team {name(r.record.owner.team)} · {name(r.record.owner.location)}</dd>
        <dt>Candidate sharing</dt><dd>{VISIBILITY[r.record.visibility] ?? r.record.visibility} · status {r.record.marketingStatus.replace(/_/g, " ")}</dd>
        <dt>Their teams</dt><dd>{r.facts.teams.map(name).join(", ") || "none"}{r.facts.reports > 0 && ` · ${r.facts.reports} people report to them`}</dd>
      </dl>

      <h4 className="sectiontitle">Role by role ({r.permission})</h4>
      <ul className="explain-roles">
        {r.roles.map((role, i) => (
          <li key={`${role.role}-${i}`} className={role.paths.length ? "yes" : "no"}>
            <b>{role.label}</b>{role.location && <span className="muted"> · {role.location.name}</span>}
            <span className="muted"> · {role.scope ? SCOPE_LABELS[role.scope] ?? role.scope : "does not hold this permission"}</span>
            {role.paths.length > 0
              ? <ul>{role.paths.map((p, j) => <li key={j}>{pathText(p, kind)}</li>)}</ul>
              : role.miss && <p className="muted">{MISS_TEXT[role.miss]}</p>}
          </li>
        ))}
        {r.roles.length === 0 && <li className="no">They hold no roles.</li>}
      </ul>
    </section>
  );
}
