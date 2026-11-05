import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { DOCUMENTS_STATUSES, LIST_SORTS, LIST_SORT_LABELS, VISA_CATEGORIES, type ListSort } from "@eureka/shared";
import { useLookups } from "../lookups";
import { MultiCombobox, type ComboOption } from "../ui/Combobox";
import { Segmented } from "../ui/Segmented";
import type { useCandidateList } from "./useCandidateList";
import { statusLabel, type FilterOptions, type MultiKey, type SingleFilters } from "./salesApi";

type ListState = ReturnType<typeof useCandidateList>;
type Batch = { id: string; label: string };

const VISIBILITY: Record<string, string> = { team: "Team only", all_teams: "Open to all teams", selected_teams: "Selected teams" };
const RESUME = [["", "Any"], ["yes", "On file"], ["no", "None"]] as const;
const STAY = [["", "Any"], ["guest_house", "Guest house"], ["remote", "Remote"]] as const;
const IN_PERSON = [["", "Any"], ["yes", "Yes"], ["no", "No"]] as const;
const DOCUMENTS: [string, string][] = [...Object.entries(DOCUMENTS_STATUSES), ["none", "Not recorded"]];
/** Filters that live in the "More filters" panel rather than the main row. */
const PANEL_MULTI: MultiKey[] = ["locationId", "visa", "documents", "priority", "teamId", "recruiterId", "ghLocationId"];
const PANEL_SINGLE = ["resume", "stay", "inPerson"] as const;
/** Filters whose column is never empty: "remove it" can say how many candidates come back. */
const ALWAYS_SET: ReadonlySet<string> = new Set(["status", "technology", "visibility", "locationId", "priority", "teamId", "documents"]);

const LABELS: Record<MultiKey | (typeof PANEL_SINGLE)[number], string> = {
  status: "Status", technology: "Technology", visibility: "Visibility", batchId: "Batch", locationId: "Location",
  visa: "Visa", documents: "Documents", priority: "Priority", teamId: "Team", recruiterId: "Recruiter",
  ghLocationId: "Guest house", resume: "Resume", stay: "Stay", inPerson: "In person",
};

/** The choices of every multi-value filter for one list. */
function useChoices(statuses: readonly string[], batches?: Batch[], options?: FilterOptions): Partial<Record<MultiKey, ComboOption[]>> {
  const lk = useLookups().data;
  const pairs = (xs: [string, string][]) => xs.map(([value, label]) => ({ value, label }));
  return {
    status: statuses.map((v) => ({ value: v, label: statusLabel(v) })),
    technology: (lk?.technologies ?? []).map((t) => ({ value: t.name, label: t.name })),
    visibility: pairs(Object.entries(VISIBILITY)),
    batchId: batches?.map((b) => ({ value: b.id, label: b.label })),
    locationId: (lk?.locations ?? []).map((l) => ({ value: l.id, label: l.name })),
    visa: pairs(Object.entries(VISA_CATEGORIES)),
    documents: pairs(DOCUMENTS),
    priority: pairs([["P1", "P1"], ["P2", "P2"], ["P3", "P3"]]),
    teamId: options?.teams?.map((t) => ({ value: t.id, label: t.lead ? `${t.name} (${t.lead})` : t.name })),
    recruiterId: options?.recruiters?.map((r) => ({ value: r.id, label: r.name })),
    ghLocationId: options?.guestHouses?.map((g) => ({ value: g.id, label: g.name })),
  };
}

export interface ActiveFilter { key: string; label: string; value: string; not: boolean; clear: () => void; back?: number }

/** One entry per filter in effect, labelled for chips and the "remove one" suggestions. Name search is left out. */
export function useActiveFilters(s: ListState, choices: Partial<Record<MultiKey, ComboOption[]>>): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const total = s.facets.data?.total;
  for (const k of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    if (k === "resume" || k === "stay" || k === "inPerson") {
      const v = s.single[k];
      if (!v) continue;
      const pairs = k === "resume" ? RESUME : k === "stay" ? STAY : IN_PERSON;
      out.push({ key: k, label: LABELS[k], value: pairs.find(([x]) => x === v)?.[1] ?? v, not: false, clear: () => s.setSingle(k, "") });
      continue;
    }
    const vals = s.values(k);
    if (!vals.length || (k === "batchId" && !choices.batchId)) continue;
    const name = (v: string) => choices[k]?.find((o) => o.value === v)?.label ?? (k === "batchId" ? "Selected batch" : v);
    // With every other filter applied, the facet sums to the rows we'd get back without this one.
    const facet = s.facets.data?.facets?.[k];
    const without = ALWAYS_SET.has(k) && facet && total !== undefined ? facet.reduce((a, x) => a + x.count, 0) - total : undefined;
    out.push({
      key: k, label: LABELS[k], value: vals.map(name).join(", "), not: s.isNot(k), back: without,
      clear: () => s.setValues(k, []),
    });
  }
  return out;
}

/**
 * Candidate list filters: name search and the common filters in one row; the rest behind
 * "More filters" (a bottom sheet on phones). Pick-from-a-list filters take several values, can be
 * inverted ("is none of") and show how many candidates each value has. Every filter in effect shows
 * as a removable chip.
 */
