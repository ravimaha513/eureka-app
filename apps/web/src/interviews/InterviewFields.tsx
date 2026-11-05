import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { INTERVIEW_DURATIONS, INTERVIEW_ROUNDS, INTERVIEW_TYPES, INTERVIEW_TYPE_LABELS, PANEL_MAX, type InterviewType } from "@eureka/shared";
import { api } from "../api";

/**
 * Form fields shared by every interview form (Schedule interview from the board or a submission,
 * Edit interview): one label style, one set of controls, so booking looks the same everywhere.
 */
type Named = { id: string; name: string | null };

/** Labelled control: `<label class="field"><span>Title</span>{control}</label>`. */
export function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label className="field"><span>{title}</span>{children}</label>;
}

/** Active interview coaches (GET /interviews/coaches); keeps a current coach who is no longer listed. */
export function Coaches({ value, onChange, title = "Coach", error }: { value: string; onChange: (id: string) => void; title?: string; error?: string }) {
  const id = useId();
  const q = useQuery({ queryKey: ["interview-coaches"], queryFn: () => api<{ items: Named[] }>("/api/v1/interviews/coaches") });
  return (
    <div className="field">
      <label htmlFor={id}>{title}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}>
        <option value="">Unassigned</option>
        {value && !q.data?.items.some((c) => c.id === value) && <option value={value}>Current coach</option>}
        {q.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {error && <small id={`${id}-err`} className="error fielderr">{error}</small>}
      {q.isError && <small className="error" role="alert">Coach list unavailable. Try reopening this form.</small>}
    </div>
  );
}

/** Interview type as radios; with an empty value nothing is picked until the user chooses. */
export function TypeRadios({ value, onChange }: { value: string; onChange: (v: InterviewType) => void }) {
  const name = useId();
  return (
    <fieldset className="field radiorow">
      <legend>Interview type</legend>
      {INTERVIEW_TYPES.map((t) => (
        <label key={t} className="check"><input type="radio" name={name} value={t} checked={value === t} onChange={() => onChange(t)} /> {INTERVIEW_TYPE_LABELS[t]}</label>
      ))}
    </fieldset>
  );
}

/** Round: free text (40 characters) with the usual rounds suggested. */
export function RoundInput({ value, onChange, error, autoFocus }: { value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Round</label>
      <input id={id} required maxLength={40} list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Choose or type a round" data-autofocus={autoFocus || undefined}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} />
      <datalist id={`${id}-list`}>{INTERVIEW_ROUNDS.map((r) => <option key={r} value={r} />)}</datalist>
      {error && <small id={`${id}-err`} className="error fielderr">{error}</small>}
    </div>
  );
}

export function DurationSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const options: number[] = INTERVIEW_DURATIONS.includes(value as never) ? [...INTERVIEW_DURATIONS] : [...INTERVIEW_DURATIONS, value].sort((a, b) => a - b);
  return <Field title="Duration (minutes)"><select value={value} onChange={(e) => onChange(Number(e.target.value))}>
    {options.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>;
}

/** Panel and lead pickers (active staff, names only). The lead must be on the panel. */
export function PanelPicker({ panel, lead, onPanel, onLead }: { panel: string[]; lead: string; onPanel: (ids: string[]) => void; onLead: (id: string) => void }) {
  const [find, setFind] = useState("");
  const q = useQuery({ queryKey: ["interview-panel-options"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/api/v1/interviews/panel-options") });
  const people = q.data?.items ?? [];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Panel member";
  const matches = people.filter((p) => !panel.includes(p.id) && (p.name ?? "").toLowerCase().includes(find.trim().toLowerCase())).slice(0, 8);
  const remove = (id: string) => { onPanel(panel.filter((x) => x !== id)); if (lead === id) onLead(""); };
  return (
    <>
      <fieldset className="field panelpicker">
        <legend>Panel list</legend>
        <ul className="chips" aria-label="Selected panel members">
          {panel.map((id) => <li key={id} className="chip">{nameOf(id)}<button type="button" className="chipx" aria-label={`Remove ${nameOf(id)} from the panel`} onClick={() => remove(id)}>×</button></li>)}
          {panel.length === 0 && <li className="muted">No panel members yet</li>}
        </ul>
        {panel.length < PANEL_MAX ? <>
          <label className="field"><span>Find panel member</span><input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Type a name" /></label>
          {find.trim() && <ul className="pickresults" aria-label="Matching staff">{matches.map((p) => (
            <li key={p.id}><button type="button" className="btn sm" onClick={() => { onPanel([...panel, p.id]); setFind(""); }}>Add {p.name}</button></li>
          ))}{matches.length === 0 && <li className="muted">No matching staff.</li>}</ul>}
        </> : <p className="hint">A panel has at most {PANEL_MAX} members.</p>}
        {q.isError && <p role="alert">Staff list unavailable. Try reopening this form.</p>}
      </fieldset>
      <Field title="Lead user"><select value={lead} onChange={(e) => onLead(e.target.value)} disabled={panel.length === 0}>
        <option value="">No lead</option>{panel.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}</select></Field>
    </>
  );
}
