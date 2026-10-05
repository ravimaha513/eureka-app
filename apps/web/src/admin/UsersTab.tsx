import { useEffect, useId, useMemo, useState } from "react";
import { Phone as PhoneIcon, Users as UsersIcon } from "lucide-react";
import { Person } from "../shell/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { adminApi, type AdminUser, type BulkReport, type UserRole } from "./adminApi";
import { CSV_TEMPLATE, csvToRows, type BulkRow } from "./csv";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "./Dialog";
import { friendlyError } from "./errors";
import { keys, useAccess, useMeta, usePeople } from "./shared";

const PAGE_SIZE = 50;

type Modal =
  | { kind: "create" }
  | { kind: "bulk" }
  | { kind: "grant"; user: AdminUser }
  | { kind: "manager"; user: AdminUser }
  | { kind: "deactivate"; user: AdminUser }
  | { kind: "password"; user: AdminUser }
  | { kind: "reactivate"; user: AdminUser }
  | { kind: "revoke"; user: AdminUser; role: UserRole };

const TINTS = ["indigo", "teal", "amber", "rose", "violet", "sky"] as const;

const roleText = (r: { label: string; locationName: string | null }) => (r.locationName ? `${r.label} · ${r.locationName}` : r.label);

export function UsersTab() {
  const { me, announce } = useAccess();
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "active" | "inactive">("");
  // Cursor stack: cursors[i] is the cursor that loads page i (page 0 has none).
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const [modal, setModal] = useState<Modal | null>(null);
  const passwordLogin = usePasswordLogin();

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setCursors([null]); }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const q = useQuery({
    queryKey: [...keys.users, { search, status, cursor: cursors[page] }],
    queryFn: () => adminApi.users({ search, status: status || undefined, cursor: cursors[page], limit: PAGE_SIZE }),
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
  };
  const fmt = (e: unknown) => friendlyError(e);

  return (
    <>
      {summary.data && summary.data.roles.length > 0 && (
        <ul className="tiles rolecounts" aria-label="Active users per role">
          {summary.data.roles.map((r, i) => (
            <li key={r.key} className="tile card">
              <span className="tilehead"><span className={`tileicon tint-${TINTS[i % TINTS.length]}`} aria-hidden="true"><UsersIcon size={18} /></span>
                <span className="tilelabel">{r.label}</span></span>
              <span className="tilevalue">{r.count}</span>
              <span className="tilehint">{r.count === 1 ? "active user" : "active users"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="toolbar">
        <div className="field inline">
          <label htmlFor="user-search">Search users</label>
          <input id="user-search" type="search" placeholder="Name or email" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <div className="field inline">
          <label htmlFor="user-status">Status</label>
          <select id="user-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setCursors([null]); }}>
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
        </div>
        <button className="btn push" onClick={() => setModal({ kind: "bulk" })}>Import users</button>
        <button className="btn primary" onClick={() => setModal({ kind: "create" })}>New user</button>
      </div>

      <div className="card">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{friendlyError(q.error)}</p> : (
          <div className="tablewrap"><table aria-label="Users" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>User</th><th>Designation</th>{contact && <th>Phone</th>}<th>Status</th><th>Roles</th><th>Teams</th><th>Manager</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data!.items.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id}>
                    <td><Person name={u.displayName}><b>{u.displayName}</b>{self && <span className="tag">you</span>}<small className="block">{u.email}</small></Person></td>
                    <td>{u.designation ?? "—"}</td>
                    {contact && <td>{u.phone ? <a className="contactlink" href={`tel:${u.phone}`}><PhoneIcon size={14} aria-hidden="true" />{u.phone}</a> : "—"}</td>}
                    <td><span className={`badge ${u.status}`}>{u.status}</span></td>
                    <td>
                      <ul className="chips" aria-label={`Roles of ${u.displayName}`}>
                        {u.roles.map((r) => (
                          <li key={`${r.key}:${r.locationId ?? ""}`} className="chip">
                            {roleText(r)}
                            {!self && (
                              <button className="chipx" aria-label={`Revoke ${roleText(r)} from ${u.displayName}`}
                                onClick={() => setModal({ kind: "revoke", user: u, role: r })}>×</button>
                            )}
                          </li>
                        ))}
                        {u.roles.length === 0 && <li className="muted">No roles</li>}
                      </ul>
                    </td>
                    <td>{u.teams.length ? u.teams.map((t) => <div key={t.id}>{t.name}{t.asLead && <span className="tag">lead</span>}</div>) : "—"}</td>
                    <td>{u.manager?.displayName ?? "—"}</td>
                    <td className="rowactions">
                      {self ? <span className="muted">Your own account: ask another admin.</span> : (
                        <>
                          {u.status === "active" && <button className="btn sm" aria-label={`Grant role to ${u.displayName}`} onClick={() => setModal({ kind: "grant", user: u })}>Grant role</button>}
                          {passwordLogin && u.status === "active" && <button className="btn sm" aria-label={`Set password for ${u.displayName}`} onClick={() => setModal({ kind: "password", user: u })}>Set password</button>}
                          <button className="btn sm" aria-label={`Set manager for ${u.displayName}`} onClick={() => setModal({ kind: "manager", user: u })}>Manager</button>
                          {u.status === "active"
                            ? <button className="btn sm danger" aria-label={`Deactivate ${u.displayName}`} onClick={() => setModal({ kind: "deactivate", user: u })}>Deactivate</button>
                            : <button className="btn sm" aria-label={`Reactivate ${u.displayName}`} onClick={() => setModal({ kind: "reactivate", user: u })}>Reactivate</button>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {q.data!.items.length === 0 && <tr><td colSpan={contact ? 8 : 7} className="empty">No users match.</td></tr>}
            </tbody>
          </table></div>
        )}
      </div>
      <nav className="pager" aria-label="Users pages">
        <button className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</button>
        <span>Page {page + 1}</span>
        <button className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
          onClick={() => q.data?.nextCursor && setCursors((c) => [...c, q.data!.nextCursor])}>Next</button>
      </nav>

      {modal?.kind === "create" && <CreateUserDialog passwordLogin={passwordLogin} onClose={close} onDone={(name) => done(`Created ${name}.`)} />}
      {modal?.kind === "bulk" && <BulkImportDialog onClose={close} onDone={(n) => done(`Created ${n} users.`)} />}
      {modal?.kind === "grant" && <GrantRoleDialog user={modal.user} onClose={close} onDone={done} />}
      {modal?.kind === "password" && <SetPasswordDialog user={modal.user} onClose={close}
        onDone={() => done(`Temporary password set for ${modal.user.displayName}. They must change it at first sign-in.`)} />}
      {modal?.kind === "manager" && <ManagerDialog user={modal.user} onClose={close} onDone={done} />}
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
      {modal?.kind === "revoke" && (
        <ConfirmDialog title={`Revoke ${roleText(modal.role)}?`} confirmLabel="Revoke role" danger formatError={fmt}
          action={() => adminApi.revokeRole(modal.user.id, modal.role.key, modal.role.locationId)} onClose={close}
          onDone={() => done(`Revoked ${roleText(modal.role)} from ${modal.user.displayName}.`)}>
          <p>{modal.user.displayName} loses this role immediately. No approval is needed to remove access.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Whether the server offers password sign-in (staging/local); then admins can set temporary passwords. */
function usePasswordLogin(): boolean {
  const m = useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<{ password: boolean }>("/api/auth/methods").catch(() => null),
    staleTime: Infinity,
  });
  return m.data?.password === true;
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

function CreateUserDialog({ onClose, onDone, passwordLogin }: { onClose: () => void; onDone: (name: string) => void; passwordLogin: boolean }) {
  const meta = useMeta();
  const [f, setF] = useState({ email: "", displayName: "", designation: "", primaryLocationId: "", temporaryPassword: "" });
  const { busy, error, run } = useSubmit((e) => friendlyError(e, "createUser"));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title="New user" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.createUser({
            email: f.email.trim(), displayName: f.displayName.trim(),
            ...(f.designation.trim() ? { designation: f.designation.trim() } : {}),
            ...(f.primaryLocationId ? { primaryLocationId: f.primaryLocationId } : {}),
            ...(passwordLogin && f.temporaryPassword ? { temporaryPassword: f.temporaryPassword } : {}),
          });
          onDone(f.displayName.trim());
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
      const parsed = csvToRows(await file.text());
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

  const template = useMemo(() => URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: "text/csv" })), []);
  useEffect(() => () => URL.revokeObjectURL(template), [template]);
  const ready = !!report && report.failed === 0;
  return (
    <Dialog title="Import users from CSV" onClose={onClose}>
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
          One user per row with the columns <b>email</b>, <b>name</b>, and optionally <b>designation</b> and <b>location</b> (a location name).{" "}
          <a href={template} download="users-template.csv">Download a template</a>. New users have no roles; grant them afterwards.
          Nothing is created unless every row is valid.
        </p>
        <div className="field"><label htmlFor="bulk-file">CSV file</label>
          <input id="bulk-file" type="file" accept=".csv,text/csv" data-autofocus onChange={(e) => void onFile(e.target.files?.[0])} /></div>
        {fileError && <p className="error" role="alert">{fileError}</p>}
        {checking && <p className="muted" role="status">Checking {rows?.length} rows…</p>}
        {report && (
          <>
            <p role="status">
              {report.failed === 0
                ? <>All {report.rows.length} rows are valid and ready to import.</>
                : <><b>{report.failed}</b> of {report.rows.length} rows have problems. Fix the file and choose it again; nothing has been created.</>}
            </p>
            <div className="tablewrap" style={{ maxHeight: "40vh", overflow: "auto" }}>
              <table aria-label="Import preview">
                <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Result</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td><td>{r.displayName || "—"}</td><td>{r.email}</td>
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
            {selected?.restricted && (
              <p id={noteId} className="note warn">This is a restricted role, so it <b>needs a second approver</b>: another admin who is neither you nor {user.displayName}. It stays pending until approved (requests expire after 7 days).</p>
            )}
          </>
        )}
        <DialogActions onCancel={onClose} submitLabel={selected?.restricted ? "Request approval" : "Grant role"} busy={busy} error={error}
          disabled={!selected || (selected.locationBound && !locationId)} />
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
