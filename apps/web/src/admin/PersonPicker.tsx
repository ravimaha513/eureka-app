import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { adminApi, type AdminUser } from "./adminApi";
import { friendlyError } from "./errors";
import { keys } from "./shared";
import { Highlight } from "../ui/Combobox";

const PAGE = 20;
/** Below this much room under the input, the popup opens upward if there is more room there. */
const MIN_BELOW = 160;
const GUTTER = 12;

/** The current pick. A saved reference may have no email; search results always do. */
export type PersonPickerValue = Pick<AdminUser, "id" | "displayName"> & { email?: string };

/**
 * Pick one active person by searching the server on name or email. Nothing is listed until you
 * type: the directory can be far larger than a dropdown should hold, and larger than one page.
 * ↑/↓ to move, Enter to pick, Esc to close.
 *
 * The popup is position: fixed so a dialog's overflow does not clip it.
 */
export function PersonPicker({ id, label, value, onChange, exclude = [] }: {
  id: string; label: string; value: PersonPickerValue | null; onChange: (p: AdminUser | null) => void; exclude?: string[];
}) {
  const auto = useId();
  const listId = `${auto}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ pop: CSSProperties; listMax: number } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const q = useQuery({
    queryKey: [...keys.users, "person-picker", search],
    queryFn: () => adminApi.users({ search, status: "active", limit: PAGE }),
    enabled: open && search !== "",
    placeholderData: keepPreviousData,
  });
  const typed = query.trim() !== "";
  const rows = typed && search ? (q.data?.items ?? []).filter((p) => !exclude.includes(p.id)) : [];
  const current = Math.min(active, Math.max(0, rows.length - 1));
  // The rows answer what is typed now, not an earlier search still on screen while this one loads.
  const fresh = search === query.trim() && !q.isPlaceholderData;
  const settled = fresh && !q.isFetching;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (e?: Event) => {
      // The list scrolling inside the popup does not move the popup.
      if (e?.target instanceof Node && popRef.current?.contains(e.target)) return;
      const r = inputRef.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GUTTER;
      const above = r.top - GUTTER;
      const up = below < MIN_BELOW && above > below;
      setPlace({
        pop: { position: "fixed", left: r.left, width: r.width, minWidth: 0, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) },
        listMax: Math.min(280, up ? above : below),
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${auto}-opt-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, current, auto]);

  const summary = value ? (value.email ? `${value.displayName} (${value.email})` : value.displayName) : "";
  const show = () => { setQuery(""); setSearch(""); setActive(0); setOpen(true); };
  const close = () => { setOpen(false); setQuery(""); setSearch(""); };
  const pick = (p: AdminUser) => { onChange(p); close(); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { show(); return; }
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((rows.length ? current + d + rows.length : 0) % Math.max(1, rows.length));
    } else if (e.key === "Enter") {
      // Never submit the form from here while the list is up, and never pick a stale row.
      if (open) { e.preventDefault(); const p = rows[current]; if (p && fresh) pick(p); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); close(); }
    }
  };

  // While closed the input shows the current pick; typing starts a fresh search, not an edit of it.
  const typedText = (text: string) => {
    if (open) return text;
    if (text.startsWith(summary)) return text.slice(summary.length);
    return summary.startsWith(text) ? "" : text;
  };

  const activeId = open && rows[current] ? `${auto}-opt-${current}` : undefined;
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <div className={`combo${value ? " hasvalue" : ""}`} onBlur={close}>
        <input
          ref={inputRef} id={id} type="text" role="combobox" autoComplete="off" data-autofocus
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
          placeholder="Search by name or email"
          value={open ? query : summary}
          onChange={(e) => { setQuery(typedText(e.target.value)); setActive(0); setOpen(true); }}
          onClick={() => (open ? close() : show())}
          onKeyDown={onKeyDown}
        />
        {value && !open ? (
          <button type="button" className="combo-clear" aria-label={`Clear ${label}`}
            onClick={() => { onChange(null); inputRef.current?.focus(); }}>
            <X size={14} aria-hidden="true" />
          </button>
        ) : (
          <Search className="combo-caret" size={15} aria-hidden="true" />
        )}
        {open && (
          <div ref={popRef} className="combo-pop" style={place?.pop}
            // Keep focus in the input for clicks and scrollbar drags in here, so the list stays up.
            onMouseDown={(e) => e.preventDefault()}>
            <ul id={listId} role="listbox" aria-label={label} aria-busy={q.isFetching || undefined} className="combo-list"
              style={place ? { maxHeight: place.listMax } : undefined}>
              {rows.map((p, i) => (
                <li
                  key={p.id} id={`${auto}-opt-${i}`} role="option" aria-selected={value?.id === p.id}
                  className={i === current ? "active" : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                >
                  <span className="lab">
                    <Highlight text={p.displayName} q={query} />
                    <span className="combo-sub">
                      <Highlight text={p.email} q={query} />{p.designation ? ` · ${p.designation}` : ""}
                    </span>
                  </span>
                </li>
              ))}
              {rows.length === 0 && (
                <li className="combo-empty" role="presentation">
                  {!typed ? "Type a name or email" : q.error ? friendlyError(q.error) : settled ? "Nobody matches" : "Searching…"}
                </li>
              )}
            </ul>
            {rows.length > 0 && q.data?.nextCursor && (
              <div className="combo-foot combo-more">More people match. Keep typing to narrow it down.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
