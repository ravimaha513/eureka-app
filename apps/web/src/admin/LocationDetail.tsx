import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { adminApi, type LocationDetail as Detail, type LocationPerson } from "./adminApi";
import { friendlyError } from "./errors";
import { keys, useAccess } from "./shared";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import { Drawer } from "../sales/ui";
import { Avatar } from "../shell/ui";

export const KIND_LABELS: Record<string, string> = { training: "Training", gh: "GH", office: "Office", remote: "Remote" };

type View = "hierarchy" | "team" | "role";

/** One location: its location roles and its people as a reporting tree, by team or by role. Only the name is editable. */
export function LocationDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useQuery({ queryKey: [...keys.locations, id], queryFn: () => adminApi.location(id) });
  const [view, setView] = useState<View>("hierarchy");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const { announce } = useAccess();
  const qc = useQueryClient();

  if (q.isLoading) return <Loading />;
  if (q.error) return <QueryError query={q} message={friendlyError(q.error)} />;
  const d = q.data!;
  const { location: loc } = d;
  const here = d.people.flatMap((p) => p.roles.filter((r) => r.locationId === loc.id).map((r) => ({ person: p, role: r })));
  const unlinked = d.people.filter((p) => !p.managerId && !d.people.some((x) => x.managerId === p.id));
  const term = search.trim().toLowerCase();
  const matches = (p: LocationPerson) => !term || p.displayName.toLowerCase().includes(term);

  return (
    <div className="locdetail">
      <button type="button" className="btn sm backbtn" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> Locations</button>
      <header className="lochead">
        <h2>{loc.name}</h2>
        <span className="chip">{KIND_LABELS[loc.kind] ?? loc.kind}</span>
        <span className="muted">{[loc.state, loc.timezone].filter(Boolean).join(" · ")}</span>
        <button type="button" className="btn sm push" onClick={() => setRenaming(true)}><Pencil size={14} aria-hidden="true" /> Rename</button>
      </header>
      {renaming && (
        <RenameLocationDialog id={loc.id} name={loc.name} onClose={() => setRenaming(false)} onDone={(msg) => {
          setRenaming(false);
          announce(msg);
          // Users, teams and pickers all show location names.
          for (const k of [keys.meta, keys.locations, keys.users, keys.teams]) void qc.invalidateQueries({ queryKey: k });
        }} />
      )}

      <ul className="locstats" aria-label={`${loc.name} at a glance`}>
        <li><span className="muted">People</span><b>{d.people.length}</b></li>
        <li><span className="muted">Teams</span><b>{d.teams.length}</b></li>
        <li className={unlinked.length ? "warn" : undefined}><span className="muted">Not in a reporting line</span><b>{unlinked.length}</b></li>
      </ul>

      <section className="card pad" aria-labelledby="loc-roles">
        <h3 id="loc-roles">Location roles</h3>
        {here.length === 0
          ? <p className="muted">Nobody holds a role for {loc.name}. Grant Location Incharge or Location Ops Admin from Users.</p>
          : (
            <ul className="locpeople">
              {here.map(({ person, role }) => (
                <li key={`${person.id}-${role.key}`}>
                  <Avatar name={person.displayName} size="sm" />
                  <span><button type="button" className="linkbtn" onClick={() => setOpen(person.id)}><b>{person.displayName}</b></button>
                    <span className="muted"> {role.label}</span></span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="card pad" aria-labelledby="loc-people">
        <div className="toolbar">
          <h3 id="loc-people">People</h3>
          <div className="tabs" role="group" aria-label="Group people">
            {(["hierarchy", "team", "role"] as const).map((v) => (
              <button key={v} type="button" className="tab sm" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "hierarchy" ? "Hierarchy" : v === "team" ? "By team" : "By role"}
              </button>
            ))}
          </div>
          <div className="field inline push">
            <label htmlFor="loc-search">Find a person</label>
            <input id="loc-search" type="search" placeholder="Name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {d.people.length === 0 ? <p className="empty">Nobody is based at {loc.name} yet.</p>
          : view === "hierarchy" ? <Hierarchy d={d} matches={matches} filtering={!!term} unlinked={unlinked} onOpen={setOpen} />
            : view === "team" ? <ByTeam d={d} matches={matches} onOpen={setOpen} />
              : <ByRole d={d} matches={matches} onOpen={setOpen} />}
      </section>

      {open && <PersonDrawer d={d} id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </div>
  );
}

function PersonLine({ p, onOpen }: { p: LocationPerson; onOpen: (id: string) => void }) {
  const lead = p.teams.find((t) => t.asLead);
  return (
    <span className="personline">
      <Avatar name={p.displayName} size="sm" />
      <button type="button" className="linkbtn" onClick={() => onOpen(p.id)}><b>{p.displayName}</b></button>
      {p.roles.map((r) => <span key={`${r.key}-${r.locationId ?? ""}`} className="chip">{r.label}</span>)}
      {lead && <span className="muted">{lead.name}</span>}
    </span>
  );
}

function Hierarchy({ d, matches, filtering, unlinked, onOpen }: {
  d: Detail; matches: (p: LocationPerson) => boolean; filtering: boolean; unlinked: LocationPerson[]; onOpen: (id: string) => void;
}) {
  const reports = useMemo(() => {
    const m = new Map<string, LocationPerson[]>();
    for (const p of d.people) if (p.managerId) m.set(p.managerId, [...(m.get(p.managerId) ?? []), p]);
    return m;
  }, [d]);
  const inSet = new Set(d.people.map((p) => p.id));
  const linkedRoots = d.people.filter((p) => !p.managerId && reports.has(p.id));
  // A subtree is shown while searching when someone in it matches.
  const visible = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const p = d.people.find((x) => x.id === id);
    return (!!p && matches(p)) || (reports.get(id) ?? []).some((c) => visible(c.id, seen));
  };
  const outside = d.outsideManagers.filter((m) => !inSet.has(m.id) && (reports.get(m.id) ?? []).some((c) => visible(c.id)));
  const roots = linkedRoots.filter((p) => visible(p.id));
  const loose = unlinked.filter(matches);

  return (
    <>
      {roots.length + outside.length === 0 && loose.length === 0 && <p className="muted">Nobody matches.</p>}
      <ul className="orgtree" aria-label="Reporting hierarchy">
        {outside.map((m) => (
          <TreeNode key={m.id} label={<span className="personline outside"><Avatar name={m.displayName} size="sm" /><b>{m.displayName}</b>
            <span className="muted">based {m.locationName ? `in ${m.locationName}` : "elsewhere"}</span></span>}
          kids={(reports.get(m.id) ?? []).filter((c) => visible(c.id))} reports={reports} visible={visible} filtering={filtering} onOpen={onOpen} path={new Set([m.id])} />
        ))}
        {roots.map((p) => (
          <TreeNode key={p.id} label={<PersonLine p={p} onOpen={onOpen} />} kids={(reports.get(p.id) ?? []).filter((c) => visible(c.id))}
            reports={reports} visible={visible} filtering={filtering} onOpen={onOpen} path={new Set([p.id])} />
        ))}
      </ul>
      {loose.length > 0 && (
        <div className="looseppl">
          <p className="muted">Not in a reporting line ({loose.length})</p>
          <ul className="locpeople">{loose.map((p) => <li key={p.id}><PersonLine p={p} onOpen={onOpen} /></li>)}</ul>
        </div>
      )}
    </>
  );
}

function TreeNode({ label, kids, reports, visible, filtering, onOpen, path }: {
  label: React.ReactNode; kids: LocationPerson[]; reports: Map<string, LocationPerson[]>;
  visible: (id: string) => boolean; filtering: boolean; onOpen: (id: string) => void; path: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const shown = filtering || !collapsed;
  return (
    <li>
      <div className="treerow">
        {kids.length > 0
          ? <button type="button" className="iconbtn sm" aria-expanded={shown} aria-label={shown ? "Collapse" : "Expand"} onClick={() => setCollapsed(!collapsed)}>
            {shown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>
          : <span className="treespacer" />}
        {label}
        {kids.length > 0 && <span className="muted push">{kids.length} direct</span>}
      </div>
      {shown && kids.length > 0 && (
        <ul>
          {kids.filter((k) => !path.has(k.id)).map((k) => (
            <TreeNode key={k.id} label={<PersonLine p={k} onOpen={onOpen} />} kids={(reports.get(k.id) ?? []).filter((c) => visible(c.id))}
              reports={reports} visible={visible} filtering={filtering} onOpen={onOpen} path={new Set([...path, k.id])} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ByTeam({ d, matches, onOpen }: { d: Detail; matches: (p: LocationPerson) => boolean; onOpen: (id: string) => void }) {
  const byId = new Map(d.people.map((p) => [p.id, p]));
  const inTeam = new Set(d.teams.flatMap((t) => [t.lead.id, ...t.memberIds]));
  const rest = d.people.filter((p) => !inTeam.has(p.id) && matches(p));
  return (
    <div className="teamgrid">
      {d.teams.map((t) => {
        const lead = byId.get(t.lead.id);
        const members = t.memberIds.map((id) => byId.get(id)).filter((p): p is LocationPerson => !!p && matches(p));
        if (!(lead && matches(lead)) && members.length === 0) return null;
        return (
          <section key={t.id} className="card team" aria-labelledby={`lt-${t.id}`}>
            <header><h4 id={`lt-${t.id}`}>{t.name}</h4><span className="muted">{t.memberIds.length + 1} people</span></header>
            {lead ? <PersonLine p={lead} onOpen={onOpen} /> : <span className="muted">Lead {t.lead.displayName}</span>}
            <ul className="locpeople indent">{members.map((p) => <li key={p.id}><PersonLine p={p} onOpen={onOpen} /></li>)}</ul>
            {t.coaches.length > 0 && <p className="muted">Coach {t.coaches.map((c) => c.displayName).join(", ")}</p>}
          </section>
        );
      })}
      {rest.length > 0 && (
        <section className="card team dashed" aria-labelledby="lt-none">
          <header><h4 id="lt-none">No team here</h4><span className="muted">{rest.length} people</span></header>
          <ul className="locpeople">{rest.map((p) => <li key={p.id}><PersonLine p={p} onOpen={onOpen} /></li>)}</ul>
        </section>
      )}
    </div>
  );
}

function ByRole({ d, matches, onOpen }: { d: Detail; matches: (p: LocationPerson) => boolean; onOpen: (id: string) => void }) {
  const groups = new Map<string, LocationPerson[]>();
  for (const p of d.people.filter(matches)) {
    const labels = p.roles.length ? [...new Set(p.roles.map((r) => r.label))] : ["No role"];
    for (const l of labels) groups.set(l, [...(groups.get(l) ?? []), p]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No role" ? 1 : b === "No role" ? -1 : a.localeCompare(b)));
  return (
    <div className="teamgrid">
      {ordered.map(([role, ppl]) => (
        <section key={role} className="card team" aria-label={role}>
          <header><h4>{role}</h4><span className="muted">{ppl.length}</span></header>
          <ul className="locpeople">{ppl.map((p) => <li key={p.id}><PersonLine p={p} onOpen={onOpen} /></li>)}</ul>
        </section>
      ))}
    </div>
  );
}

function PersonDrawer({ d, id, onClose, onOpen }: { d: Detail; id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const p = d.people.find((x) => x.id === id);
  if (!p) return null;
  const chain: { id: string; name: string; here: boolean }[] = [];
  const seen = new Set([p.id]);
  for (let m = p.managerId; m && !seen.has(m);) {
    seen.add(m);
    const inLoc = d.people.find((x) => x.id === m);
    const out = d.outsideManagers.find((x) => x.id === m);
    chain.unshift({ id: m, name: inLoc?.displayName ?? out?.displayName ?? "Unknown", here: !!inLoc });
    m = inLoc?.managerId ?? null;
  }
  const direct = d.people.filter((x) => x.managerId === p.id);
  return (
    <Drawer title={p.displayName} onClose={onClose} closeLabel="Close person">
      <dl className="facts">
        <dt>Designation</dt><dd>{p.designation ?? "—"}</dd>
        <dt>Based in</dt><dd>{p.primaryLocation?.name ?? "—"}</dd>
        <dt>Roles</dt><dd>{p.roles.length ? p.roles.map((r) => r.locationName ? `${r.label} (${r.locationName})` : r.label).join(", ") : "None"}</dd>
        <dt>Teams</dt><dd>{p.teams.length ? p.teams.map((t) => t.asLead ? `${t.name} (lead)` : t.name).join(", ") : "None"}</dd>
      </dl>
      <section aria-labelledby="pd-chain">
        <h3 id="pd-chain" className="drawersub">Reporting chain</h3>
        {chain.length === 0 ? <p className="muted">No manager.</p> : (
          <ol className="chain">
            {chain.map((c) => (
              <li key={c.id}>{c.here
                ? <button type="button" className="linkbtn" onClick={() => onOpen(c.id)}>{c.name}</button>
                : <span>{c.name} <span className="muted">(other location)</span></span>}</li>
            ))}
            <li><b>{p.displayName}</b></li>
          </ol>
        )}
      </section>
      <section aria-labelledby="pd-direct">
        <h3 id="pd-direct" className="drawersub">Direct reports ({direct.length})</h3>
        {direct.length === 0 ? <p className="muted">None at this location.</p> : (
          <ul className="locpeople">{direct.map((x) => <li key={x.id}><PersonLine p={x} onOpen={onOpen} /></li>)}</ul>
        )}
      </section>
    </Drawer>
  );
}

function RenameLocationDialog({ id, name: current, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState(current);
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const next = name.trim();
  return (
    <Dialog title={`Rename ${current}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.renameLocation(id, next);
          onDone(`Renamed ${current} to ${next}.`);
        });
      }}>
        <div className="field"><label htmlFor="rl-name">Location name</label>
          <input id="rl-name" required maxLength={120} data-autofocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <DialogActions onCancel={onClose} submitLabel="Rename location" busy={busy} error={error} disabled={!next || next === current} />
      </form>
    </Dialog>
  );
}
