import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DOCUMENTS_STATUSES, VISA_CATEGORIES } from "@eureka/shared";
import { useLookups } from "../lookups";
import type { useCandidateList } from "./useCandidateList";
import { statusLabel } from "./salesApi";

type ListState = ReturnType<typeof useCandidateList>;

/** Search / technology / status / visibility (and, when `batches` is given, batch) filters for a candidate list. */
export function ListFilters({ s, label, statuses, batches }: {
  s: ListState; label: string; statuses: readonly string[]; batches?: { id: string; label: string }[];
}) {
  const id = useId();
  const locations = useLookups().data?.locations ?? [];
  const sel = (key: keyof ListState["extra"], text: string, options: [string, string][], any: string) => (
    <div className="field inline">
      <label htmlFor={`${id}-${key}`}>{text}</label>
      <select id={`${id}-${key}`} value={s.extra[key]} onChange={(e) => s.setExtra(key, e.target.value as never)}>
        <option value="">{any}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
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
          <option value="selected_teams">Selected teams</option>
        </select>
      </div>
      {batches && (
        <div className="field inline">
          <label htmlFor={`${id}-batch`}>Batch</label>
          <select id={`${id}-batch`} value={s.batchId} onChange={(e) => s.setBatchId(e.target.value)}>
            <option value="">Any batch</option>
            {s.batchId && !batches.some((b) => b.id === s.batchId) && <option value={s.batchId}>Selected batch</option>}
            {batches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
      )}
      {sel("locationId", "Location", locations.map((l) => [l.id, l.name]), "Any location")}
      {sel("visa", "Visa", Object.entries(VISA_CATEGORIES), "Any visa")}
      {sel("documents", "Documents", [...Object.entries(DOCUMENTS_STATUSES), ["none", "Not recorded"]], "Any documents status")}
      {sel("resume", "Resume", [["yes", "Resume on file"], ["no", "No resume"]], "Any resume")}
      {sel("stay", "Stay", [["guest_house", "Guest house"], ["remote", "Remote"]], "Guest house or remote")}
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
        <button type="button" disabled={s.page === 0} onClick={s.prev}><ChevronLeft size={15} aria-hidden="true" />Previous</button>
        <span className="pager-page">Page {s.page + 1}</span>
        <button type="button" disabled={!s.canNext} onClick={s.next}>Next<ChevronRight size={15} aria-hidden="true" /></button>
      </nav>
    </div>
  );
}
