import { useEffect, useId, useMemo, useState } from "react";
import { Dialog } from "../ui/Dialog";
import type { NavItem } from "../nav";
import { NAV_ICONS } from "./ui";

/** True for Ctrl+K / Cmd+K, the shortcut that opens the screen switcher. */
export const isQuickJumpKey = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";

/** Items whose label (or section) contains every typed word, label-prefix matches first. */
export function filterScreens(items: readonly NavItem[], query: string): NavItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const hits = items.filter((i) => {
    const hay = `${i.label} ${i.section}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const starts = (i: NavItem) => (i.label.toLowerCase().startsWith(words[0]!) ? 0 : 1);
  return hits.sort((a, b) => starts(a) - starts(b));
}

/**
 * "Go to screen" switcher (Ctrl/Cmd+K): type to filter the screens this role has,
 * arrows move, Enter opens. Presentation only; each screen's API still decides.
 */
export function QuickJump({ items, onGo, onClose }: { items: readonly NavItem[]; onGo: (key: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const hits = useMemo(() => filterScreens(items, query), [items, query]);
  useEffect(() => setIndex(0), [query]);
  const pick = (key: string) => { onClose(); onGo(key); };
  const optionId = (key: string) => `${listId}-${key}`;
  const activeKey = hits[Math.min(index, hits.length - 1)]?.key;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (hits.length ? (i + 1) % hits.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0)); }
    else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
    else if (e.key === "End") { e.preventDefault(); setIndex(Math.max(hits.length - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (activeKey) pick(activeKey); }
  };

  return (
    <Dialog title="Go to screen" onClose={onClose} className="quickjump">
      <input data-autofocus type="text" role="combobox" aria-label="Screen name" aria-expanded="true" aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
        placeholder="Type a screen name…" autoComplete="off" spellCheck={false}
        value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
      <ul id={listId} role="listbox" aria-label="Screens" className="qjlist">
        {hits.map((i) => {
          const Icon = NAV_ICONS[i.key];
          return (
            // Options are picked with the mouse or from the input (aria-activedescendant); they never take focus.
            <li key={i.key} id={optionId(i.key)} role="option" aria-selected={i.key === activeKey}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i.key)}>
              {Icon && <Icon size={16} strokeWidth={1.8} aria-hidden="true" />}
              <span className="qjlabel">{i.label}</span><span className="qjsec">{i.section}</span>
            </li>
          );
        })}
      </ul>
      {hits.length === 0 && <p className="empty" role="status">No screen matches “{query.trim()}”.</p>}
      <p className="muted qjhint">↑ ↓ to move · Enter to open · Esc to close</p>
    </Dialog>
  );
}
