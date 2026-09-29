import { useId } from "react";
import type { useCandidateList } from "./useCandidateList";
import { statusLabel } from "./salesApi";

type ListState = ReturnType<typeof useCandidateList>;

/** Search / technology / status / visibility filters for a candidate list. */
export function ListFilters({ s, label, statuses }: { s: ListState; label: string; statuses: readonly string[] }) {
  const id = useId();
  return (
    <form className="toolbar" role="search" aria-label={`${label} filters`} onSubmit={(e) => e.preventDefault()}>
      <div className="field inline">
        <label htmlFor={`${id}-search`}>Search name</label>
        <input id={`${id}-search`} type="search" placeholder="Candidate name" value={s.searchInput} onChange={(e) => s.setSearchInput(e.target.value)} />
      </div>
      <div className="field inline">
        <label htmlFor={`${id}-tech`}>Technology</label>
        <input id={`${id}-tech`} type="search" placeholder="e.g. Java" value={s.technologyInput} onChange={(e) => s.setTechnologyInput(e.target.value)} />
      </div>
      <div className="field inline">
        <label htmlFor={`${id}-status`}>Status</label>
        <select id={`${id}-status`} value={s.status} onChange={(e) => s.setStatus(e.target.value)}>
          <option value="">Any status</option>
          {statuses.map((st) => <option key={st} value={st}>{statusLabel(st)}</option>)}
        </select>
      </div>
      <div className="field inline">
        <label htmlFor={`${id}-vis`}>Visibility</label>
        <select id={`${id}-vis`} value={s.visibility} onChange={(e) => s.setVisibility(e.target.value as ListState["visibility"])}>
          <option value="">Any visibility</option>
          <option value="team">Team only</option>
          <option value="all_teams">Open to all teams</option>
        </select>
      </div>
      {s.hasFilters && <button type="button" className="btn" onClick={s.clear}>Clear filters</button>}
    </form>
  );
}

/** Result count (announced politely) and Previous / Next page controls. */
export function ListFooter({ s, label }: { s: ListState; label: string }) {
  const n = s.q.data?.items.length ?? 0;
  const msg = s.q.isLoading ? "" : s.q.error ? "" : `${n} ${n === 1 ? "candidate" : "candidates"} on page ${s.page + 1}${s.q.data?.nextCursor ? ", more on the next page" : ""}.`;
  return (
    <div className="listfoot">
      <p role="status" aria-live="polite" className="muted">{msg}</p>
      <nav className="pager" aria-label={`${label} pages`}>
        <button type="button" className="btn sm" disabled={s.page === 0} onClick={s.prev}>Previous</button>
        <span>Page {s.page + 1}</span>
        <button type="button" className="btn sm" disabled={!s.canNext} onClick={s.next}>Next</button>
      </nav>
    </div>
  );
}
