import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { DOCUMENTS_STATUSES, LIST_SORTS, LIST_SORT_LABELS, VISA_CATEGORIES, type ListSort } from "@eureka/shared";
import { useLookups } from "../lookups";
import { Combobox } from "../ui/Combobox";
import { Segmented } from "../ui/Segmented";
import type { ExtraFilters, useCandidateList } from "./useCandidateList";
import { statusLabel, type FilterOptions } from "./salesApi";

type ListState = ReturnType<typeof useCandidateList>;
type Batch = { id: string; label: string };

const VISIBILITY: Record<string, string> = { team: "Team only", all_teams: "Open to all teams", selected_teams: "Selected teams" };
const RESUME = [["", "Any"], ["yes", "On file"], ["no", "None"]] as const;
const STAY = [["", "Any"], ["guest_house", "Guest house"], ["remote", "Remote"]] as const;
const IN_PERSON = [["", "Any"], ["yes", "Yes"], ["no", "No"]] as const;
const PRIORITY = [["", "Any"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"]] as const;
const DOCUMENTS: [string, string][] = [...Object.entries(DOCUMENTS_STATUSES), ["none", "Not recorded"]];
/** Filters that live in the "More filters" panel rather than the main row. */
const PANEL_KEYS = ["locationId", "visa", "documents", "resume", "stay", "priority", "teamId", "recruiterId", "inPerson", "ghLocationId"] as const;

export interface ActiveFilter { key: string; label: string; value: string; clear: () => void }

/** One entry per filter in effect, labelled for chips and the "remove one" suggestions. Text search is left out. */
export function useActiveFilters(s: ListState, batches?: Batch[], options?: FilterOptions): ActiveFilter[] {
  const locations = useLookups().data?.locations ?? [];
  const name = (list: { id: string; name: string }[] | undefined, id: string) => list?.find((x) => x.id === id)?.name ?? "Selected";
  const lab = (pairs: readonly (readonly [string, string])[], v: string) => pairs.find(([k]) => k === v)?.[1] ?? v;
  const e = s.extra;
  const ex = (key: keyof ExtraFilters) => () => s.setExtra(key, "" as never);
  const out: ActiveFilter[] = [];
  if (s.technologyInput.trim()) out.push({ key: "technology", label: "Technology", value: s.technologyInput.trim(), clear: () => s.setTechnologyInput("") });
  if (s.status) out.push({ key: "status", label: "Status", value: statusLabel(s.status), clear: () => s.setStatus("") });
  if (s.visibility) out.push({ key: "visibility", label: "Visibility", value: VISIBILITY[s.visibility] ?? s.visibility, clear: () => s.setVisibility("") });
  if (batches && s.batchId) out.push({ key: "batch", label: "Batch", value: batches.find((b) => b.id === s.batchId)?.label ?? "Selected batch", clear: () => s.setBatchId("") });
  if (e.locationId) out.push({ key: "locationId", label: "Location", value: name(locations, e.locationId), clear: ex("locationId") });
  if (e.visa) out.push({ key: "visa", label: "Visa", value: VISA_CATEGORIES[e.visa as keyof typeof VISA_CATEGORIES] ?? e.visa, clear: ex("visa") });
  if (e.documents) out.push({ key: "documents", label: "Documents", value: lab(DOCUMENTS, e.documents), clear: ex("documents") });
  if (e.resume) out.push({ key: "resume", label: "Resume", value: e.resume === "yes" ? "On file" : "None", clear: ex("resume") });
  if (e.stay) out.push({ key: "stay", label: "Stay", value: lab(STAY, e.stay), clear: ex("stay") });
  if (e.priority) out.push({ key: "priority", label: "Priority", value: e.priority, clear: ex("priority") });
  if (e.teamId) out.push({ key: "teamId", label: "Team", value: name(options?.teams, e.teamId), clear: ex("teamId") });
  if (e.recruiterId) out.push({ key: "recruiterId", label: "Recruiter", value: name(options?.recruiters, e.recruiterId), clear: ex("recruiterId") });
  if (e.inPerson) out.push({ key: "inPerson", label: "In person", value: lab(IN_PERSON, e.inPerson), clear: ex("inPerson") });
  if (e.ghLocationId) out.push({ key: "ghLocationId", label: "Guest house", value: name(options?.guestHouses, e.ghLocationId), clear: ex("ghLocationId") });
  return out;
}

/**
 * Candidate list filters: name / technology search and the common selects in one row; the rest
 * (location, visa, documents, resume, stay and, with `options` on the Hot List, priority, team,
 * recruiter, in person, guest house) behind "More filters" — a bottom sheet on phones.
 * Everything in effect shows as a removable chip.
 */
export function ListFilters({ s, label, statuses, batches, options }: {
  s: ListState; label: string; statuses: readonly string[]; batches?: Batch[]; options?: FilterOptions;
}) {
  const id = useId();
  const locations = useLookups().data?.locations ?? [];
  const active = useActiveFilters(s, batches, options);
  const panelCount = PANEL_KEYS.filter((k) => s.extra[k]).length;
  const [open, setOpen] = useState(panelCount > 0);
  // A saved view that sets a panel filter opens the panel, so the value is never hidden.
  useEffect(() => { if (panelCount > 0) setOpen(true); }, [panelCount > 0]);
  const extraSel = (key: keyof ExtraFilters, text: string, opts: [string, string][], any: string) => (
    <div className="field inline">
      <label htmlFor={`${id}-${key}`}>{text}</label>
      <select id={`${id}-${key}`} value={s.extra[key]} onChange={(e) => s.setExtra(key, e.target.value as never)}>
        <option value="">{any}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const extraCombo = (key: keyof ExtraFilters, text: string, opts: { id: string; name: string }[], any: string) => (
    <Combobox id={`${id}-${key}`} label={text} value={s.extra[key]} anyLabel={any}
      options={opts.map((o) => ({ value: o.id, label: o.name }))} onChange={(v) => s.setExtra(key, v as never)} />
  );
  const fetching = s.q.isFetching && s.q.isPlaceholderData;
  return (
    <form className="filterbar" role="search" aria-label={`${label} filters`} onSubmit={(e) => e.preventDefault()}>
      <div className="lf-row">
        <div className="field inline grow">
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
            {Object.entries(VISIBILITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {batches && (
          <Combobox id={`${id}-batch`} label="Batch" value={s.batchId} anyLabel="Any batch"
            options={[
              ...(s.batchId && !batches.some((b) => b.id === s.batchId) ? [{ value: s.batchId, label: "Selected batch" }] : []),
              ...batches.map((b) => ({ value: b.id, label: b.label })),
            ]}
            onChange={s.setBatchId} />
        )}
        {options && (
          <div className="field inline">
            <label htmlFor={`${id}-sort`}>Sort by</label>
            <select id={`${id}-sort`} value={s.extra.sort || "default"}
              onChange={(e) => s.setExtra("sort", e.target.value === "default" ? "" : e.target.value as ListSort)}>
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
          {extraCombo("locationId", "Location", locations, "Any location")}
          {extraSel("visa", "Visa", Object.entries(VISA_CATEGORIES), "Any visa")}
          {extraSel("documents", "Documents", DOCUMENTS, "Any documents status")}
          <Segmented label="Resume" value={s.extra.resume} options={RESUME} onChange={(v) => s.setExtra("resume", v)} />
          <Segmented label="Stay" value={s.extra.stay} options={STAY} onChange={(v) => s.setExtra("stay", v)} />
          {options && (
            <>
              <Segmented label="Priority" value={s.extra.priority} options={PRIORITY} onChange={(v) => s.setExtra("priority", v)} />
              {extraCombo("teamId", "Team", (options.teams ?? []).map((t) => ({ id: t.id, name: t.lead ? `${t.name} (${t.lead})` : t.name })), "Any team")}
              {extraCombo("recruiterId", "Recruiter", options.recruiters ?? [], "Any recruiter")}
              <Segmented label="In person" value={s.extra.inPerson} options={IN_PERSON} onChange={(v) => s.setExtra("inPerson", v)} />
              {extraCombo("ghLocationId", "Guest house", options.guestHouses ?? [], "Any guest house")}
            </>
          )}
        </div>
        <div className="lf-sheetfoot">
          <button type="button" className="btn" disabled={!s.hasFilters} onClick={s.clear}>Reset</button>
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>Show results</button>
        </div>
      </div>
      {open && <div className="lf-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}

      {(active.length > 0 || s.hasFilters) && (
        <div className="activefilters">
          <ul className="filterchips" aria-label="Active filters">
            {active.map((f) => (
              <li key={f.key} className="fchip">
                <span className="k">{f.label}</span><b>{f.value}</b>
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

/** Empty list with filters on: offer to drop one filter at a time instead of a dead end. */
export function NoMatches({ s, batches, options }: { s: ListState; batches?: Batch[]; options?: FilterOptions }) {
  const active = useActiveFilters(s, batches, options);
  return (
    <div className="nomatch">
      <p><b>No candidates match {active.length > 1 ? `all ${active.length} filters` : "these filters"}.</b></p>
      {active.length > 1 && (
        <ul aria-label="Remove one filter">
          {active.map((f) => (
            <li key={f.key}><button type="button" className="btn sm" onClick={f.clear}>Remove {f.label}: {f.value}</button></li>
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