export function ListFilters({ s, label, statuses, batches, options }: {
  s: ListState; label: string; statuses: readonly string[]; batches?: Batch[]; options?: FilterOptions;
}) {
  const id = useId();
  const choices = useChoices(statuses, batches, options);
  const active = useActiveFilters(s, choices);
  const panelCount = PANEL_MULTI.filter((k) => choices[k] && s.values(k).length).length + PANEL_SINGLE.filter((k) => s.single[k]).length;
  const [open, setOpen] = useState(panelCount > 0);
  // A saved view that sets a panel filter opens the panel, so the value is never hidden.
  useEffect(() => { if (panelCount > 0) setOpen(true); }, [panelCount > 0]);

  const multi = (k: MultiKey, any: string) => choices[k] && (
    <MultiCombobox key={k} id={`${id}-${k}`} label={LABELS[k]} anyLabel={any} options={choices[k]!}
      values={s.values(k)} onChange={(v) => s.setValues(k, v)} counts={s.counts(k)}
      negated={s.isNot(k)} onNegate={(on) => s.setNot(k, on)} />
  );
  const seg = <K extends (typeof PANEL_SINGLE)[number]>(k: K, opts: readonly (readonly [SingleFilters[K], string])[]) => (
    <Segmented label={LABELS[k]} value={s.single[k]} options={opts} onChange={(v) => s.setSingle(k, v)} />
  );
  const fetching = s.q.isFetching && s.q.isPlaceholderData;
  return (
    <form className="filterbar" role="search" aria-label={`${label} filters`} onSubmit={(e) => e.preventDefault()}>
      <div className="lf-row">
        <div className="field inline grow">
          <label htmlFor={`${id}-search`}>Search name</label>
          <input id={`${id}-search`} type="search" placeholder="Candidate name" value={s.searchInput} onChange={(e) => s.setSearchInput(e.target.value)} />
        </div>
        {multi("technology", "Any technology")}
        {multi("status", "Any status")}
        {multi("visibility", "Any visibility")}
        {multi("batchId", "Any batch")}
        {options && (
          <div className="field inline">
            <label htmlFor={`${id}-sort`}>Sort by</label>
            <select id={`${id}-sort`} value={s.single.sort || "default"}
              onChange={(e) => s.setSingle("sort", e.target.value === "default" ? "" : e.target.value as ListSort)}>
              {LIST_SORTS.map((k) => <option key={k} value={k}>{LIST_SORT_LABELS[k]}</option>)}
            </select>
          </div>
        )}
        <button type="button" className={`btn morefilters${open ? " on" : ""}`} aria-expanded={open} aria-controls={`${id}-panel`}
          onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal size={15} aria-hidden="true" />More filters
          {panelCount > 0 && <span className="count" aria-label={`${panelCount} active`}>{panelCount}</span>}
        </button>
      </div>

      <div id={`${id}-panel`} className="lf-panel" hidden={!open}>
        <div className="lf-sheethead">
          <h2 id={`${id}-panel-title`}>Filters</h2>
          <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Done</button>
        </div>
        <div className="lf-grid" role="group" aria-labelledby={`${id}-panel-title`}>
          {multi("locationId", "Any location")}
          {multi("visa", "Any visa")}
          {multi("documents", "Any documents status")}
          {seg("resume", RESUME)}
          {seg("stay", STAY)}
          {options && (
            <>
              {multi("priority", "Any priority")}
              {multi("teamId", "Any team")}
              {multi("recruiterId", "Any recruiter")}
              {seg("inPerson", IN_PERSON)}
              {multi("ghLocationId", "Any guest house")}
            </>
          )}
        </div>
        <div className="lf-sheetfoot">
          <button type="button" className="btn" disabled={!s.hasFilters} onClick={s.clear}>Reset</button>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>
            {s.facets.data ? `Show ${s.facets.data.total} ${s.facets.data.total === 1 ? "candidate" : "candidates"}` : "Show results"}
          </button>
        </div>
      </div>
      {open && <div className="lf-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}

      {(active.length > 0 || s.hasFilters) && (
        <div className="activefilters">
          <ul className="filterchips" aria-label="Active filters">
            {active.map((f) => (
              <li key={f.key} className={`fchip${f.not ? " not" : ""}`}>
                <span className="k">{f.label}</span>{f.not && <span className="op">not</span>}<b title={f.value}>{f.value}</b>
                <button type="button" aria-label={`Remove ${f.label} filter`} onClick={f.clear}><X size={13} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
          {s.hasFilters && <button type="button" className="btn ghost sm" onClick={s.clear}>Clear filters</button>}
          {fetching && <span className="muted updating" aria-hidden="true">Updating…</span>}
        </div>
      )}
    </form>
  );
}

/** Empty list with filters on: offer to drop one filter at a time (with how many come back, when known). */
export function NoMatches({ s, statuses, batches, options }: { s: ListState; statuses: readonly string[]; batches?: Batch[]; options?: FilterOptions }) {
  const active = useActiveFilters(s, useChoices(statuses, batches, options));
  return (
    <div className="nomatch">
      <p><b>No candidates match {active.length > 1 ? `all ${active.length} filters` : "these filters"}.</b></p>
      {active.length > 1 && (
        <ul aria-label="Remove one filter">
          {active.map((f) => (
            <li key={f.key}>
              <button type="button" className="btn sm" onClick={f.clear}>
                Remove {f.label}{f.not ? " not" : ""}: {f.value}{f.back ? <span className="back"> +{f.back}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn ghost sm" onClick={s.clear}>Clear all filters</button>
    </div>
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
