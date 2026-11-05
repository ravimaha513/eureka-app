import { useId, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

export interface FilterChip { key: string; label: string; onRemove: () => void }

/**
 * List-screen filter bar (the Hot List pattern, `fb-*` classes in styles.css "List screens").
 *
 * Desktop: one row of labelled fields — `search`, then `primary` inline, then a
 * "More filters · n" button that discloses `more` in a sunk panel (aria-expanded/controls,
 * `hidden` while closed). Under it a summary row: removable `chips` (set secondary filters),
 * "Clear filters" while `hasFilters`, then `summaryEnd` (sort, count, export) on the right.
 * While `selecting`, `selection` (a `.bulkbar`) takes the summary row's place.
 *
 * Phones (≤768px): only `search` and a "Filters · n" button show; the button opens every filter
 * (primary + more) as a bottom sheet with a Done button. Escape or Done closes it and returns
 * focus to the button; opening moves focus to the first field in the sheet.
 *
 * Fields are passed in as ready-made `.field.inline` blocks, e.g.
 *   <div className="field inline fb-search"><label htmlFor={id}>Search name</label><input id={id} type="search" … /></div>
 * State stays with the caller (keep it in the URL with useSearchParams).
 */
export function FilterBar({ label, search, primary, more, moreCount, activeCount, chips = [], hasFilters, onClear, summaryEnd, selection, selecting = false }: {
  /** Accessible name of the search form, e.g. "Hot List filters". */
  label: string;
  /** The search field: the only control left inline on phones. */
  search?: ReactNode;
  /** Filters shown inline on desktop (and first in the phone sheet). */
  primary: ReactNode;
  /** Secondary filters behind "More filters". */
  more?: ReactNode;
  /** How many secondary filters are set ("More filters · n"); default `chips.length`. */
  moreCount?: number;
  /** Every set filter, for the phone "Filters · n" button; default `moreCount`. */
  activeCount?: number;
  /** Removable chips for set filters (usually the secondary ones). */
  chips?: FilterChip[];
  /** Shows the "Clear filters" button. */
  hasFilters: boolean;
  onClear: () => void;
  /** Right end of the summary row: sort, result count, saved views, export. */
  summaryEnd?: ReactNode;
  /** The bulk-selection bar; replaces the summary row while `selecting`. */
  selection?: ReactNode;
  selecting?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const mobileBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const nMore = moreCount ?? chips.length;
  const nAll = activeCount ?? nMore;
  const toggle = () => setOpen((o) => {
    if (!o) requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("select, input")?.focus());
    return !o;
  });
  /** Close and put focus back on whichever toggle is visible (phone or desktop). */
  const close = () => {
    setOpen(false);
    const btn = [mobileBtn.current, moreBtn.current].find((b) => b && b.offsetParent !== null);
    btn?.focus();
  };

  return (
    <div className={`filterbar${open ? " open" : ""}`}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); close(); } }}>
      <form className="fb-row" role="search" aria-label={label} onSubmit={(e) => e.preventDefault()}>
        {search}
        <button ref={mobileBtn} type="button" className="btn fb-mobilebtn" aria-expanded={open} aria-controls={`${id}-all`} onClick={toggle}>
          <SlidersHorizontal size={15} aria-hidden="true" />Filters{nAll ? ` · ${nAll}` : ""}
        </button>
        <div className="fb-all" id={`${id}-all`} ref={panel}>
          <div className="fb-sheethead">
            <h2>Filters</h2>
            <button type="button" className="btn" onClick={close}>Done</button>
          </div>
          {primary}
          {more && (
            <>
              <button ref={moreBtn} type="button" className="btn fb-morebtn" aria-expanded={open} aria-controls={`${id}-more`} onClick={toggle}>
                <SlidersHorizontal size={15} aria-hidden="true" />More filters{nMore ? ` · ${nMore}` : ""}
              </button>
              <div className="fb-more" id={`${id}-more`} hidden={!open} role="group" aria-label="More filters">{more}</div>
            </>
          )}
        </div>
      </form>
      {selection}
      {!selecting && (
        <div className="fb-summary">
          {chips.length > 0 && (
            <ul className="chips" aria-label="Active filters">
              {chips.map((c) => (
                <li key={c.key} className="chip">{c.label}
                  <button type="button" className="chipx" aria-label={`Remove filter ${c.label}`} onClick={c.onRemove}><X size={14} aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          {hasFilters && <button type="button" className="linkbtn" onClick={onClear}>Clear filters</button>}
          <span className="fb-spacer" />
          {summaryEnd}
        </div>
      )}
    </div>
  );
}
