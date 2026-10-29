import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Drawer } from "../sales/ui";
import { Avatar } from "../shell/ui";
import { CoachList } from "../team/Coaches";
import type { Coach } from "../team/coachApi";
import { adminApi, departmentLabel, type AddMembersResult, type AdminUser, type Ref, type Team } from "./adminApi";
import { friendlyError, skipReason } from "./errors";
import { keys, useAccess, useMeta } from "./shared";

const ADD_PAGE = 50;

/**
 * One team: members on the left, a server-side people search on the right with
 * bulk add (POST /admin/teams/:id/members/bulk). Rename, lead and move open as
 * dialogs on top (`suspended` hands Escape and focus to them).
 */
export function TeamDrawer({ team, coaches, canMove, suspended, onClose, onRename, onLead, onMove, onChanged }: {
  team: Team; coaches: Coach[]; canMove: boolean; suspended: boolean;
  onClose: () => void; onRename: () => void; onLead: () => void; onMove: (member: Ref) => void;
  onChanged: (msg: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = team.members.filter((m) => m.displayName.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Drawer title={team.name} onClose={onClose} suspended={suspended} wide closeLabel={`Close ${team.name}`}>
      <div className="teamdrawer-head">
        <p className="muted">
          {team.location ? `${team.location.name} · ` : ""}Lead <b>{team.lead.displayName}</b>
          {team.department && <span className="tag" title="Lead's department">{departmentLabel(team.department)}</span>}
        </p>
        <div className="rowactions">
          <button className="btn sm" onClick={onRename}>Rename</button>
          <button className="btn sm" onClick={onLead}>Change lead</button>
        </div>
      </div>
      <div className="teamdrawer">
        <section aria-labelledby="td-members">
          <h3 id="td-members">Members ({team.members.length})</h3>
          {team.members.length > 5 && (
            <div className="field inline searchfield">
              <label htmlFor="td-filter" className="sr-only">Filter members</label>
              <Search size={15} aria-hidden="true" />
              <input id="td-filter" type="search" placeholder="Filter members" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          <ul className="members" aria-label={`Members of ${team.name}`}>
            {shown.map((m) => (
              <li key={m.id}>
                <span className="person"><Avatar name={m.displayName} size="sm" /><span>{m.displayName}</span></span>
                {canMove && (
                  <button className="btn sm" aria-label={`Move ${m.displayName} to another team`} onClick={() => onMove(m)}>Move…</button>
                )}
              </li>
            ))}
            {team.members.length === 0 && <li className="muted">No members yet. Add people on the right.</li>}
            {team.members.length > 0 && shown.length === 0 && <li className="muted">No members match.</li>}
          </ul>
          {!canMove && team.members.length > 0 && (
            <p className="hint">Moving people between teams needs the “move team member” permission over both teams.</p>
          )}
          <CoachList team={team} coaches={team.coaches} available={coaches} via="admin" onChanged={onChanged} />
        </section>
        <AddPeople team={team} onAdded={onChanged} />
      </div>
    </Drawer>
  );
}

function AddPeople({ team, onAdded }: { team: Team; onAdded: (msg: string) => void }) {
  const { me } = useAccess();
  const meta = useMeta();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [noTeam, setNoTeam] = useState(true);
  const [locationId, setLocationId] = useState("");
  const [role, setRole] = useState("");
  // Kept across searches so you can pick people from several queries before adding.
  const [picked, setPicked] = useState<Map<string, AdminUser>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ result: AddMembersResult; names: Map<string, string> } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const filters = { search, status: "active" as const, team: noTeam ? "none" : undefined, locationId: locationId || undefined, role: role || undefined, limit: ADD_PAGE };
  const q = useQuery({
    queryKey: [...keys.users, "addable", filters],
    queryFn: () => adminApi.users(filters),
    placeholderData: keepPreviousData,
  });
  // You can't add yourself (AD-2), and the lead and members are already in.
  const taken = new Set([me.id, team.lead.id, ...team.members.map((m) => m.id)]);
  const rows = (q.data?.items ?? []).filter((u) => !taken.has(u.id));

  const toggle = (u: AdminUser) => setPicked((prev) => {
    const next = new Map(prev);
    if (next.has(u.id)) next.delete(u.id); else next.set(u.id, u);
    return next;
  });

  const add = async () => {
    setBusy(true); setError(""); setReport(null);
    try {
      const names = new Map([...picked.values()].map((u) => [u.id, u.displayName]));
      const result = await adminApi.addMembers(team.id, [...picked.keys()]);
      setPicked(new Map());
      setReport(result.failed.length ? { result, names } : null);
      const n = result.added.length;
      onAdded(n === 1 ? `${names.get(result.added[0]!)} joined ${team.name}.` : `${n} people joined ${team.name}.`
        + (result.failed.length ? ` ${result.failed.length} skipped.` : ""));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="td-add" className="addpeople">
      <h3 id="td-add">Add people</h3>
      <div className="field inline searchfield">
        <label htmlFor="td-search" className="sr-only">Search people by name or email</label>
        <Search size={15} aria-hidden="true" />
        <input id="td-search" type="search" placeholder="Name or email" data-autofocus value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <div className="filterrow">
        <label className="togglechip"><input type="checkbox" checked={noTeam} onChange={(e) => setNoTeam(e.target.checked)} /> No team</label>
        <label className="sr-only" htmlFor="td-loc">Location</label>
        <select id="td-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Any location</option>
          {meta.data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="td-role">Role</label>
        <select id="td-role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Any role</option>
          {meta.data?.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </div>
      {q.error ? <p className="error" role="alert">{friendlyError(q.error)}</p> : (
        <ul className="pickrows" aria-label="People to add" aria-busy={q.isFetching || undefined}>
          {rows.map((u) => {
            const other = u.teams.filter((t) => !t.asLead).map((t) => t.name);
            return (
              <li key={u.id}>
                <label>
                  <input type="checkbox" aria-label={`Select ${u.displayName}`} checked={picked.has(u.id)} onChange={() => toggle(u)} />
                  <span className="persontext"><b>{u.displayName}</b><small className="block muted">{u.email}</small></span>
                  {other.length > 0 && <span className="badge">in {other.join(", ")}</span>}
                </label>
              </li>
            );
          })}
          {!q.isLoading && rows.length === 0 && (
            <li className="muted">{noTeam ? "Nobody without a team matches. Untick “No team” to search everyone." : "Nobody matches."}</li>
          )}
          {q.data?.nextCursor && <li className="muted">Showing the first {ADD_PAGE}. Narrow the search to find more.</li>}
        </ul>
      )}
      {report && (
        <div className="error" role="alert">
          <p>Skipped {report.result.failed.length}:</p>
          <ul>{report.result.failed.map((f) => <li key={f.userId}>{report.names.get(f.userId) ?? "Unknown person"}: {skipReason(f.error)}</li>)}</ul>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="addbar">
        <span className="muted">
          {picked.size} selected
          {picked.size > 0 && <> · <button type="button" className="linkbtn" onClick={() => setPicked(new Map())}>Clear</button></>}
        </span>
        <button className="btn primary" disabled={picked.size === 0 || busy} aria-busy={busy || undefined} onClick={() => void add()}>
          {busy ? "Adding…" : `Add ${picked.size || ""} to ${team.name}`.replace("  ", " ")}
        </button>
      </div>
    </section>
  );
}
