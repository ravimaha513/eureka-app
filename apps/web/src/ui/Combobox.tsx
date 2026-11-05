import { useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface ComboOption { value: string; label: string }

/**
 * Searchable multi-select (ARIA 1.2 combobox with a multi-selectable listbox popup). Type to
 * narrow the list, ↑/↓ to move, Enter (or Space with no text typed) to tick, Esc to close. Each
 * option can show a count (`counts`); options at 0 stay pickable but dimmed. With `onNegate`, the
 * popup offers "is any of" / "is none of".
 */
export function MultiCombobox({ label, values, options, anyLabel, onChange, counts, negated = false, onNegate, id: idProp }: {
  label: string; values: string[]; options: ComboOption[]; anyLabel: string; onChange: (v: string[]) => void;
  counts?: Map<string, number>; negated?: boolean; onNegate?: (on: boolean) => void; id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const chosen = new Set(values);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A value no longer offered (e.g. from a saved view) still shows, so it can be unticked.
    const known = new Set(options.map((o) => o.value));
    const all = [...values.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v })), ...options];
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  }, [query, options, values]);

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const summary = values.length === 0 ? "" : values.length <= 2 ? values.map(labelOf).join(", ") : `${labelOf(values[0]!)} +${values.length - 1}`;

  const show = () => { setQuery(""); setActive(0); setOpen(true); };
  const close = () => { setOpen(false); setQuery(""); };
  const toggle = (v: string) => onChange(chosen.has(v) ? values.filter((x) => x !== v) : [...values, v]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { show(); return; }
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (shown.length ? (a + d + shown.length) % shown.length : 0));
    } else if (e.key === "Enter" || (e.key === " " && open && query === "")) {
      if (open) { e.preventDefault(); const o = shown[active]; if (o) toggle(o.value); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); close(); }
    } else if (e.key === "Home" && open) {
      e.preventDefault(); setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault(); setActive(Math.max(0, shown.length - 1));
    }
  };
  // Close only when focus leaves the whole control (the "any of / none of" buttons are inside it).
  const onBlur = (e: FocusEvent) => { if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close(); };

  const activeId = open && shown[active] ? `${id}-opt-${active}` : undefined;
  return (
    <div className="field inline">
      <label htmlFor={id}>{label}</label>
      <div ref={wrapRef} className={`combo${values.length ? " hasvalue" : ""}${negated && values.length ? " negated" : ""}`} onBlur={onBlur}>
        {negated && values.length > 0 && !open && <span className="combo-not" aria-hidden="true">not</span>}
        <input
          ref={inputRef} id={id} type="text" role="combobox" autoComplete="off"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
          aria-describedby={values.length ? `${id}-desc` : undefined}
          placeholder={open ? "Type to search" : anyLabel}
          value={open ? query : summary}
          onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true); }}
          onClick={() => (open ? close() : show())}
          onKeyDown={onKeyDown}
        />
        {values.length > 0 && (
          <span id={`${id}-desc`} className="sr-only">{negated ? "Is none of" : "Is any of"}: {values.map(labelOf).join(", ")}</span>
        )}
        {values.length > 0 && !open ? (
          <button type="button" className="combo-clear" aria-label={`Clear ${label}`}
            onClick={() => { onChange([]); inputRef.current?.focus(); }}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <ChevronDown className="combo-caret" size={15} aria-hidden="true" />
        )}
        {open && (
          <div className="combo-pop">
            {onNegate && (
              <div className="combo-op" role="group" aria-label={`${label} match`}>
                <button type="button" aria-pressed={!negated} onMouseDown={(e) => e.preventDefault()} onClick={() => onNegate(false)}>is any of</button>
                <button type="button" aria-pressed={negated} onMouseDown={(e) => e.preventDefault()} onClick={() => onNegate(true)}>is none of</button>
              </div>
            )}
            <ul id={listId} role="listbox" aria-label={label} aria-multiselectable="true" className="combo-list">
              {shown.map((o, i) => {
                const n = counts?.get(o.value);
                const sel = chosen.has(o.value);
                return (
                  <li
                    key={o.value} id={`${id}-opt-${i}`} role="option" aria-selected={sel}
                    aria-label={counts ? `${o.label}, ${n ?? 0} ${n === 1 ? "candidate" : "candidates"}` : o.label}
                    className={`${i === active ? "active" : ""}${counts && !n && !sel ? " zero" : ""}`}
                    // Keep focus in the input so the list stays open while ticking.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => toggle(o.value)}
                    ref={i === active ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
                  >
                    <span className="tick" aria-hidden="true">{sel && <Check size={12} />}</span>
                    <span className="lab"><Highlight text={o.label} q={query} /></span>
                    {counts && <span className="n" aria-hidden="true">{n ?? 0}</span>}
                  </li>
                );
              })}
              {shown.length === 0 && <li className="combo-empty" role="presentation">No matches</li>}
            </ul>
            {values.length > 0 && (
              <div className="combo-foot">
                <span>{values.length} selected</span>
                <button type="button" className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange([])}>Clear</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Highlight({ text, q }: { text: string; q: string }) {
  const t = q.trim();
  const i = t ? text.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + t.length)}</mark>{text.slice(i + t.length)}</>;
}
