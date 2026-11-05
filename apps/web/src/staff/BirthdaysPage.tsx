import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBirthday, isValidBirthday, type Birthday } from "@eureka/shared";
import { BirthdayFields } from "./BirthdayFields";
import { staffApi, staffError, staffKeys, type StaffMember } from "./staffApi";
import { Loading } from "../ui/Loading";
import "./staff.css";

/** Days from today (local) to the next occurrence of a month/day; 29 Feb counts as 1 Mar in other years. */
export function daysUntil(b: Birthday, today = new Date()): number {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let next = new Date(start.getFullYear(), b.month - 1, b.day);
  if (next < start) next = new Date(start.getFullYear() + 1, b.month - 1, b.day);
  return Math.round((next.getTime() - start.getTime()) / 86_400_000);
}
const nextLabel = (d: number) => (d === 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`);

/**
 * Staff birthdays (HR; docs/alerts-calendar-birthdays.md BD-2): every active
 * staff member with the birthday on file, so HR can enter the HR team's and
 * the offshore team's birthdays. The CEO gets the morning digest from these.
 */
export function BirthdaysPage() {
  const q = useQuery({ queryKey: staffKeys.birthdays, queryFn: staffApi.birthdays });
  const [filter, setFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [sort, setSort] = useState<"name" | "next">("name");
  const [message, setMessage] = useState("");
  const all = q.data?.items ?? [];
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const shown = all.filter((s) => (!onlyMissing || s.birthday === null)
      && (!f || s.name.toLowerCase().includes(f) || s.roles.some((r) => r.toLowerCase().includes(f)) || (s.location ?? "").toLowerCase().includes(f)));
    if (sort === "next") {
      // Soonest first; people without a birthday go last, by name.
      return [...shown].sort((a, b) => (a.birthday ? daysUntil(a.birthday) : 999) - (b.birthday ? daysUntil(b.birthday) : 999) || a.name.localeCompare(b.name));
    }
    return shown;
  }, [all, filter, onlyMissing, sort]);
  const withBirthday = all.filter((s) => s.birthday).length;
  const missing = all.length - withBirthday;
  const pct = all.length ? Math.round((withBirthday / all.length) * 100) : 0;

  // After a save the row may leave the filtered list: keep the keyboard user moving to the next row.
  const focusAfter = useRef<{ id: string | null; until: number } | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    if (Date.now() > f.until) { focusAfter.current = null; return; }
    const target = f.id === null ? filterInput.current : table.current?.querySelector<HTMLButtonElement>(`button[data-bd-edit="${f.id}"]`);
    if (target) { focusAfter.current = null; target.focus(); }
  });
  const onSaved = (s: StaffMember, b: Birthday | null) => {
    const index = items.findIndex((x) => x.id === s.id);
    // Move on to the next row's Set/Change button (the saved row may leave a "missing only" list).
    focusAfter.current = { id: items[index + 1]?.id ?? null, until: Date.now() + 2000 };
    setMessage("");
    setTimeout(() => setMessage(b ? `Saved ${formatBirthday(b)} for ${s.name}.` : `Cleared the birthday of ${s.name}.`), 30);
  };

  return (
    <section className="panel bd-page">
      <div className="pagehead"><div><h1 tabIndex={-1}>Staff birthdays{q.data && <span className="h1count">{all.length}</span>}</h1>
        <p className="sub">Month and day only. The CEO gets a digest every morning at 08:00 New York with the names of the day. Staff can also set their own birthday in Settings.</p></div></div>
      {q.data && (
        <div className="bd-kpi" aria-label="Birthdays on file">
          <span className="bd-kpinum">{missing > 0 ? <><b>{missing}</b> missing</> : <b>All on file</b>}</span>
          <span className="bd-meter" role="progressbar" aria-label="Staff with a birthday on file" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={withBirthday}
            aria-valuetext={`${withBirthday} of ${all.length}`}><span style={{ width: `${pct}%` }} /></span>
          <span className="muted">{withBirthday} of {all.length} staff have a birthday on file</span>
        </div>
      )}
      <div className="toolbar bd-toolbar">
        <div className="field inline bd-search"><label htmlFor="bd-filter">Filter</label>
          <input id="bd-filter" ref={filterInput} type="search" placeholder="Name, role or location" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="field inline bd-sort"><label htmlFor="bd-sort">Sort</label>
          <select id="bd-sort" value={sort} onChange={(e) => setSort(e.target.value as "name" | "next")}>
            <option value="name">Name</option><option value="next">Next birthday</option>
          </select></div>
        <label className="bd-toggle"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only without a birthday{missing > 0 ? ` (${missing})` : ""}</label>
      </div>
      <div className="livemsg" role="status" aria-live="polite">{message}</div>
      {q.isLoading && <Loading />}
      {q.error && <p className="error" role="alert">{staffError(q.error)}</p>}
      {q.data && (
        <div className="card tablewrap listcard"><table ref={table} className="dtable bd-table" aria-label="Staff birthdays">
          <thead><tr><th>Name</th><th className="p2">Roles</th><th>Location</th><th>Birthday</th><th className="num">Next</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {items.map((s) => <StaffRow key={s.id} s={s} onSaved={onSaved} />)}
            {items.length === 0 && <tr><td colSpan={6} className="empty">{onlyMissing && !filter ? "Everyone has a birthday on file." : "No staff match."}</td></tr>}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function StaffRow({ s, onSaved }: { s: StaffMember; onSaved: (s: StaffMember, b: Birthday | null) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<Birthday | null>(s.birthday);
  const editBtn = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLTableCellElement>(null);
  const [refocus, setRefocus] = useState<"edit" | "field" | null>(null);
  useEffect(() => {
    if (refocus === "field") firstField.current?.querySelector<HTMLElement>("select")?.focus();
    if (refocus === "edit") editBtn.current?.focus();
    setRefocus(null);
  }, [refocus]);
  const save = useMutation({
    mutationFn: (b: Birthday | null) => staffApi.setBirthday(s.id, b),
    onSuccess: (r) => {
      onSaved(s, r.birthday);
      qc.setQueryData<{ items: StaffMember[] }>(staffKeys.birthdays, (old) => old && { items: old.items.map((x) => (x.id === s.id ? { ...x, birthday: r.birthday } : x)) });
      setEditing(false);
    },
  });
  const invalid = value !== null && !isValidBirthday(value);
  const days = s.birthday ? daysUntil(s.birthday) : null;
  const secondary = [s.designation, s.email].filter(Boolean).join(" · ");
  return (
    <tr>
      <td className="c-primary"><b>{s.name}</b><small className="block muted">{secondary}</small></td>
      <td className="p2" data-label="Roles">{s.roles.join(", ") || <span className="muted">No role</span>}</td>
      <td data-label="Location">{s.location ?? <span className="muted">—</span>}</td>
      <td data-label="Birthday" ref={firstField} className="bd-cell">
        <div>
          {editing
            ? <form className="bd-edit" onSubmit={(e) => { e.preventDefault(); if (value && !invalid) save.mutate(value); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setEditing(false); setValue(s.birthday); setRefocus("edit"); } }}>
              <BirthdayFields idPrefix={`bd-${s.id}`} value={value} onChange={setValue} disabled={save.isPending} />
              <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
            </form>
            : (s.birthday ? formatBirthday(s.birthday) : <span className="badge bd-missing">Not set</span>)}
          {save.error && <span className="block error" role="alert">{staffError(save.error)}</span>}
        </div>
      </td>
      <td className="num" data-label="Next">{days === null ? <span className="muted">—</span> : <span className={days <= 7 ? "bd-soon" : undefined}>{nextLabel(days)}</span>}</td>
      <td className="c-act">
        <span className="bd-acts">
          {editing ? (
            <>
              <button type="button" className="btn sm primary" disabled={save.isPending || invalid || value === null} aria-busy={save.isPending || undefined}
                aria-label={`Save birthday of ${s.name}`} onClick={() => value && save.mutate(value)}>Save</button>
              {s.birthday && <button type="button" className="btn sm" disabled={save.isPending} aria-label={`Clear birthday of ${s.name}`} onClick={() => save.mutate(null)}>Clear</button>}
              <button type="button" className="btn sm ghost" disabled={save.isPending} onClick={() => { setEditing(false); setValue(s.birthday); setRefocus("edit"); }}>Cancel</button>
            </>
          ) : (
            <button ref={editBtn} type="button" className="btn sm" data-bd-edit={s.id} aria-label={`${s.birthday ? "Change" : "Set"} birthday of ${s.name}`}
              onClick={() => { setValue(s.birthday); setEditing(true); setRefocus("field"); }}>{s.birthday ? "Change" : "Set"}</button>
          )}
        </span>
      </td>
    </tr>
  );
}
