import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  adminApi, SCOPE_LABELS, TRAIT_LABELS, trackLabel,
  type PermissionCatalog, type PermissionDef, type RoleDef, type RoleTraits, type RoleViolation,
} from "./adminApi";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Drawer } from "../sales/ui";
import { friendlyError } from "./errors";
import { departmentOptions, keys, useAccess, useDepartments } from "./shared";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";

const TRAIT_KEYS = Object.keys(TRAIT_LABELS) as (keyof RoleTraits)[];

/**
 * Role definitions (docs/roles-api.md): the built-in roles are templates; an admin
 * clones one into a custom role and edits its grants (permission × scope), traits
 * and ladder position. The API enforces every rule; this screen explains them.
 */
export function RolesTab() {
  const { announce } = useAccess();
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const roles = useQuery({ queryKey: [...keys.roles, showArchived], queryFn: () => adminApi.roles(showArchived).then((r) => r.items) });
  const permissions = useQuery({ queryKey: keys.permissions, queryFn: adminApi.permissions, staleTime: 30 * 60_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [cloneFrom, setCloneFrom] = useState<RoleDef | null>(null);

  const refresh = (msg: string) => {
    announce(msg);
    void qc.invalidateQueries({ queryKey: keys.roles });
    void qc.invalidateQueries({ queryKey: keys.meta });
  };

  const byTrack = useMemo(() => {
    const groups = new Map<string, RoleDef[]>();
    for (const r of roles.data ?? []) groups.set(r.track, [...(groups.get(r.track) ?? []), r]);
    return [...groups.entries()];
  }, [roles.data]);
  const current = roles.data?.find((r) => r.key === selected) ?? null;

  return (
    <>
      <div className="toolbar">
        <p className="hint">Built-in roles are templates: clone one, then edit the copy's permissions, traits and ladder position. Nobody's access changes until a role is granted.</p>
        <label className="check push"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>
      <RoleViolations canOpen={(r) => !r.archived || showArchived} onOpen={setSelected} />
      <UserViolations />
      {roles.isLoading || permissions.isLoading ? <Loading />
        : roles.error ? <QueryError query={roles} message={friendlyError(roles.error)} />
        : permissions.error ? <QueryError query={permissions} message={friendlyError(permissions.error)} />
        : byTrack.map(([track, items]) => (
          <section key={track} className="rolegroup" aria-labelledby={`roles-${track}`}>
            <h3 id={`roles-${track}`} className="sectiontitle">{trackLabel(track)}</h3>
            <div className="tablewrap">
              <table className="mini" aria-label={`${trackLabel(track)} roles`}>
                <thead><tr><th>Level</th><th>Role</th><th>Traits</th><th>Holders</th><th>Permissions</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.key}>
                      <td>{r.level}</td>
                      <td>
                        <b>{r.label}</b>
                        {r.isSystem && <span className="tag" title="Built-in template; cannot be edited">Built-in</span>}
                        {r.restricted && <span className="tag" title="Granting it needs a second admin">Restricted</span>}
                        {r.archivedAt && <span className="tag">Archived</span>}
                        {r.classification === "admin_compatible_only" && <span className="tag" title="Can be held together with an admin role">Admin-compatible</span>}
                        {r.department && <span className="muted"> · {r.department.name}</span>}
                      </td>
                      <td>{TRAIT_KEYS.filter((t) => r.traits[t]).map((t) => TRAIT_LABELS[t].label).join(", ") || <span className="muted">—</span>}</td>
                      <td>{r.holders}</td>
                      <td>{Object.keys(r.grants).length}</td>
                      <td className="rowactions">
                        <button className="btn sm" onClick={() => setSelected(r.key)}>Open</button>
                        {!r.archivedAt && <button className="btn sm" onClick={() => setCloneFrom(r)}>Clone</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

      {current && permissions.data && (
        <RoleDrawer role={current} catalog={permissions.data} suspended={cloneFrom !== null}
          onClose={() => setSelected(null)} onClone={() => setCloneFrom(current)} onChanged={refresh} />
      )}
      {cloneFrom && (
        <CloneRoleDialog source={cloneFrom} onClose={() => setCloneFrom(null)}
          onDone={(key, msg) => { setCloneFrom(null); setSelected(key); refresh(msg); }} />
      )}
    </>
  );
}

/**
 * Roles that break admin/data separation (GET /admin/roles/violations, R-01): legacy roles are reported,
 * never stripped. Nothing renders while there are none.
 */
export function RoleViolations({ canOpen, onOpen }: { canOpen: (r: RoleViolation) => boolean; onOpen: (key: string) => void }) {
  const q = useQuery({ queryKey: [...keys.roles, "violations"], queryFn: () => adminApi.roleViolations().then((r) => r.items) });
  if (q.error) return <QueryError query={q} message={`We couldn't check roles for admin separation. ${friendlyError(q.error)}`} />;
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <section className="rolewarn" aria-labelledby="role-violations">
      <h3 id="role-violations" className="sectiontitle">
        {items.length === 1 ? "1 role breaks" : `${items.length} roles break`} admin separation
      </h3>
      <p className="hint">
        Administrator roles may hold only Users &amp; Access permissions, and business roles may not hold them.
        These roles were set up before the rule. Their holders keep their access; remove the listed permissions to fix each role.
      </p>
      <div className="tablewrap">
        <table className="mini" aria-label="Roles that break admin separation">
          <thead><tr><th>Role</th><th>Problem</th><th>Holders</th><th>Permissions to remove</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.key}>
                <td>
                  <b>{r.label}</b>
                  {r.isSystem && <span className="tag">Built-in</span>}
                  {r.archived && <span className="tag">Archived</span>}
                </td>
                <td>{r.admin ? "Administrator role with business permissions" : "Business role with administrator permissions"}</td>
                <td>{r.holders}</td>
                <td>{r.permissions.map((p, i) => <span key={p}>{i > 0 && ", "}<code>{p}</code></span>)}</td>
                <td className="rowactions">
                  {canOpen(r) && <button type="button" className="btn sm" onClick={() => onOpen(r.key)} aria-label={`Open ${r.label}`}>Open</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * People who hold admin and data roles together (GET /admin/users/violations, R-01): set up before the rule,
 * reported here, never stripped. Nothing renders while there are none.
 */
export function UserViolations() {
  const q = useQuery({ queryKey: [...keys.users, "violations"], queryFn: () => adminApi.userViolations().then((r) => r.items) });
  if (q.error) return <QueryError query={q} message={`We couldn't check people for admin separation. ${friendlyError(q.error)}`} />;
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <section className="rolewarn" aria-labelledby="user-violations">
      <h3 id="user-violations" className="sectiontitle">
        {items.length === 1 ? "1 person holds" : `${items.length} people hold`} admin and data roles together
      </h3>
      <p className="hint">
        Admin roles can't be combined with data roles. These grants were made before the rule and still work;
        revoke one side in Users, and give the other work to a separate account.
      </p>
      <div className="tablewrap">
        <table className="mini" aria-label="People holding admin and data roles">
          <thead><tr><th>Person</th><th>Admin roles</th><th>Data roles</th></tr></thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td><b>{u.displayName}</b>{u.status !== "active" && <span className="tag">{u.status}</span>}</td>
                <td>{u.adminRoles.join(", ")}</td>
                <td>{u.dataRoles.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CloneRoleDialog({ source, onClose, onDone }: { source: RoleDef; onClose: () => void; onDone: (key: string, msg: string) => void }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState(source.department?.id ?? "");
  const departments = useDepartments();
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const trimmed = label.trim();
  return (
    <Dialog title={`New role from ${source.label}`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const { key } = await adminApi.createRole({
            label: trimmed, cloneFrom: source.key,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(departmentId ? { departmentId } : {}),
          });
          onDone(key, `Created ${trimmed} from ${source.label}.`);
        });
      }}>
        <p className="hint">The new role starts with {source.label}'s {Object.keys(source.grants).length} permissions, traits and ladder position. You can change them afterwards.</p>
        <div className="field"><label htmlFor="nr-label">Role name</label>
          <input id="nr-label" required maxLength={80} data-autofocus value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <div className="field"><label htmlFor="nr-desc">Description <span className="muted">(optional)</span></label>
          <input id="nr-desc" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field"><label htmlFor="nr-dept">Business unit <span className="muted">(optional)</span></label>
          <select id="nr-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Whole organisation</option>
            {departmentOptions(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <small className="hint fieldhint">A role tied to a business unit can only be granted to people in that department (or its sub-departments).</small></div>
        <DialogActions onCancel={onClose} submitLabel="Create role" busy={busy} error={error} disabled={!trimmed} />
      </form>
    </Dialog>
  );
}

/** One role: details and traits on top, the permission grid below. Built-in roles are read-only. */
function RoleDrawer({ role, catalog, suspended, onClose, onClone, onChanged }: {
  role: RoleDef; catalog: PermissionCatalog; suspended: boolean;
  onClose: () => void; onClone: () => void; onChanged: (msg: string) => void;
}) {
  const editable = !role.isSystem && !role.archivedAt;
  const held = role.holders > 0;
  const departments = useDepartments();
  const details = useSubmit((e) => friendlyError(e));
  const grid = useSubmit((e) => friendlyError(e));
  const lifecycle = useSubmit((e) => friendlyError(e));

  const [label, setLabel] = useState(role.label);
  const [description, setDescription] = useState(role.description ?? "");
  const [track, setTrack] = useState(role.track);
  const [level, setLevel] = useState(String(role.level));
  const [departmentId, setDepartmentId] = useState(role.department?.id ?? "");
  const [traits, setTraits] = useState<RoleTraits>(role.traits);
  const [grants, setGrants] = useState<Record<string, string>>(role.grants);
  // The If-Match value: the version shown, moved on by our own saves (ETag) so a second save isn't stale against the first.
  const [version, setVersion] = useState(role.rowVersion);
  useEffect(() => {
    setLabel(role.label); setDescription(role.description ?? ""); setTrack(role.track); setLevel(String(role.level));
    setDepartmentId(role.department?.id ?? ""); setTraits(role.traits); setGrants(role.grants); setVersion(role.rowVersion);
  }, [role]);

  const detailsDirty = label.trim() !== role.label || description.trim() !== (role.description ?? "") || track !== role.track
    || level !== String(role.level) || departmentId !== (role.department?.id ?? "")
    || TRAIT_KEYS.some((t) => traits[t] !== role.traits[t]);
  const gridDirty = JSON.stringify(sorted(grants)) !== JSON.stringify(sorted(role.grants));

  const byArea = useMemo(() => {
    const groups = new Map<string, PermissionDef[]>();
    for (const p of catalog.items) groups.set(p.area, [...(groups.get(p.area) ?? []), p]);
    return [...groups.entries()];
  }, [catalog]);

  const saveDetails = () => void details.run(async () => {
    const body: Parameters<typeof adminApi.updateRole>[1] = {};
    if (label.trim() !== role.label) body.label = label.trim();
    if (description.trim() !== (role.description ?? "")) body.description = description.trim() || null;
    if (track !== role.track) body.track = track;
    if (level !== String(role.level)) body.level = Number(level);
    if (departmentId !== (role.department?.id ?? "")) body.departmentId = departmentId || null;
    const changedTraits = Object.fromEntries(TRAIT_KEYS.filter((t) => traits[t] !== role.traits[t]).map((t) => [t, traits[t]]));
    if (Object.keys(changedTraits).length) body.traits = changedTraits;
    const next = await adminApi.updateRole(role.key, body, version);
    if (next !== undefined) setVersion(next);
    onChanged(`Saved ${label.trim()}.`);
  });

  const saveGrants = () => void grid.run(async () => {
    const full: Record<string, string | null> = Object.fromEntries(catalog.items.map((p) => [p.key, grants[p.key] ?? null]));
    const next = await adminApi.setRoleGrants(role.key, full, version);
    if (next !== undefined) setVersion(next);
    onChanged(`Saved the permissions of ${role.label}.`);
  });

  const archiveOrRestore = () => void lifecycle.run(async () => {
    if (role.archivedAt) { await adminApi.restoreRole(role.key); onChanged(`Restored ${role.label}.`); }
    else { await adminApi.archiveRole(role.key); onChanged(`Archived ${role.label}.`); }
  });

  return (
    <Drawer title={role.label} onClose={onClose} suspended={suspended} wide closeLabel={`Close ${role.label}`}>
      <div className="teamdrawer-head">
        <p className="muted">
          <code>{role.key}</code>
          {role.isSystem ? " · Built-in template" : role.clonedFrom ? ` · Cloned from ${role.clonedFrom}` : ""}
          {role.restricted && " · Restricted: granting it needs a second admin"}
          {` · ${role.holders} ${role.holders === 1 ? "holder" : "holders"}`}
        </p>
        <div className="rowactions">
          {!role.archivedAt && <button className="btn sm" onClick={onClone}>Clone</button>}
          {!role.isSystem && (
            <button className="btn sm" onClick={archiveOrRestore} disabled={lifecycle.busy || (!role.archivedAt && held)}
              title={!role.archivedAt && held ? "Revoke the role from everyone first" : undefined}>
              {role.archivedAt ? "Restore" : "Archive"}
            </button>
          )}
        </div>
      </div>
      {lifecycle.error && <p className="error" role="alert">{lifecycle.error}</p>}
      {role.isSystem && <p className="hint">Built-in roles can't be changed: clone this one to make an editable copy.</p>}
      {!role.isSystem && held && <p className="hint">People hold this role, so its traits and business unit are fixed and no new restricted permission can be added. Clone it to make a different version.</p>}

      <section aria-labelledby="rd-details">
        <h3 id="rd-details">Details and traits</h3>
        <div className="formgrid cols2">
          <div className="field"><label htmlFor="rd-label">Name</label>
            <input id="rd-label" maxLength={80} value={label} disabled={!editable} onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="field"><label htmlFor="rd-desc">Description</label>
            <input id="rd-desc" maxLength={500} value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="field"><label htmlFor="rd-track">Track</label>
            <input id="rd-track" pattern="[a-z][a-z0-9_]*" value={track} disabled={!editable} onChange={(e) => setTrack(e.target.value)} />
            <small className="hint fieldhint">Roles of one track form a ladder, e.g. sales or interview_prep.</small></div>
          <div className="field"><label htmlFor="rd-level">Level</label>
            <input id="rd-level" type="number" min={1} max={20} value={level} disabled={!editable} onChange={(e) => setLevel(e.target.value)} />
            <small className="hint fieldhint">1 is the bottom of the ladder.</small></div>
          <div className="field spanall"><label htmlFor="rd-dept">Business unit</label>
            <select id="rd-dept" value={departmentId} disabled={!editable || held} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Whole organisation</option>
              {departmentOptions(departments.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
        </div>
        <fieldset className="traits">
          <legend>Traits</legend>
          {TRAIT_KEYS.map((t) => (
            <label key={t} className="check" title={TRAIT_LABELS[t].hint}>
              <input type="checkbox" checked={traits[t]} disabled={!editable || held} onChange={(e) => setTraits({ ...traits, [t]: e.target.checked })} />
              {TRAIT_LABELS[t].label}
              <span className="muted"> — {TRAIT_LABELS[t].hint}</span>
            </label>
          ))}
        </fieldset>
        {editable && (
          <>
            {details.error && <p className="error" role="alert">{details.error}</p>}
            <div className="actions">
              <button className="btn primary" onClick={saveDetails} disabled={!detailsDirty || details.busy}>{details.busy ? "Saving…" : "Save details"}</button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="rd-grid">
        <h3 id="rd-grid">Permissions</h3>
        <p className="hint">Each permission has one scope: how far the holder's access reaches. "Off" removes it.
          {!traits.locationBound && " The location scope needs the location-bound trait."}</p>
        {byArea.map(([area, items]) => (
          <div key={area} className="tablewrap">
            <table className="mini rolegrid" aria-label={`${area} permissions`}>
              <thead><tr><th>{area}</th><th>Scope</th></tr></thead>
              <tbody>
                {items.map((p) => {
                  const value = grants[p.key] ?? "";
                  const wasHeld = role.grants[p.key] !== undefined;
                  const locked = !editable || (held && ((p.restricted && !wasHeld)));
                  return (
                    <tr key={p.key} className={value ? "" : "muted"}>
                      <td>
                        <label htmlFor={`g-${p.key}`}>{p.description}</label>
                        <span className="muted"> <code>{p.key}</code></span>
                        {p.restricted && <span className="tag" title="Needs a second approver when granted">Restricted</span>}
                        {p.orgSensitive && <span className="tag" title="Restricted when held for the whole organisation">Sensitive at org</span>}
                      </td>
                      <td>
                        <select id={`g-${p.key}`} value={value} disabled={locked}
                          onChange={(e) => {
                            const next = { ...grants };
                            if (e.target.value) next[p.key] = e.target.value; else delete next[p.key];
                            setGrants(next);
                          }}>
                          <option value="">Off</option>
                          {catalog.scopes.map((s) => (
                            <option key={s} value={s} disabled={(s === "location" && !traits.locationBound) || (held && p.orgSensitive && s === "org" && role.grants[p.key] !== "org")}>
                              {SCOPE_LABELS[s] ?? s}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        {editable && (
          <>
            {grid.error && <p className="error" role="alert">{grid.error}</p>}
            <div className="actions">
              <button className="btn" onClick={() => setGrants(role.grants)} disabled={!gridDirty || grid.busy}>Reset</button>
              <button className="btn primary" onClick={saveGrants} disabled={!gridDirty || grid.busy}>{grid.busy ? "Saving…" : "Save permissions"}</button>
            </div>
          </>
        )}
      </section>
    </Drawer>
  );
}

const sorted = (g: Record<string, string>) => Object.fromEntries(Object.entries(g).sort(([a], [b]) => a.localeCompare(b)));
