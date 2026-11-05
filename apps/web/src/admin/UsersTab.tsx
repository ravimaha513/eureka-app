import { useEffect, useId, useMemo, useState } from "react";
import { Phone as PhoneIcon, X } from "lucide-react";
import { Person } from "../shell/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { can } from "../api";
import { adminApi, departmentLabel, type AdminUser, type BulkReport, type Department, type UserRole } from "./adminApi";
import { csvToRows, tableToRows, type BulkRow } from "./csv";
import { isXlsx, readUserSheet } from "./xlsx";
import { saveBlob } from "../lib/download";
import { useSearchParams } from "../lib/router";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { Menu } from "../ui/Menu";
import { friendlyError, skipReason } from "./errors";
import { departmentOptions, keys, useAccess, useDepartments, useMeta, usePeople } from "./shared";
import { Pager, useCursorPager } from "../ui/Pager";
import { useAuthMethods } from "../shell/useAuthMethods";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

const PAGE_SIZE = 50;

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Users filters live in the address bar (`/access?team=none&status=active`), so other tabs can open Users filtered. */
export const USER_FILTER_KEYS = ["q", "status", "dept", "team", "role", "loc"] as const;
export type UserFilterKey = (typeof USER_FILTER_KEYS)[number];

type Modal =
  | { kind: "create" }
  | { kind: "bulk" }
  | { kind: "grant"; user: AdminUser }
  | { kind: "manager"; user: AdminUser }
  | { kind: "department"; user: AdminUser }
  | { kind: "departments" }
  | { kind: "deactivate"; user: AdminUser }
  | { kind: "password"; user: AdminUser }
  | { kind: "invite"; user: AdminUser }
  | { kind: "reactivate"; user: AdminUser }
  | { kind: "delete"; user: AdminUser }
  | { kind: "revoke"; user: AdminUser; role: UserRole }
  | { kind: "addToTeam" }
  | { kind: "moveToTeam" };

const roleText = (r: { label: string; locationName: string | null }) => (r.locationName ? `${r.label} · ${r.locationName}` : r.label);

