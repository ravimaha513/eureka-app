import { useId, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { FilterBar } from "../ui/FilterBar";
import { DOCUMENTS_STATUSES, LIST_SORTS, LIST_SORT_LABELS, VISA_CATEGORIES, type ListSort } from "@eureka/shared";
import { useLookups } from "../lookups";
import type { useCandidateList } from "./useCandidateList";
import { statusLabel, type FilterOptions } from "./salesApi";

type ListState = ReturnType<typeof useCandidateList>;

type SecondaryKey = "visibility" | "locationId" | "visa" | "documents" | "resume" | "stay" | "inPerson" | "ghLocationId";

/**
 * Filter bar for a candidate list. The filters people use most stay inline (search, technology,
 * status, and with `options` — the Hot List — priority, team and recruiter); the rest sit behind
 * "More filters" and show as removable chips while set. On phones the bar collapses to the search
 * box and a Filters button that opens every filter as a sheet. Sort and the result count sit
 * under the bar. Every value lives in the URL (useCandidateList).
 */
export function ListFilters({ s, label, statuses, batches, options, actions, selection, selecting = false }: {
  s: ListState; label: string; statuses: readonly string[]; batches?: { id: string; label: string }[]; options?: FilterOptions;
  /** Extra controls on the right of the summary row (saved views, export). */
  actions?: ReactNode;
  /** The bulk-selection bar: while `selecting`, it takes the summary row's place. */
  selection?: ReactNode;
  selecting?: boolean;
}) {
  const id = useId();
  const locations = useLookups().data?.locations ?? [];
  const sel = (key: keyof ListState["extra"], text: string, opts: [string, string][], any: string) => (
    <div className={`field inline fb-${key}`}>
      <label htmlFor={`${id}-${key}`}>{text}</label>
      <select id={`${id}-${key}`} value={s.extra[key]} onChange={(e) => s.setExtra(key, e.target.value as never)}>
        <option value="">{any}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const visLabel: Record<string, string> = { team: "Team only", all_teams: "Open to all teams", selected_teams: "Selected teams" };
  const optLabel = (opts: [string, string][], v: string) => opts.find(([k]) => k === v)?.[1] ?? v;
  const locOpts: [string, string][] = locations.map((l) => [l.id, l.name]);
  const docOpts: [string, string][] = [...Object.entries(DOCUMENTS_STATUSES), ["none", "Not recorded"]];
  const ghOpts: [string, string][] = (options?.guestHouses ?? []).map((g) => [g.id, g.name]);
  // Secondary filters that are set, as chips: [key, label, clear].
  const chips: [SecondaryKey, string, () => void][] = [];
  if (s.visibility) chips.push(["visibility", `Visibility: ${visLabel[s.visibility] ?? s.visibility}`, () => s.setVisibility("")]);
  if (s.extra.locationId) chips.push(["locationId", `Location: ${optLabel(locOpts, s.extra.locationId)}`, () => s.setExtra("locationId", "")]);
  if (s.extra.visa) chips.push(["visa", `Visa: ${optLabel(Object.entries(VISA_CATEGORIES), s.extra.visa)}`, () => s.setExtra("visa", "")]);
  if (s.extra.documents) chips.push(["documents", `Documents: ${optLabel(docOpts, s.extra.documents)}`, () => s.setExtra("documents", "")]);
  if (s.extra.resume) chips.push(["resume", s.extra.resume === "yes" ? "Resume on file" : "No resume", () => s.setExtra("resume", "")]);
  if (s.extra.stay) chips.push(["stay", s.extra.stay === "guest_house" ? "Stay: Guest house" : "Stay: Remote", () => s.setExtra("stay", "")]);
  if (s.extra.inPerson) chips.push(["inPerson", s.extra.inPerson === "yes" ? "In person" : "Not in person", () => s.setExtra("inPerson", "")]);
  if (s.extra.ghLocationId) chips.push(["ghLocationId", `Guest house: ${optLabel(ghOpts, s.extra.ghLocationId)}`, () => s.setExtra("ghLocationId", "")]);
  const primarySet = [s.searchInput, s.technologyInput, s.status, s.batchId, ...(options ? [s.extra.priority, s.extra.teamId, s.extra.recruiterId] : [])].filter(Boolean).length;

  return (
    <FilterBar label={`${label} filters`} selection={selection} selecting={selecting}
      moreCount={chips.length} activeCount={primarySet + chips.length}
      chips={chips.map(([key, text, clear]) => ({ key, label: text, onRemove: clear }))}
      hasFilters={s.hasFilters} onClear={s.clear}
      search={
        <div className="field inline fb-search">
          <label htmlFor={`${id}-search`}>Search name</label>
          <input id={`${id}-search`} type="search" placeholder="Candidate name" value={s.searchInput} onChange={(e) => s.setSearchInput(e.target.value)} />
        </div>
      }
      primary={
        <>
          <div className="field inline">
            <label htmlFor={`${id}-tech`}>Technology</label>
            <input id={`${id}-tech`} type="search" placeholder="e.g. Java" value={s.technologyInput} onChange={(e) => s.setTechnologyInput(e.target.value)} />
          </div>
          <div className="field inline fb-status">
            <label htmlFor={`${id}-status`}>Status</label>
            <select id={`${id}-status`} value={s.status} onChange={(e) => s.setStatus(e.target.value)}>
              <option value="">Any status</option>
              {statuses.map((st) => <option key={st} value={st}>{statusLabel(st)}</option>)}
            </select>
          </div>
          {options && (
            <>
              {sel("priority", "Priority", [["P1", "P1"], ["P2", "P2"], ["P3", "P3"]], "Any")}
              {sel("teamId", "Team", (options.teams ?? []).map((t) => [t.id, t.lead ? `${t.name} (${t.lead})` : t.name]), "Any team")}
              {sel("recruiterId", "Recruiter", (options.recruiters ?? []).map((r) => [r.id, r.name]), "Any recruiter")}
            </>
          )}
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
        </>
      }
      more={
        <>
          <div className="field inline">
            <label htmlFor={`${id}-vis`}>Visibility</label>
            <select id={`${id}-vis`} value={s.visibility} onChange={(e) => s.setVisibility(e.target.value as ListState["visibility"])}>
              <option value="">Any visibility</option>
              <option value="team">Team only</option>
              <option value="all_teams">Open to all teams</option>
              <option value="selected_teams">Selected teams</option>
            </select>
          </div>
          {sel("locationId", "Location", locOpts, "Any location")}
          {sel("visa", "Visa", Object.entries(VISA_CATEGORIES), "Any visa")}
          {sel("documents", "Documents", docOpts, "Any documents status")}
          {sel("resume", "Resume", [["yes", "Resume on file"], ["no", "No resume"]], "Any resume")}
          {sel("stay", "Stay", [["guest_house", "Guest house"], ["remote", "Remote"]], "Any stay")}
          {options && (
            <>
              {sel("inPerson", "In person", [["yes", "In person"], ["no", "Not in person"]], "Any")}
              {sel("ghLocationId", "Guest house", ghOpts, "Any guest house")}
            </>
          )}
        </>
      }
      summaryEnd={
        <>
          {options && (
            <div className="field inline fb-sort">
              <label htmlFor={`${id}-sort`}>Sort by</label>
              <select id={`${id}-sort`} value={s.extra.sort || "default"}
                onChange={(e) => s.setExtra("sort", e.target.value === "default" ? "" : e.target.value as ListSort)}>
                {LIST_SORTS.map((k) => <option key={k} value={k}>{LIST_SORT_LABELS[k]}</option>)}
              </select>
            </div>
          )}
          {actions}
        </>
      }
    />
  );
}

/** "38" or "50+" (more on the next page) for a heading; empty while loading. */
export function resultCount(s: ListState): string {
  const n = s.q.data?.items.length;
  if (n === undefined || s.q.error) return "";
  return `${n}${s.q.data?.nextCursor ? "+" : ""}`;
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
