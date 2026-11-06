import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Users, X } from "lucide-react";
import type { CalendarCoach } from "./coachCalendarApi";

const CHIPS = 5;

/**
 * Which coaches the calendar shows: a button that opens a searchable checklist, plus removable chips
 * for the current choice. Escape, Done or a click outside closes the list and returns focus to the button.
 */
export function CoachPicker({ coaches, selected, onChange, open, onOpenChange }: {
  coaches: CalendarCoach[]; selected: ReadonlySet<string>; onChange: (ids: Set<string>) => void;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = () => { onOpenChange(false); button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    search.current?.focus();
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) onOpenChange(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const term = query.trim().toLowerCase();
  const matches = coaches.filter((c) => c.name.toLowerCase().includes(term));
  const all = selected.size === coaches.length;
  const summary = all ? `All ${coaches.length} coaches` : selected.size === 0 ? "No coaches" : `${selected.size} of ${coaches.length} coaches`;
  const toggle = (coachId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(coachId); else next.delete(coachId);
    onChange(next);
  };
  const setMatches = (on: boolean) => {
    const next = new Set(selected);
    for (const c of matches) { if (on) next.add(c.id); else next.delete(c.id); }
    onChange(next);
  };

  return (
    <div className="cc-picker" ref={root} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <button ref={button} type="button" className="btn sm cc-pickbtn" aria-expanded={open} aria-controls={`${id}-menu`} onClick={() => onOpenChange(!open)}>
        <Users size={15} aria-hidden="true" /> {summary} <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={`${id}-menu`} className="cc-pickmenu" role="group" aria-label="Choose coaches">
          <input ref={search} type="search" placeholder="Find a coach" aria-label="Find a coach" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="cc-pickactions">
            <button type="button" className="btn sm" onClick={() => setMatches(true)}>{term ? "Select shown" : "Select all"}</button>
            <button type="button" className="btn sm" onClick={() => setMatches(false)}>{term ? "Clear shown" : "Clear"}</button>
            <button type="button" className="btn sm primary" onClick={close}>Done</button>
          </div>
          <div className="cc-picklist">
            {matches.map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                <span>{c.name}</span>{c.detail === "busy" && <span className="cc-busytag">busy only</span>}
              </label>
            ))}
            {matches.length === 0 && <p className="hint">No coach by that name.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The chosen coaches as removable chips; nothing while everyone is shown. */
export function CoachChips({ coaches, selected, onChange, onMore }: {
  coaches: CalendarCoach[]; selected: ReadonlySet<string>; onChange: (ids: Set<string>) => void; onMore: () => void;
}) {
  if (coaches.length <= 1 || selected.size === coaches.length) return null;
  const chosen = coaches.filter((c) => selected.has(c.id));
  const remove = (coachId: string) => { const next = new Set(selected); next.delete(coachId); onChange(next); };
  return (
    <div className="cc-chips" role="group" aria-label="Chosen coaches">
      {chosen.slice(0, CHIPS).map((c) => (
        <button key={c.id} type="button" className="cc-chip" aria-label={`Remove ${c.name}`} onClick={() => remove(c.id)}>
          {c.name} <X size={12} aria-hidden="true" />
        </button>
      ))}
      {chosen.length > CHIPS && <button type="button" className="cc-chip more" onClick={onMore}>+{chosen.length - CHIPS} more</button>}
      <button type="button" className="btn sm ghost" onClick={() => onChange(new Set(coaches.map((c) => c.id)))}>Show all coaches</button>
    </div>
  );
}
