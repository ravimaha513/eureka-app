import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, X } from "lucide-react";

export interface ComboOption { value: string; label: string }

/**
 * Searchable single-select (ARIA 1.2 combobox with a listbox popup). Type to narrow the list,
 * ↑/↓ to move, Enter to pick, Esc to close. The first option is always `anyLabel` (value "").
 */
export function Combobox({ label, value, options, anyLabel, onChange, id: idProp }: {
  label: string; value: string; options: ComboOption[]; anyLabel: string; onChange: (v: string) => void; id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [{ value: "", label: anyLabel }, ...options];
    return q ? all.filter((o) => o.value !== "" && o.label.toLowerCase().includes(q)) : all;
  }, [query, options, anyLabel]);

  const show = () => {
    setQuery("");
    setActive(Math.max(0, [{ value: "" }, ...options].findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = () => { setOpen(false); setQuery(""); };
  const pick = (v: string) => { if (v !== value) onChange(v); close(); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { show(); return; }
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (shown.length ? (a + d + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      if (open) { e.preventDefault(); const o = shown[active]; if (o) pick(o.value); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); close(); }
    } else if (e.key === "Home" && open) {
      e.preventDefault(); setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault(); setActive(Math.max(0, shown.length - 1));
    }
  };

  const activeId = open && shown[active] ? `${id}-opt-${active}` : undefined;
  return (
    <div className="field inline">
      <label htmlFor={id}>{label}</label>
      <div className={`combo${value ? " hasvalue" : ""}`}>
        <input
          ref={inputRef} id={id} type="text" role="combobox" autoComplete="off"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
          placeholder={anyLabel}
          value={open ? query : selected?.label ?? ""}
          onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true); }}
          onClick={() => (open ? close() : show())}
          onKeyDown={onKeyDown}
          onBlur={close}
        />
        {value && !open ? (
          <button type="button" className="combo-clear" aria-label={`Clear ${label}`}
            onClick={() => { onChange(""); inputRef.current?.focus(); }}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <ChevronDown className="combo-caret" size={15} aria-hidden="true" />
        )}
        {open && (
          <ul id={listId} role="listbox" aria-label={label} className="combo-list">
            {shown.map((o, i) => (
              <li
                key={o.value || "__any"} id={`${id}-opt-${i}`} role="option" aria-selected={o.value === value}
                className={`${i === active ? "active" : ""}${o.value === "" ? " any" : ""}`}
                // Keep focus in the input so blur does not close the list before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
                ref={i === active ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
              >
                <Highlight text={o.label} q={o.value ? query : ""} />
              </li>
            ))}
            {shown.length === 0 && <li className="combo-empty" role="presentation">No matches</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const t = q.trim();
  const i = t ? text.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + t.length)}</mark>{text.slice(i + t.length)}</>;
}
