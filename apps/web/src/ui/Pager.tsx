import { useCallback, useState } from "react";

export interface CursorPager {
  /** Zero-based page index. */
  page: number;
  /** The cursor that loads the current page (null on page 0). */
  cursor: string | null;
  /** Back to page 1 (call on any filter change). */
  reset: () => void;
  prev: () => void;
  /** Moves on to the page `nextCursor` loads; ignored when there is none. */
  next: (nextCursor: string | null | undefined) => void;
}

/** Cursor-pagination state: a stack where cursors[i] loads page i (page 0 has no cursor). */
export function useCursorPager(): CursorPager {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const reset = useCallback(() => setCursors([null]), []);
  const prev = useCallback(() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)), []);
  const next = useCallback((nx: string | null | undefined) => { if (nx) setCursors((c) => [...c, nx]); }, []);
  return { page, cursor: cursors[page] ?? null, reset, prev, next };
}

/**
 * Previous / Page n / Next. Next is disabled when there is no next cursor or
 * while the previous page is still shown as placeholder data.
 */
export function Pager({ pager, label, nextCursor, pending = false }: {
  pager: CursorPager; label: string; nextCursor: string | null | undefined; pending?: boolean;
}) {
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" className="btn sm" disabled={pager.page === 0} onClick={pager.prev}>Previous</button>
      <span>Page {pager.page + 1}</span>
      <button type="button" className="btn sm" disabled={!nextCursor || pending} onClick={() => pager.next(nextCursor)}>Next</button>
    </nav>
  );
}