export function UsersTab() {
  const { me, announce } = useAccess();
  const qc = useQueryClient();
  const meta = useMeta();
  const teams = useQuery({ queryKey: keys.teams, queryFn: adminApi.teams });
  const [f, setF] = useSearchParams(USER_FILTER_KEYS);
  const [searchInput, setSearchInput] = useState(f.q);
  const search = f.q;
  const status = f.status as "" | "active" | "inactive";
  const { dept: departmentId, team, role, loc: locationId } = f;
  // Kept across pages and filters, so a bulk team action can span several searches.
  const [selected, setSelected] = useState<Map<string, AdminUser>>(new Map());
  // Presentation only: the API checks team:move_member over both teams (AD-8).
  const canMove = can(me, "team:move_member");
  const departments = useDepartments();
  const pager = useCursorPager();
  const [modal, setModal] = useState<Modal | null>(null);
  const passwordLogin = usePasswordLogin();

  // Another tab (or back/forward) changed the search in the URL: show it in the box.
  useEffect(() => { setSearchInput((cur) => (cur.trim() === f.q ? cur : f.q)); }, [f.q]);
  useEffect(() => {
    // Only a changed search resets paging; otherwise the mount-time run would undo an early Next.
    if (searchInput.trim() === search) return;
    const t = setTimeout(() => { setF({ q: searchInput.trim() }); pager.reset(); }, 250);
    return () => clearTimeout(t);
  }, [searchInput, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (patch: Partial<Record<UserFilterKey, string>>) => { setF(patch); pager.reset(); };

  const q = useQuery({
    queryKey: [...keys.users, { search, status, departmentId, team, role, locationId, cursor: pager.cursor }],
    queryFn: () => adminApi.users({
      search, status: status || undefined, departmentId: departmentId || undefined, team: team || undefined,
      role: role || undefined, locationId: locationId || undefined, cursor: pager.cursor, limit: PAGE_SIZE,
    }),
    placeholderData: keepPreviousData,
  });

  const summary = useQuery({ queryKey: [...keys.users, "summary"], queryFn: adminApi.userSummary });
  const contact = q.data?.contactVisible === true;

  const close = () => setModal(null);
  const done = (msg: string) => {
    close();
    announce(msg);
    void qc.invalidateQueries({ queryKey: keys.users });
    void qc.invalidateQueries({ queryKey: keys.requests });
    void qc.invalidateQueries({ queryKey: keys.departments });
    void qc.invalidateQueries({ queryKey: keys.teams });
  };
  const fmt = (e: unknown) => friendlyError(e);
  const toggle = (u: AdminUser) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(u.id)) next.delete(u.id); else next.set(u.id, u);
    return next;
  });
  const pageRows = (q.data?.items ?? []).filter((u) => u.id !== me.id);
  const allOnPage = pageRows.length > 0 && pageRows.every((u) => selected.has(u.id));
  const togglePage = () => setSelected((prev) => {
    const next = new Map(prev);
    for (const u of pageRows) { if (allOnPage) next.delete(u.id); else next.set(u.id, u); }
    return next;
  });
  const bulkDone = (msg: string) => { setSelected(new Map()); done(msg); };

  const deptOpts = useMemo(() => departmentOptions(departments.data ?? []), [departments.data]);
  const deptName = departmentId === "none" ? "No department" : deptOpts.find((d) => d.id === departmentId)?.label ?? "Department";
  const teamName = team === "none" ? "No team" : teams.data?.items.find((t) => t.id === team)?.name ?? "Team";
  const locName = meta.data?.locations.find((l) => l.id === locationId)?.name ?? "Location";
  const chips: FilterChip[] = [
    departmentId && { key: "dept", label: deptName, onRemove: () => setFilter({ dept: "" }) },
    team && { key: "team", label: teamName, onRemove: () => setFilter({ team: "" }) },
    locationId && { key: "loc", label: locName, onRemove: () => setFilter({ loc: "" }) },
  ].filter(Boolean) as FilterChip[];
  const activeCount = [status, role, departmentId, team, locationId].filter(Boolean).length;
  const hasFilters = activeCount > 0 || Boolean(search);
  const clearAll = () => { setSearchInput(""); setFilter({ q: "", status: "", dept: "", team: "", role: "", loc: "" }); };
  const colCount = contact ? 8 : 7;

  return (
    <div className="ua-users">
      <div className="ua-tools">
        {summary.data && (
          <div className="ua-rolesum">
            <span className="ua-total"><b>{summary.data.active}</b> active{summary.data.inactive ? <> · <b>{summary.data.inactive}</b> inactive</> : null}</span>
            {/* Each count is also a Role filter toggle. */}
            <ul className="ua-rolelist" aria-label="Active users per role">
              {summary.data.roles.map((r) => (
                <li key={r.key}>
                  <button type="button" className="ua-rolechip" aria-pressed={role === r.key}
                    onClick={() => setFilter({ role: role === r.key ? "" : r.key })}>
                    {r.label}<span className="ua-rolecount">{r.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="ua-filterrow">
        <div className="ua-actions">
          <button className="btn" onClick={() => setModal({ kind: "departments" })}>Departments</button>
          <button className="btn" onClick={() => setModal({ kind: "bulk" })}>Import users</button>
          <button className="btn primary" onClick={() => setModal({ kind: "create" })}>New user</button>
        </div>
      <FilterBar label="Users filters"
        search={<div className="field inline fb-search"><label htmlFor="user-search">Search users</label>
          <input id="user-search" type="search" placeholder="Name or email" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} /></div>}
        primary={<>
          <div className="field inline">
            <label htmlFor="user-role">Role</label>
            <select id="user-role" value={role} onChange={(e) => setFilter({ role: e.target.value })}>
              <option value="">All</option>
              {meta.data?.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="user-status">Status</label>
            <select id="user-status" value={status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </div>
        </>}
        more={<>
          <div className="field inline">
            <label htmlFor="user-department">Department</label>
            <select id="user-department" value={departmentId} onChange={(e) => setFilter({ dept: e.target.value })}>
              <option value="">All</option>
              <option value="none">No department</option>
              {deptOpts.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="user-team">Team</label>
            <select id="user-team" value={team} onChange={(e) => setFilter({ team: e.target.value })}>
              <option value="">All</option>
              <option value="none">No team</option>
              {teams.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="user-location">Location</label>
            <select id="user-location" value={locationId} onChange={(e) => setFilter({ loc: e.target.value })}>
              <option value="">All</option>
              {meta.data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </>}
        chips={chips} activeCount={activeCount} hasFilters={hasFilters} onClear={clearAll}
        summaryEnd={q.data ? <span className="ua-count" aria-live="polite">{q.data.items.length}{q.data.nextCursor ? "+" : ""} {q.data.items.length === 1 && !q.data.nextCursor ? "user" : "users"}{pager.page > 1 ? ` on page ${pager.page}` : ""}</span> : null}
        selecting={selected.size > 0}
        selection={selected.size > 0 && (
          <div className="bulkbar" role="region" aria-label="Selected users">
            <div className="toolbar">
              <span><b>{selected.size} selected</b></span>
              <button className="btn" onClick={() => setModal({ kind: "addToTeam" })}>Add to team…</button>
              {canMove && <button className="btn" onClick={() => setModal({ kind: "moveToTeam" })}>Move to team…</button>}
              <button className="btn ghost" onClick={() => setSelected(new Map())}>Clear</button>
            </div>
          </div>
        )} />
      </div>

      <div className="card tablewrap listcard ua-tablecard">
        {q.isLoading ? <Loading /> : q.error ? <QueryError query={q} message={friendlyError(q.error)} /> : (
          <table className="dtable ua-table" aria-label="Users" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th className="c-sel"><input type="checkbox" aria-label="Select all users on this page" checked={allOnPage} onChange={togglePage} disabled={pageRows.length === 0} /></th>
              <th>User</th><th className="p2">Designation</th><th>Roles</th><th>Team</th>{contact && <th className="p3">Phone</th>}<th>Status</th>
              <th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data!.items.map((u) => {
                const self = u.id === me.id;
                const active = u.status === "active";
                return (
                  <tr key={u.id} aria-selected={selected.has(u.id) || undefined}>
                    <td className="c-sel">
                      {!self && <input type="checkbox" aria-label={`Select ${u.displayName}`} checked={selected.has(u.id)} onChange={() => toggle(u)} />}
                    </td>
                    <td className="c-primary ua-user"><Person name={u.displayName}><span className="ua-name"><b>{u.displayName}</b>{self && <span className="tag">you</span>}</span><small className="block">{u.email}</small></Person></td>
                    <td className="p2" data-label="Designation">{u.designation ?? "—"}
                      <small className="block ua-dept">{u.department ? departmentLabel(u.department) : "No department"}</small></td>
                    <td data-label="Roles">
                      <ul className="chips ua-roles" aria-label={`Roles of ${u.displayName}`}>
                        {u.roles.map((r) => (
                          <li key={`${r.key}:${r.locationId ?? ""}`} className="chip">
                            {roleText(r)}
                            {!self && (
                              <button type="button" className="chipx" aria-label={`Revoke ${roleText(r)} from ${u.displayName}`} title={`Revoke ${roleText(r)}`}
                                onClick={() => setModal({ kind: "revoke", user: u, role: r })}><X size={14} aria-hidden="true" /></button>
                            )}
                          </li>
                        ))}
                        {u.roles.length === 0 && <li className="muted">No roles</li>}
                      </ul>
                    </td>
                    <td data-label="Team" className="ua-team"><div>{u.teams.length ? u.teams.map((t) => <div key={t.id}>{t.name}{t.asLead && <span className="tag">lead</span>}</div>) : <span className="muted">No team</span>}
                      <small className="block ua-mgr">{u.manager ? <>Reports to <span>{u.manager.displayName}</span></> : "No manager"}</small></div></td>
                    {contact && <td className="p3" data-label="Phone">{u.phone ? <a className="contactlink" href={`tel:${u.phone}`}><PhoneIcon size={14} aria-hidden="true" />{u.phone}</a> : "—"}</td>}
                    <td className="c-badge"><span className={`badge ${u.status}`}>{active ? "Active" : "Inactive"}</span>{u.deletesAt && <small className="block muted">Deletes {shortDate(u.deletesAt)}</small>}</td>
                    <td className="c-act">
                      {self ? <span className="muted ua-self">Your own account: ask another admin.</span> : (
                        <span className="ua-act">
                          {active
                            ? <button className="btn sm" aria-label={`Grant role to ${u.displayName}`} onClick={() => setModal({ kind: "grant", user: u })}>Grant role</button>
                            : <button className="btn sm" aria-label={`Reactivate ${u.displayName}`} onClick={() => setModal({ kind: "reactivate", user: u })}>Reactivate</button>}
                          <Menu label={`More actions for ${u.displayName}`} items={[
                            passwordLogin && active && { label: "Email password link", onSelect: () => setModal({ kind: "invite", user: u }) },
                            passwordLogin && active && { label: "Set temporary password", onSelect: () => setModal({ kind: "password", user: u }) },
                            { label: "Set manager", onSelect: () => setModal({ kind: "manager", user: u }) },
                            { label: "Set department", onSelect: () => setModal({ kind: "department", user: u }) },
                            active
                              ? { label: "Deactivate…", danger: true, onSelect: () => setModal({ kind: "deactivate", user: u }) }
                              : { label: "Delete now…", danger: true, onSelect: () => setModal({ kind: "delete", user: u }) },
                          ]} />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {q.data!.items.length === 0 && <tr><td colSpan={colCount} className="empty">No users match.{hasFilters && <> <button type="button" className="linkbtn" onClick={clearAll}>Clear filters</button></>}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <Pager pager={pager} label="Users pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      {modal?.kind === "addToTeam" && (
        <AddToTeamDialog users={[...selected.values()]} onClose={close} onDone={bulkDone} />
      )}
      {modal?.kind === "moveToTeam" && (
        <MoveToTeamDialog users={[...selected.values()]} onClose={close} onDone={bulkDone} />
      )}

      {modal?.kind === "create" && <CreateUserDialog passwordLogin={passwordLogin} onClose={close} onDone={done} />}
      {modal?.kind === "bulk" && <BulkImportDialog onClose={close} onDone={(n) => done(`Created ${n} users.`)} />}
      {modal?.kind === "grant" && <GrantRoleDialog user={modal.user} onClose={close} onDone={done} />}
      {modal?.kind === "password" && <SetPasswordDialog user={modal.user} onClose={close}
        onDone={() => done(`Temporary password set for ${modal.user.displayName}. They must change it at first sign-in.`)} />}
      {modal?.kind === "invite" && (
        <ConfirmDialog title={`Email a password link to ${modal.user.displayName}?`} confirmLabel="Send link" formatError={fmt}
          action={() => adminApi.sendPasswordInvite(modal.user.id)} onClose={close}
          onDone={() => done(`Sent a set-password link to ${modal.user.email}.`)}>
          <p>They get an email with a one-time link to choose their own password and sign in. It expires in 72 hours.</p>
          <p>Any earlier link stops working. Their current password, if any, keeps working until they use the link.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "manager" && <ManagerDialog user={modal.user} onClose={close} onDone={done} />}
      {modal?.kind === "department" && <DepartmentDialog user={modal.user} departments={departments.data ?? []} onClose={close} onDone={done} />}
      {modal?.kind === "departments" && <DepartmentsDialog departments={departments.data ?? []} onClose={close} onChanged={(msg) => {
        announce(msg);
        void qc.invalidateQueries({ queryKey: keys.departments });
        void qc.invalidateQueries({ queryKey: keys.users });
        void qc.invalidateQueries({ queryKey: keys.teams });
      }} />}
      {modal?.kind === "deactivate" && (
        <ConfirmDialog title={`Deactivate ${modal.user.displayName}?`} confirmLabel="Deactivate" danger formatError={fmt}
          action={() => adminApi.deactivate(modal.user.id)} onClose={close}
          onDone={() => done(`${modal.user.displayName} is deactivated and signed out everywhere.`)}>
          <p><b>All of their sessions are revoked immediately</b>; they're signed out on every device.</p>
          <p>Their roles, team memberships and coach assignments end now. Reactivating restores the account only; roles must be granted again.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "reactivate" && (
        <ConfirmDialog title={`Reactivate ${modal.user.displayName}?`} confirmLabel="Reactivate" formatError={fmt}
          action={() => adminApi.reactivate(modal.user.id)} onClose={close}
          onDone={() => done(`${modal.user.displayName} is active again. Grant roles to restore access.`)}>
          <p>This restores the account only. Their previous roles and teams are not restored; grant them again.</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "delete" && (
        <ConfirmDialog title={`Delete ${modal.user.displayName} now?`} confirmLabel="Delete permanently" danger formatError={fmt}
          action={() => adminApi.deleteUser(modal.user.id)} onClose={close}
          onDone={() => done(`${modal.user.displayName} is deleted.`)}>
          <p><b>This can't be undone.</b> Their name, email, password, phone and birthday are erased, and the email can be used for a new account.</p>
          <p>Records they worked on (candidates, submissions, messages) stay and show “Deleted user”.
            {modal.user.deletesAt && <> Otherwise they're deleted automatically on {shortDate(modal.user.deletesAt)}.</>}</p>
        </ConfirmDialog>
      )}
      {modal?.kind === "revoke" && (
        <ConfirmDialog title={`Revoke ${roleText(modal.role)}?`} confirmLabel="Revoke role" danger formatError={fmt}
          action={() => adminApi.revokeRole(modal.user.id, modal.role.key, modal.role.locationId)} onClose={close}
          onDone={() => done(`Revoked ${roleText(modal.role)} from ${modal.user.displayName}.`)}>
          <p>{modal.user.displayName} loses this role immediately. No approval is needed to remove access.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Whether the server offers password sign-in (staging/local); then admins can set temporary passwords. */
function usePasswordLogin(): boolean {
  return useAuthMethods().data?.password === true;
}

function SetPasswordDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  return (
    <Dialog title={`Set password for ${user.displayName}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await adminApi.setPassword(user.id, pw); onDone(); }); }}>
        <div className="field"><label htmlFor="sp-pw">Temporary password</label>
          <input id="sp-pw" type="text" autoComplete="off" required minLength={10} maxLength={72} data-autofocus value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <p className="hint">10 to 72 characters with a letter and a number. Share it with them yourself; they must change it at first sign-in, and it signs them out everywhere. Not available for users with restricted roles.</p>
        <DialogActions onCancel={onClose} submitLabel="Set password" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function CreateUserDialog({ onClose, onDone, passwordLogin }: { onClose: () => void; onDone: (message: string) => void; passwordLogin: boolean }) {
  const meta = useMeta();
  const [f, setF] = useState({ email: "", displayName: "", designation: "", primaryLocationId: "", temporaryPassword: "" });
  const [invite, setInvite] = useState(true);
  const { busy, error, run } = useSubmit((e) => friendlyError(e, "createUser"));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title="New user" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const name = f.displayName.trim();
          const r = await adminApi.createUser({
            email: f.email.trim(), displayName: name,
            ...(f.designation.trim() ? { designation: f.designation.trim() } : {}),
            ...(f.primaryLocationId ? { primaryLocationId: f.primaryLocationId } : {}),
            ...(passwordLogin && invite ? { sendPasswordInvite: true } : {}),
            ...(passwordLogin && !invite && f.temporaryPassword ? { temporaryPassword: f.temporaryPassword } : {}),
          });
          onDone(r.invite === "sent" ? `Created ${name} and emailed them a link to set their password.`
            : r.invite === "failed" ? `Created ${name}, but the invite email could not be sent. Use Email invite to try again.`
            : `Created ${name}.`);
        });
      }}>
        <div className="field"><label htmlFor="nu-email">Email</label>
          <input id="nu-email" type="email" required data-autofocus value={f.email} onChange={set("email")} /></div>
        <div className="field"><label htmlFor="nu-name">Name</label>
          <input id="nu-name" required value={f.displayName} onChange={set("displayName")} /></div>
        <div className="field"><label htmlFor="nu-desig">Designation <span className="muted">(optional, a label only)</span></label>
          <input id="nu-desig" value={f.designation} onChange={set("designation")} /></div>
        <div className="field"><label htmlFor="nu-loc">Primary location <span className="muted">(optional)</span></label>
          <select id="nu-loc" value={f.primaryLocationId} onChange={set("primaryLocationId")}>
            <option value="">None</option>
            {meta.data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        {passwordLogin && (
          <label className="check"><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} /> Email them a link to set their password</label>
        )}
        {passwordLogin && !invite && (
          <div className="field"><label htmlFor="nu-pw">Temporary password <span className="muted">(optional; they change it at first sign-in)</span></label>
            <input id="nu-pw" type="text" autoComplete="off" minLength={10} maxLength={72} value={f.temporaryPassword} onChange={set("temporaryPassword")} /></div>
        )}
        <p className="hint">New users have no roles. Grant roles after creating them.</p>
        <DialogActions onCancel={onClose} submitLabel="Create user" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

const BULK_ERRORS: Record<string, string> = {
  invalid_email: "Not a valid email address",
  email_domain: "Email is not in the company's Google domain",
  name_required: "Name is missing",
  duplicate_in_file: "Email appears earlier in this file",
  unknown_location: "No location with this name",
  email_exists: "A user with this email already exists",
  unknown_role: "A role is not one of the roles in the template",
  duplicate_role: "The same role is listed twice",
  separation_of_duties: "Admin roles can't be combined with data roles",
  role_violates_admin_separation: "This role mixes admin and business permissions; fix the role first",
  location_required: "This role needs a location",
  location_not_allowed: "This role cannot have a location",
  role_already_held: "The user already holds this role",
  unknown_manager: "No user or row in this file has the manager's email",
  invalid_manager: "The manager is not an active user",
  manager_row_failed: "The manager's row in this file has a problem",
  cycle: "The reporting lines in this file form a loop",
  self_change: "You cannot make yourself their manager",
  unknown_team: "No team with this name",
  ambiguous_team: "More than one team has this name; set the team in Users & Access instead",
};

function BulkImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (created: number) => void }) {
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [report, setReport] = useState<BulkReport | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const { busy, error, run } = useSubmit((e) => friendlyError(e));

  async function onFile(file: File | undefined) {
    setRows(null); setReport(null); setFileError(undefined);
    if (!file) return;
    try {
      const parsed = isXlsx(file) ? tableToRows(await readUserSheet(file)) : csvToRows(await file.text());
      if (parsed.length === 0) throw new Error("The file has a header but no users.");
      if (parsed.length > 500) throw new Error("A file can have at most 500 users. Split it and import in parts.");
      setRows(parsed);
      setChecking(true);
      setReport(await adminApi.bulkCreateUsers({ dryRun: true, rows: parsed }));
    } catch (e) {
      setFileError(e instanceof Error && !("status" in e) ? e.message : friendlyError(e));
    } finally {
      setChecking(false);
    }
  }

  const [templateError, setTemplateError] = useState<string | undefined>();
  async function downloadTemplate() {
    setTemplateError(undefined);
    try {
      saveBlob(await adminApi.bulkTemplate(), "users-import-template.xlsx");
    } catch (e) {
      setTemplateError(friendlyError(e));
    }
  }
  const ready = !!report && report.failed === 0;
  const pending = report?.rows.reduce((n, r) => n + (r.roles ?? []).filter((x) => x.status === "pending_approval").length, 0) ?? 0;
  return (
    <Dialog title="Import users" onClose={onClose} className="xwide">
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!rows || !ready) return;
        void run(async () => {
          const res = await adminApi.bulkCreateUsers({ dryRun: false, rows });
          if (res.committed) onDone(res.created);
          else setReport(res); // the data changed since the preview
        });
      }}>
        <p className="hint">
          <button type="button" className="linkbtn" onClick={() => void downloadTemplate()}>Download the Excel template</button>,
          fill in one user per row (<b>email</b> and <b>name</b> required; <b>designation</b>, <b>location</b>, <b>manager email</b>, <b>team</b> and
          up to three <b>roles</b> from the dropdowns), then choose the file. A manager may be another row of the same file. CSV with the same columns works too. Restricted roles are sent for a second
          admin's approval. Nothing is created unless every row is valid.
        </p>
        {templateError && <p className="error" role="alert">{templateError}</p>}
        <div className="field"><label htmlFor="bulk-file">Excel or CSV file</label>
          <input id="bulk-file" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            data-autofocus onChange={(e) => void onFile(e.target.files?.[0])} /></div>
        {fileError && <p className="error" role="alert">{fileError}</p>}
        {checking && <p className="muted" role="status">Checking {rows?.length} rows…</p>}
        {report && (
          <>
            <p role="status">
              {report.failed === 0
                ? <>All {report.rows.length} rows are valid and ready to import.
                    {pending > 0 && <> {pending} restricted role{pending === 1 ? "" : "s"} will wait for a second admin's approval.</>}</>
                : <><b>{report.failed}</b> of {report.rows.length} rows have problems. Fix the file and choose it again; nothing has been created.</>}
            </p>
            <div className="tablewrap" style={{ maxHeight: "40vh", overflow: "auto" }}>
              <table aria-label="Import preview">
                <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Manager</th><th>Team</th><th>Roles</th><th>Result</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td><td>{r.displayName || "—"}</td><td>{r.email}</td><td>{r.manager ?? "—"}</td><td>{r.team ?? "—"}</td>
                      <td>{(r.roles ?? []).length === 0 ? "—" : (
                        <ul className="chips">{r.roles.map((x) => (
                          <li key={x.role} className="chip">{x.label}{x.status === "pending_approval" ? " · needs approval" : ""}</li>
                        ))}</ul>
                      )}</td>
                      <td>{r.status === "ok" ? "OK" : <span className="error">{BULK_ERRORS[r.error!] ?? r.error}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <DialogActions onCancel={onClose} submitLabel={ready ? `Create ${report!.rows.length} users` : "Create users"}
          busy={busy} error={error} disabled={!ready || checking} />
      </form>
    </Dialog>
  );
}

function GrantRoleDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: (msg: string) => void }) {
  const meta = useMeta();
  const [role, setRole] = useState("");
  const [locationId, setLocationId] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const noteId = useId();
  const selected = meta.data?.roles.find((r) => r.key === role);
  return (
    <Dialog title={`Grant a role to ${user.displayName}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        void run(async () => {
          const res = await adminApi.requestRole({ userId: user.id, role, ...(selected.locationBound ? { locationId } : {}) });
          onDone(res.status === "pending_approval"
            ? `Request to grant ${selected.label} to ${user.displayName} is waiting for a second approver.`
            : `Granted ${selected.label} to ${user.displayName}.`);
        });
      }}>
        {meta.isLoading ? <p className="muted">Loading roles…</p> : meta.error ? <p className="error" role="alert">{friendlyError(meta.error)}</p> : (
          <>
            <div className="field"><label htmlFor="gr-role">Role</label>
              <select id="gr-role" required data-autofocus value={role} aria-describedby={selected?.restricted ? noteId : undefined}
                onChange={(e) => { setRole(e.target.value); setLocationId(""); }}>
                <option value="" disabled>Choose a role…</option>
                {meta.data!.roles.map((r) => <option key={r.key} value={r.key}>{r.label}{r.restricted ? " (restricted)" : ""}</option>)}
              </select></div>
            {selected?.locationBound && (
              <div className="field"><label htmlFor="gr-loc">Location</label>
                <select id="gr-loc" required value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="" disabled>Choose a location…</option>
                  {meta.data!.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
            )}
            {selected?.restricted && meta.data!.singleAdminMode && (
              <p id={noteId} className="note">This is a restricted role. Single-admin mode is on, so it is granted immediately and recorded in the audit log.</p>
            )}
            {selected?.restricted && !meta.data!.singleAdminMode && (
              <p id={noteId} className="note warn">This is a restricted role, so it <b>needs a second approver</b>: another admin who is neither you nor {user.displayName}. It stays pending until approved (requests expire after 7 days).</p>
            )}
          </>
        )}
        <DialogActions onCancel={onClose} submitLabel={selected?.restricted && !meta.data?.singleAdminMode ? "Request approval" : "Grant role"} busy={busy} error={error}
          disabled={!selected || (selected.locationBound && !locationId)} />
      </form>
    </Dialog>
  );
}

function DepartmentDialog({ user, departments, onClose, onDone }: {
  user: AdminUser; departments: Department[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [departmentId, setDepartmentId] = useState(user.department?.id ?? "");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const options = departmentOptions(departments);
  return (
    <Dialog title={`Set department for ${user.displayName}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.setDepartment(user.id, departmentId || null);
          const label = options.find((d) => d.id === departmentId)?.label;
          onDone(label ? `${user.displayName} is now in ${label}.` : `${user.displayName} has no department now.`);
        });
      }}>
        <div className="field"><label htmlFor="dp-select">Department</label>
          <select id="dp-select" data-autofocus value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">No department</option>
            {options.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        <p className="hint">A label for filtering and reporting. It doesn't change what they can see or do; that comes from roles and reporting lines.</p>
        <DialogActions onCancel={onClose} submitLabel="Save department" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

/** Create and rename departments and sub-departments (two levels). */
function DepartmentsDialog({ departments, onClose, onChanged }: {
  departments: Department[]; onClose: () => void; onChanged: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const byId = new Map(departments.map((d) => [d.id, d]));
  const top = departments.filter((d) => !d.parentId);
  return (
    <Dialog title="Departments" onClose={onClose} wide>
      <p className="hint">Departments describe where people work (for example Sales › Interview Prep). They don't grant access.</p>
      {departments.length === 0 ? <p className="muted">No departments yet.</p> : (
        <ul className="members" aria-label="Departments" style={{ marginBlockEnd: "1rem" }}>
          {departmentOptions(departments).map((o) => {
            const d = byId.get(o.id)!;
            return (
              <li key={d.id} style={o.sub ? { paddingInlineStart: "1.5rem" } : undefined}>
                {editing?.id === d.id ? (
                  <form style={{ display: "flex", gap: "0.5rem", alignItems: "center" }} onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await adminApi.renameDepartment(d.id, editing.name.trim());
                      setEditing(null);
                      onChanged(`Renamed ${d.name} to ${editing.name.trim()}.`);
                    });
                  }}>
                    <label htmlFor="dpr-name" className="sr-only">New name for {d.name}</label>
                    <input id="dpr-name" required maxLength={120} data-autofocus value={editing.name} onChange={(e) => setEditing({ id: d.id, name: e.target.value })} />
                    <button className="btn sm primary" disabled={busy}>Save</button>
                    <button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span>{o.sub ? d.name : <b>{d.name}</b>}</span> <span className="muted">{d.userCount} {d.userCount === 1 ? "user" : "users"}</span>
                    <button className="btn sm" aria-label={`Rename ${d.name}`} onClick={() => setEditing({ id: d.id, name: d.name })}>Rename</button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.createDepartment({ name: name.trim(), ...(parentId ? { parentId } : {}) });
          const parent = parentId ? byId.get(parentId)?.name : undefined;
          onChanged(parent ? `Created ${parent} › ${name.trim()}.` : `Created ${name.trim()}.`);
          setName("");
        });
      }}>
        <div className="field"><label htmlFor="dp-name">New department</label>
          <input id="dp-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="dp-parent">Under <span className="muted">(optional, makes it a sub-department)</span></label>
          <select id="dp-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">None (top level)</option>
            {top.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Add department" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

function ManagerDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: (msg: string) => void }) {
  const people = usePeople();
  const [managerId, setManagerId] = useState(user.manager?.id ?? "");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const options = (people.data ?? []).filter((p) => p.id !== user.id);
  return (
    <Dialog title={`Set manager for ${user.displayName}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.setManager(user.id, managerId || null);
          const name = options.find((p) => p.id === managerId)?.displayName;
          onDone(name ? `${user.displayName} now reports to ${name}.` : `${user.displayName} has no manager now.`);
        });
      }}>
        <div className="field"><label htmlFor="mg-select">Manager</label>
          <select id="mg-select" data-autofocus value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={people.isLoading}>
            <option value="">No manager</option>
            {user.manager && !options.some((p) => p.id === user.manager!.id) && <option value={user.manager.id}>{user.manager.displayName}</option>}
            {options.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Save manager" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}

/** Adds the selected users to one team (POST /admin/teams/:id/members/bulk); shows who was skipped and why. */
function AddToTeamDialog({ users, onClose, onDone }: { users: AdminUser[]; onClose: () => void; onDone: (msg: string) => void }) {
  const teams = useQuery({ queryKey: keys.teams, queryFn: adminApi.teams });
  const [teamId, setTeamId] = useState("");
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[] | null>(null);
  const [summary, setSummary] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const name = teams.data?.items.find((t) => t.id === teamId)?.name ?? "";
  if (skipped) {
    return (
      <Dialog key="result" title={`Added to ${name}`} onClose={() => onDone(summary)}>
        <div className="dialogbody">
          <p>{summary}</p>
          <p>Skipped:</p>
          <ul>{skipped.map((x) => <li key={x.name}>{x.name}: {x.reason}</li>)}</ul>
        </div>
        <div className="actions"><button className="btn primary" data-autofocus onClick={() => onDone(summary)}>Done</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog key="form" title={`Add ${users.length} ${users.length === 1 ? "person" : "people"} to a team`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const res = await adminApi.addMembers(teamId, users.map((u) => u.id));
          const msg = `${res.added.length} added to ${name}.`;
          if (res.failed.length === 0) { onDone(msg); return; }
          setSummary(`${msg} ${res.failed.length} skipped.`);
          setSkipped(res.failed.map((f) => ({ name: users.find((u) => u.id === f.userId)?.displayName ?? "Unknown person", reason: skipReason(f.error) })));
        });
      }}>
        <p className="hint">People already in a team are skipped. Use “Move to team…” for them.</p>
        <div className="field"><label htmlFor="bt-team">Team</label>
          <select id="bt-team" required data-autofocus value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="" disabled>{teams.isLoading ? "Loading teams…" : "Choose a team…"}</option>
            {teams.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.lead.displayName})</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Add to team" busy={busy} error={error} disabled={!teamId} />
      </form>
    </Dialog>
  );
}

/**
 * Moves each selected member to one team (AD-8, one request per person). Their
 * candidates stay with the old team and go to its lead (the server default).
 * People in no team, or already in the target, are skipped.
 */
function MoveToTeamDialog({ users, onClose, onDone }: { users: AdminUser[]; onClose: () => void; onDone: (msg: string) => void }) {
  const teams = useQuery({ queryKey: keys.teams, queryFn: adminApi.teams });
  const [toTeamId, setToTeamId] = useState("");
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[] | null>(null);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const name = teams.data?.items.find((t) => t.id === toTeamId)?.name ?? "";
  if (skipped) {
    return (
      <Dialog key="result" title={`Moved to ${name}`} onClose={() => onDone(summary)}>
        <div className="dialogbody">
          <p>{summary}</p>
          {skipped.length > 0 && <><p>Skipped:</p><ul>{skipped.map((x) => <li key={x.name}>{x.name}: {x.reason}</li>)}</ul></>}
        </div>
        <div className="actions"><button className="btn primary" data-autofocus onClick={() => onDone(summary)}>Done</button></div>
      </Dialog>
    );
  }
  const submit = async () => {
    setBusy(true);
    let moved = 0, candidates = 0;
    const skip: { name: string; reason: string }[] = [];
    for (const u of users) {
      const from = u.teams.find((t) => !t.asLead);
      if (!from) { skip.push({ name: u.displayName, reason: "not in a team (use Add instead)" }); continue; }
      if (from.id === toTeamId) { skip.push({ name: u.displayName, reason: "already in this team" }); continue; }
      try {
        candidates += (await adminApi.moveMember(from.id, { userId: u.id, toTeamId })).movedCandidates;
        moved++;
      } catch (e) {
        skip.push({ name: u.displayName, reason: friendlyError(e) });
      }
    }
    setBusy(false);
    const msg = `${moved} moved to ${name}.${candidates ? ` ${candidates} candidate${candidates === 1 ? "" : "s"} stayed with their old teams' leads.` : ""}`;
    if (skip.length === 0) { onDone(msg); return; }
    setSummary(`${msg} ${skip.length} skipped.`);
    setSkipped(skip);
  };
  return (
    <Dialog key="form" title={`Move ${users.length} ${users.length === 1 ? "person" : "people"} to a team`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="hint">Their candidates stay with their old team and go to that team's lead.</p>
        <div className="field"><label htmlFor="bm-team">Move to team</label>
          <select id="bm-team" required data-autofocus value={toTeamId} onChange={(e) => setToTeamId(e.target.value)}>
            <option value="" disabled>{teams.isLoading ? "Loading teams…" : "Choose a team…"}</option>
            {teams.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.lead.displayName})</option>)}
          </select></div>
        <DialogActions onCancel={onClose} submitLabel="Move" busy={busy} disabled={!toTeamId} />
      </form>
    </Dialog>
  );
}
