import { useEffect, useMemo, useState, type DragEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "../shell/ui";
import { adminApi, type OrgChart, type OrgPerson, type OrgPreview } from "./adminApi";
import { friendlyError } from "./errors";
import { keys, useAccess, useMeta } from "./shared";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

/**
 * Org chart editor (docs/roles-api.md, "Org chart"). The tree follows the reporting
 * line; a team strip sits under each lead. Drops and the side panel queue changes
 * locally; "Apply changes" sends one batch (POST /admin/org-chart/apply). The API
 * enforces every rule; the chart only explains them before the drop.
 */

type Change =
  | { kind: "manager"; userId: string; managerId: string | null; previous: string | null; preview?: OrgPreview }
  | { kind: "team"; userId: string; teamId: string }
  | { kind: "promote"; userId: string; from: string; to: string };

type Drag = { id: string; fromTeam: string | null };

const KINDS: Record<string, string> = { sales: "", interview_prep: "coach", hr: "ops", operations: "ops", location: "ops", administration: "ops" };
const topRole = (p: OrgPerson) => p.roles[0] ?? null;
const level = (p: OrgPerson) => Math.max(0, ...p.roles.map((r) => r.level));
const isRecruiter = (p: OrgPerson, recruiterKeys: ReadonlySet<string>) => p.roles.some((r) => recruiterKeys.has(r.key));

export function OrgChartTab() {
  const { me, announce } = useAccess();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: keys.orgChart, queryFn: adminApi.orgChart });
  const meta = useMeta();
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<{ key: string; problem: string | null; warn: boolean } | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "" | "ok" | "bad" }>({ text: "", tone: "" });
  const [busy, setBusy] = useState(false);

  // The chart as it would be after the pending changes.
  const view = useMemo(() => applyLocally(chart.data, changes), [chart.data, changes]);
  const people = view?.people ?? [];
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const children = useMemo(() => {
    const m = new Map<string | null, OrgPerson[]>();
    for (const p of people) m.set(p.managerId, [...(m.get(p.managerId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => level(b) - level(a) || a.displayName.localeCompare(b.displayName));
    return m;
  }, [people]);
  const recruiterKeys = useMemo(() => new Set((meta.data?.roles ?? []).filter((r) => r.recruiter).map((r) => r.key)), [meta.data]);
  const changedIds = useMemo(() => new Set(changes.map((c) => c.userId)), [changes]);

  const descendants = (id: string, acc = new Set<string>()): Set<string> => {
    for (const c of children.get(id) ?? []) if (!acc.has(c.id)) { acc.add(c.id); descendants(c.id, acc); }
    return acc;
  };

  // ---- rules shown before a drop (the API re-checks every one) ----
  const reportProblem = (id: string, managerId: string | null): { text: string; warn: boolean } | null => {
    const p = byId.get(id)!;
    if (id === me.id) return { text: "You can't change your own reporting line.", warn: false };
    if (managerId === id) return { text: "Someone can't manage themself.", warn: false };
    if (managerId && descendants(id).has(managerId)) return { text: `${byId.get(managerId)!.displayName} reports to ${p.displayName}: that would be a loop.`, warn: false };
    if (managerId === p.managerId) return { text: "Already reports to them.", warn: false };
    if (managerId && level(byId.get(managerId)!) <= level(p)) {
      return { text: `${byId.get(managerId)!.displayName} is level ${level(byId.get(managerId)!)}, not above level ${level(p)}. Allowed, but check the ladder.`, warn: true };
    }
    return null;
  };
  const joinProblem = (id: string, teamId: string): string | null => {
    const p = byId.get(id)!;
    if (id === me.id) return "You can't change your own team.";
    if (!isRecruiter(p, recruiterKeys)) return `${p.displayName}'s role isn't a recruiter role. Only recruiters are team members.`;
    if (p.team) return p.team.id === teamId ? "Already in this team." : "Already in another team: move them from the Teams tab.";
    return null;
  };

  const queue = (c: Change, text: string) => {
    setChanges((cs) => [...cs.filter((x) => !(x.kind === c.kind && x.userId === c.userId)), c]);
    setStatus({ text, tone: "ok" });
  };
  const moveTo = async (id: string, managerId: string | null) => {
    const problem = reportProblem(id, managerId);
    if (problem && !problem.warn) { setStatus({ text: problem.text, tone: "bad" }); return; }
    const p = byId.get(id)!;
    const original = chart.data!.people.find((x) => x.id === id)!;
    const c: Change = { kind: "manager", userId: id, managerId, previous: original.managerId };
    queue(c, `${p.displayName} now reports to ${managerId ? byId.get(managerId)!.displayName : "nobody"}.${problem ? ` ${problem.text}` : ""}`);
    try {
      const preview = await adminApi.orgChartPreview(id, managerId);
      setChanges((cs) => cs.map((x) => (x.kind === "manager" && x.userId === id && x.managerId === managerId ? { ...x, preview } : x)));
    } catch { /* the preview is a courtesy; the batch still applies */ }
  };
  const joinTeam = (id: string, teamId: string) => {
    const problem = joinProblem(id, teamId);
    if (problem) { setStatus({ text: problem, tone: "bad" }); return; }
    queue({ kind: "team", userId: id, teamId }, `${byId.get(id)!.displayName} joins ${view!.teams.find((t) => t.id === teamId)!.name}.`);
  };
  const promote = (id: string) => {
    const p = byId.get(id)!;
    const current = topRole(p); if (!current) return;
    const ladder = (meta.data?.roles ?? []).filter((r) => r.track === current.track).sort((a, b) => a.level - b.level);
    const next = ladder.find((r) => r.level > current.level); if (!next) return;
    queue({ kind: "promote", userId: id, from: current.key, to: next.key }, `${p.displayName}: ${current.label} → ${next.label} on apply.${next.restricted ? " Restricted: the new role waits for a second admin; the current one stays until then." : ""}`);
  };

  // ---- apply / discard ----
  const apply = async () => {
    setBusy(true);
    try {
      const moves = changes.filter((c): c is Extract<Change, { kind: "manager" }> => c.kind === "manager").map((c) => ({ userId: c.userId, managerId: c.managerId }));
      const teamAdds = changes.filter((c): c is Extract<Change, { kind: "team" }> => c.kind === "team").map((c) => ({ userId: c.userId, teamId: c.teamId }));
      let applied = 0; let warnings: { userId: string; code: string }[] = [];
      if (moves.length || teamAdds.length) ({ applied, warnings } = await adminApi.orgChartApply({ moves, teamAdds }));
      const notes: string[] = [];
      for (const c of changes.filter((x): x is Extract<Change, { kind: "promote" }> => x.kind === "promote")) {
        const r = await adminApi.requestRole({ userId: c.userId, role: c.to });
        if (r.status === "applied") { await adminApi.revokeRole(c.userId, c.from, null); applied++; }
        else notes.push(`${byId.get(c.userId)!.displayName}'s promotion waits for a second admin.`);
      }
      setChanges([]);
      const warned = warnings.map((w) => `${byId.get(w.userId)?.displayName ?? w.userId} (${w.code === "ladder_level" ? "below on the ladder" : w.code})`);
      const msg = `Applied ${applied} ${applied === 1 ? "change" : "changes"}.${warned.length ? ` Warnings: ${warned.join(", ")}.` : ""}${notes.length ? ` ${notes.join(" ")}` : ""}`;
      setStatus({ text: msg, tone: "ok" });
      announce(msg);
      void qc.invalidateQueries({ queryKey: keys.orgChart });
      void qc.invalidateQueries({ queryKey: keys.users });
      void qc.invalidateQueries({ queryKey: keys.teams });
      void qc.invalidateQueries({ queryKey: keys.requests });
    } catch (e) {
      setStatus({ text: friendlyError(e), tone: "bad" });
    } finally { setBusy(false); }
  };

  // ---- drag & drop ----
  const dragProps = (id: string, fromTeam: string | null) => ({
    draggable: id !== me.id,
    onDragStart: (e: DragEvent) => { setDrag({ id, fromTeam }); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const dropProps = (key: string, check: (d: Drag) => { text: string; warn: boolean } | string | null, onDrop: (d: Drag) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag || drag.id === key) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
      if (over?.key !== key) {
        const r = check(drag);
        const problem = typeof r === "string" ? r : r?.text ?? null;
        setOver({ key, problem, warn: typeof r === "object" && r !== null && r.warn });
      }
    },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o?.key === key ? null : o)); },
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); const d = drag; setDrag(null); setOver(null); if (d) onDrop(d); },
  });
  const overClass = (key: string) => (over?.key === key ? ` over${over.problem && !over.warn ? " bad" : ""}` : "");

  useEffect(() => { if (over?.problem) setStatus({ text: over.problem, tone: over.warn ? "" : "bad" }); }, [over]);

  const matches = (p: OrgPerson) => {
    const q = filter.trim().toLowerCase();
    return !q || p.displayName.toLowerCase().includes(q) || p.roles.some((r) => r.label.toLowerCase().includes(q));
  };
  const anyMatch = (id: string): boolean => matches(byId.get(id)!) || [...descendants(id)].some((d) => matches(byId.get(d)!));

  if (chart.isLoading || meta.isLoading) return <Loading />;
  if (chart.error) return <QueryError query={chart} message={friendlyError(chart.error)} />;
  if (!view) return null;

  const renderCard = (p: OrgPerson) => {
    const reports = descendants(p.id).size;
    const role = topRole(p);
    const problem = (d: Drag) => reportProblem(d.id, p.id);
    return (
      <div className={`orgnode${changedIds.has(p.id) ? " changed" : ""}${p.id === me.id ? " me" : ""}${drag?.id === p.id ? " dragging" : ""}${overClass(p.id)}`}
        tabIndex={0} data-id={p.id} aria-label={`${p.displayName}, ${role?.label ?? "no role"}`}
        onClick={() => setSelected(p.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p.id); } }}
        {...dragProps(p.id, null)} {...dropProps(p.id, problem, (d) => void moveTo(d.id, p.id))}>
        <span className="grip" aria-hidden="true">⋮⋮</span>
        <Avatar name={p.displayName} />
        <span className="who">
          <b>{p.displayName}</b>
          <small>{role?.label ?? "No role"}{p.team?.asLead ? ` · leads ${p.team.name}` : ""}{p.id === me.id ? " · you" : ""}</small>
        </span>
        {role && <span className="lvl" title="Ladder level">L{role.level}</span>}
        {reports > 0 && <span className="count">{reports} below</span>}
        {reports > 0 && (
          <button type="button" className="toggle" aria-label={`${collapsed.has(p.id) ? "Expand" : "Collapse"} ${p.displayName}`}
            onClick={(e) => { e.stopPropagation(); setCollapsed((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; }); }}>
            {collapsed.has(p.id) ? "▸" : "▾"}
          </button>
        )}
      </div>
    );
  };
  const renderTeam = (teamId: string) => {
    const t = view.teams.find((x) => x.id === teamId)!;
    const members = people.filter((p) => p.team?.id === teamId && !p.team.asLead);
    return (
      <div className={`orgteam${overClass(`team:${teamId}`)}`} {...dropProps(`team:${teamId}`, (d) => joinProblem(d.id, teamId), (d) => joinTeam(d.id, teamId))}>
        <div className="teamhead"><span className="tag team">Team</span>{t.name} · {members.length} {members.length === 1 ? "member" : "members"}</div>
        <div className="chips">
          {members.map((m) => (
            <span key={m.id} className={`chip${changedIds.has(m.id) ? " changed" : ""}`} onClick={(e) => { e.stopPropagation(); setSelected(m.id); }}>
              <Avatar name={m.displayName} />{m.displayName}
            </span>
          ))}
          {members.length === 0 && <span className="muted">No members yet. Drop unassigned recruiters here.</span>}
        </div>
      </div>
    );
  };
  const renderBranch = (p: OrgPerson): ReactElement | null => {
    const kids = (children.get(p.id) ?? []).filter((k) => anyMatch(k.id));
    if (!matches(p) && kids.length === 0) return null;
    return (
      <li key={p.id} className="orgitem">
        {renderCard(p)}
        {p.team?.asLead && renderTeam(p.team.id)}
        {kids.length > 0 && !collapsed.has(p.id) && <ul>{kids.map(renderBranch)}</ul>}
      </li>
    );
  };
  const roots = (children.get(null) ?? []).filter((p) => anyMatch(p.id));
  const unassigned = people.filter((p) => !p.team && isRecruiter(p, recruiterKeys));
  const sel = selected ? byId.get(selected) ?? null : null;

  return (
    <>
      <div className="toolbar">
        <p className="hint">Drag a card onto its new manager, or an unassigned recruiter onto a team. Hierarchy scope follows the reporting line; roles don't change. Nothing is saved until you apply.</p>
        <input type="search" className="push" placeholder="Find a person" aria-label="Find a person" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn" onClick={() => setCollapsed(new Set())}>Expand all</button>
      </div>
      <div className="orglayout">
        <section className="orgchart" aria-label="Org chart">
          <p className="hint tip">Keyboard: select a card with Enter, then use “Reports to” in the panel.</p>
          <ul className="orgtree">{roots.map(renderBranch)}</ul>
          <div className="orgbins">
            <div className={`orgbin${overClass("bin:nomanager")}`} {...dropProps("bin:nomanager", (d) => reportProblem(d.id, null), (d) => void moveTo(d.id, null))}>
              <h3>No manager</h3>
              <p className="muted">Drop anyone here to clear their reporting line.</p>
            </div>
            <div className="orgbin">
              <h3>Unassigned recruiters</h3>
              <div className="chips">
                {unassigned.map((p) => (
                  <span key={p.id} className={`chip${changedIds.has(p.id) ? " changed" : ""}${drag?.id === p.id ? " dragging" : ""}`} {...dragProps(p.id, null)}
                    onClick={() => setSelected(p.id)}>
                    <Avatar name={p.displayName} />{p.displayName}
                  </span>
                ))}
                {unassigned.length === 0 && <span className="muted">Everyone is in a team.</span>}
              </div>
            </div>
          </div>
        </section>

        <aside className="orgside">
          <section aria-labelledby="oc-pending">
            <h3 id="oc-pending">Pending changes{changes.length ? ` (${changes.length})` : ""}</h3>
            {changes.length === 0 ? <p className="muted">Nothing yet. Every drop becomes one line here; apply them together.</p> : (
              <ul className="orgchanges" aria-label="Pending changes">
                {changes.map((c, i) => (
                  <li key={`${c.kind}-${c.userId}`}>
                    <span>{describe(c, byId, view)}</span>
                    {c.kind === "manager" && c.preview && (c.preview.loses.length > 0 || c.preview.gains.length > 0) && (
                      <small className="muted">
                        {c.preview.loses.length > 0 && <>Loses: {c.preview.loses.map((x) => x.displayName).join(", ")}. </>}
                        {c.preview.gains.length > 0 && <>Gains: {c.preview.gains.map((x) => x.displayName).join(", ")}.</>}
                      </small>
                    )}
                    {c.kind === "manager" && c.preview?.warnings.includes("ladder_level") && <small className="warntext">Below on the ladder.</small>}
                    <button type="button" className="btn sm" aria-label={`Undo change ${i + 1}`} onClick={() => setChanges((cs) => cs.filter((x) => x !== c))}>Undo</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              <button className="btn" onClick={() => { setChanges([]); setStatus({ text: "Discarded.", tone: "" }); }} disabled={!changes.length || busy}>Discard</button>
              <button className="btn primary" onClick={apply} disabled={!changes.length || busy}>{busy ? "Applying…" : "Apply changes"}</button>
            </div>
            <p className={`orgstatus ${status.tone}`} aria-live="polite" data-testid="orgstatus">{status.text}</p>
          </section>

          <section aria-labelledby="oc-person">
            <h3 id="oc-person">Selected person</h3>
            {!sel ? <p className="muted">Select a card to change their manager, team or role.</p> : (
              <PersonPanel person={sel} byId={byId} descendants={descendants(sel.id)} teams={view.teams} me={me.id}
                recruiter={isRecruiter(sel, recruiterKeys)} ladder={(meta.data?.roles ?? []).filter((r) => r.track === topRole(sel)?.track).sort((a, b) => b.level - a.level)}
                onManager={(m) => void moveTo(sel.id, m)} onTeam={(t) => joinTeam(sel.id, t)} onPromote={() => promote(sel.id)} />
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function PersonPanel({ person: p, byId, descendants, teams, me, recruiter, ladder, onManager, onTeam, onPromote }: {
  person: OrgPerson; byId: Map<string, OrgPerson>; descendants: Set<string>; teams: OrgChart["teams"]; me: string; recruiter: boolean;
  ladder: { key: string; label: string; level: number; restricted: boolean }[];
  onManager: (managerId: string | null) => void; onTeam: (teamId: string) => void; onPromote: () => void;
}) {
  const role = topRole(p);
  const next = role ? ladder.filter((r) => r.level > role.level).at(-1) : undefined;
  const candidates = [...byId.values()].filter((x) => x.id !== p.id && !descendants.has(x.id)).sort((a, b) => level(b) - level(a) || a.displayName.localeCompare(b.displayName));
  const locked = p.id === me;
  return (
    <div className="orgperson">
      <div className="orgnode static"><Avatar name={p.displayName} /><span className="who"><b>{p.displayName}</b><small>{role?.label ?? "No role"}{p.designation ? ` · ${p.designation}` : ""}</small></span></div>
      <div className="field">
        <label htmlFor="oc-manager">Reports to</label>
        <select id="oc-manager" value={p.managerId ?? ""} disabled={locked} onChange={(e) => onManager(e.target.value || null)}>
          <option value="">Nobody</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName} · {topRole(c)?.label ?? "no role"} (L{level(c)}){level(c) <= level(p) ? " — same or lower level" : ""}</option>
          ))}
        </select>
        {locked && <small className="hint fieldhint">You can't change your own reporting line.</small>}
      </div>
      {recruiter && !p.team && (
        <div className="field">
          <label htmlFor="oc-team">Team</label>
          <select id="oc-team" value="" onChange={(e) => { if (e.target.value) onTeam(e.target.value); }}>
            <option value="">Pick a team…</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      {p.team && <p className="muted">{p.team.asLead ? `Leads ${p.team.name}.` : `Member of ${p.team.name}. Moving between teams is done from the Teams tab (candidates are reassigned).`}</p>}
      {ladder.length > 0 && (
        <ul className="orgladder" aria-label="Ladder">
          {ladder.map((r) => <li key={r.key} className={r.key === role?.key ? "current" : ""}><span>{r.label}{r.key === role?.key ? " · current" : ""}</span><span className="lvl">L{r.level}</span></li>)}
        </ul>
      )}
      {next && !locked && <button className="btn sm primary" onClick={onPromote}>Promote to {next.label}</button>}
    </div>
  );
}

/** The chart with the pending changes applied, for rendering. */
function applyLocally(data: OrgChart | undefined, changes: Change[]): OrgChart | undefined {
  if (!data) return undefined;
  const people = data.people.map((p) => ({ ...p }));
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const c of changes) {
    const p = byId.get(c.userId); if (!p) continue;
    if (c.kind === "manager") p.managerId = c.managerId;
    else if (c.kind === "team") { const t = data.teams.find((x) => x.id === c.teamId); if (t) p.team = { id: t.id, name: t.name, asLead: false }; }
  }
  return { people, teams: data.teams };
}

function describe(c: Change, byId: Map<string, OrgPerson>, view: OrgChart): string {
  const name = byId.get(c.userId)?.displayName ?? c.userId;
  if (c.kind === "manager") {
    const to = c.managerId ? byId.get(c.managerId)?.displayName ?? c.managerId : "nobody";
    const from = c.previous ? byId.get(c.previous)?.displayName ?? c.previous : "nobody";
    return `${name}: reports to ${to} (was ${from}).`;
  }
  if (c.kind === "team") return `${name} joins ${view.teams.find((t) => t.id === c.teamId)?.name ?? "a team"}.`;
  return `${name}: promote ${c.from} → ${c.to}.`;
}
