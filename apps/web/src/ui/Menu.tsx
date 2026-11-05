import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive (delete, remove, revoke): bad-red text. Still confirm in a dialog. */
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

/**
 * "More ⋯" menu for a table row or a record header (WAI-ARIA menu button).
 * The button has aria-haspopup/aria-expanded; the popup is role="menu" with role="menuitem"
 * buttons. Enter/Space/ArrowDown open on the first item, ArrowUp on the last; Up/Down/Home/End
 * move; Escape, Tab, an outside click, scroll or resize close it. Choosing an item closes the menu,
 * returns focus to the button, then runs `onSelect` (so a dialog it opens returns focus there too).
 * The popup is `position: fixed` under the button (flips up near the bottom of the window), so it
 * escapes `.tablewrap` overflow. Falsy items are skipped; with no items nothing renders.
 *
 *   <Menu label={`More actions for ${c.name}`} items={[
 *     canEdit && { label: "Edit", onSelect: () => setEditing(c) },
 *     canDelete && { label: "Delete", danger: true, onSelect: () => setDeleting(c) },
 *   ]} />
 * `text` gives a labelled button ("More") instead of the icon-only ⋯ (label stays the accessible name).
 */
export function Menu({ label, items, text, className }: {
  /** Accessible name of the button, e.g. "More actions for Jane Doe". */
  label: string;
  items: readonly (MenuItem | false | null | undefined)[];
  /** Visible button text; omit for the icon-only ⋯ button. */
  text?: string;
  className?: string;
}) {
  const id = useId();
  const shown = items.filter(Boolean) as MenuItem[];
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const entries = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
  const close = (refocus: boolean) => { setOpen(false); setPos(null); if (refocus) btn.current?.focus(); };

  // Place under the button, right-aligned, inside the window; flip above if it would overflow.
  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    const b = btn.current.getBoundingClientRect(), m = menu.current.getBoundingClientRect();
    const below = b.bottom + 4, above = b.top - 4 - m.height;
    const top = below + m.height > window.innerHeight - 8 && above > 8 ? above : below;
    const left = Math.min(Math.max(8, b.right - m.width), window.innerWidth - m.width - 8);
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open || !pos) return;
    const list = entries();
    (open === "last" ? list[list.length - 1] : list[0])?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    // Only a scroll that moves the button matters: a long value scrolling inside an unrelated
    // input (the search box, as focus leaves it) must not close the menu.
    const onMove = (e: Event) => {
      if (e.type === "scroll" && e.target instanceof Node && !e.target.contains(btn.current)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  if (shown.length === 0) return null;

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(e.key === "ArrowUp" ? "last" : "first"); }
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const list = entries();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    // preventDefault + stopPropagation: an enclosing Dialog/sheet must not also close on this Escape.
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close(false);
  };

  return (
    <>
      <button ref={btn} type="button" className={text ? `btn sm menubutton ${className ?? ""}` : `iconbtn sm menubutton ${className ?? ""}`}
        aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(open)} aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(false) : setOpen("first"))} onKeyDown={onButtonKey}>
        {text && <span>{text}</span>}<MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} id={`${id}-menu`} className="menu" role="menu" aria-label={label} onKeyDown={onMenuKey}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}>
          {shown.map((it, i) => (
            <button key={`${i}-${it.label}`} type="button" role="menuitem" tabIndex={-1} disabled={it.disabled}
              className={it.danger ? "danger" : undefined}
              onClick={() => { close(true); it.onSelect(); }}>
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
