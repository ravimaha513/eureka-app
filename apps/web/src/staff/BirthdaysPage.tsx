import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBirthday, isValidBirthday, type Birthday } from "@eureka/shared";
import { BirthdayFields } from "./BirthdayFields";
import { staffApi, staffError, staffKeys, type StaffMember } from "./staffApi";
import { Loading } from "../ui/Loading";

/**
 * Staff birthdays (HR; docs/alerts-calendar-birthdays.md BD-2): every active
 * staff member with the birthday on file, so HR can enter the HR team's and
 * the offshore team's birthdays. The CEO gets the morning digest from these.
 */
export function BirthdaysPage() {
  const q = useQuery({ queryKey: staffKeys.birthdays, queryFn: staffApi.birthdays });
  const [filter, setFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data?.items ?? []).filter((s) => (!onlyMissing || s.birthday === null)
      && (!f || s.name.toLowerCase().includes(f) || s.roles.some((r) => r.toLowerCase().includes(f)) || (s.location ?? "").toLowerCase().includes(f)));
  }, [q.data, filter, onlyMissing]);
  const withBirthday = (q.data?.items ?? []).filter((s) => s.birthday).length;
  return (
    <section className="panel">
      <div className="pagehead"><div><h1 tabIndex={-1}>Staff birthdays</h1>
        <p className="sub">Month and day only. The CEO gets a digest every morning at 08:00 New York with the names of the day. Staff can also set their own birthday in Settings.</p></div></div>
      <div className="toolbar">
        <div className="field inline"><label htmlFor="bd-filter">Filter by name, role or location</label><input id="bd-filter" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <label className="rowactions"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only without a birthday</label>
        <p className="hint">{withBirthday} of {q.data?.items.length ?? 0} staff have a birthday on file.</p>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <p className="error" role="alert">{staffError(q.error)}</p>}
      {q.data && (
        <div className="card tablewrap"><table aria-label="Staff birthdays">
          <thead><tr><th>Name</th><th>Roles</th><th>Location</th><th>Birthday</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {items.map((s) => <StaffRow key={s.id} s={s} />)}
            {items.length === 0 && <tr><td colSpan={5} className="empty">No staff match.</td></tr>}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function StaffRow({ s }: { s: StaffMember }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<Birthday | null>(s.birthday);
  const save = useMutation({
    mutationFn: (b: Birthday | null) => staffApi.setBirthday(s.id, b),
    onSuccess: (r) => {
      qc.setQueryData<{ items: StaffMember[] }>(staffKeys.birthdays, (old) => old && { items: old.items.map((x) => (x.id === s.id ? { ...x, birthday: r.birthday } : x)) });
      setEditing(false);
    },
  });
  const invalid = value !== null && !isValidBirthday(value);
  return (
    <tr>
      <td><b>{s.name}</b><span className="block muted">{s.designation ?? s.email}</span></td>
      <td>{s.roles.join(", ") || <span className="muted">No role</span>}</td>
      <td>{s.location ?? <span className="muted">—</span>}</td>
      <td>
        {editing ? <BirthdayFields idPrefix={`bd-${s.id}`} value={value} onChange={setValue} disabled={save.isPending} /> : (s.birthday ? formatBirthday(s.birthday) : <span className="muted">Not set</span>)}
        {save.error && <span className="block error" role="alert">{staffError(save.error)}</span>}
      </td>
      <td className="rowactions">
        {editing ? (
          <>
            <button type="button" className="btn sm primary" disabled={save.isPending || invalid || value === null} aria-busy={save.isPending || undefined} onClick={() => save.mutate(value)}>Save</button>
            {s.birthday && <button type="button" className="btn sm" disabled={save.isPending} onClick={() => save.mutate(null)}>Clear</button>}
            <button type="button" className="btn sm" disabled={save.isPending} onClick={() => { setEditing(false); setValue(s.birthday); }}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn sm" aria-label={`${s.birthday ? "Change" : "Set"} birthday of ${s.name}`} onClick={() => setEditing(true)}>{s.birthday ? "Change" : "Set"}</button>
        )}
      </td>
    </tr>
  );
}
