import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCursorPager } from "../ui/Pager";
import { useSearchParams } from "../lib/router";
import type { ListSort } from "@eureka/shared";
import { salesApi, salesKeys, type ListFilters, type Priority, type ViewFilters, type Visibility } from "./salesApi";

export const PAGE_SIZE = 50;

/**
 * Select filters added for Eureka App 4 (office location, visa, documents,
 * resume, stay) and the company sheet (priority, team, recruiter, in person,
 * guest house), plus the sort ("" = any / default order).
 */
export interface ExtraFilters {
  locationId: string;
  visa: string;
  documents: string;
  resume: "" | "yes" | "no";
  stay: "" | "guest_house" | "remote";
  priority: "" | Priority;
  teamId: string;
  recruiterId: string;
  inPerson: "" | "yes" | "no";
  ghLocationId: string;
  sort: "" | ListSort;
}
const NO_EXTRA: ExtraFilters = {
  locationId: "", visa: "", documents: "", resume: "", stay: "",
  priority: "", teamId: "", recruiterId: "", inPerson: "", ghLocationId: "", sort: "",
};

/** Query-string names of every list filter (short, stable: they appear in shared links). */
const URL_KEYS = {
  search: "q", technology: "tech", status: "status", visibility: "vis", batchId: "batch",
  locationId: "loc", visa: "visa", documents: "docs", resume: "resume", stay: "stay",
  priority: "pri", teamId: "team", recruiterId: "rec", inPerson: "inperson", ghLocationId: "gh", sort: "sort",
} as const;
type FilterKey = keyof typeof URL_KEYS;
const PARAMS = Object.values(URL_KEYS);
const EXTRA_KEYS = Object.keys(NO_EXTRA) as (keyof ExtraFilters)[];

/**
 * Filter + cursor-pagination state shared by the Hot List and the Candidates list. Filters live in
 * the query string, so they survive a refresh, opening a record and coming back, and shared links.
 * Text filters are debounced; any filter change returns to page 1.
 */
export function useCandidateList(kind: "hotlist" | "candidates") {
  const [url, setUrl] = useSearchParams(PARAMS);
  const get = (k: FilterKey) => url[URL_KEYS[k]];
  const put = (patch: Partial<Record<FilterKey, string>>) =>
    setUrl(Object.fromEntries(Object.entries(patch).map(([k, v]) => [URL_KEYS[k as FilterKey], v ?? ""])));
  const search = get("search"), technology = get("technology"), status = get("status");
  const visibility = get("visibility") as Visibility | "";
  const batchId = get("batchId");
  const extra = Object.fromEntries(EXTRA_KEYS.map((k) => [k, get(k)])) as unknown as ExtraFilters;
  const [searchInput, setSearchInput] = useState(search);
  const [technologyInput, setTechnologyInput] = useState(technology);
  const pager = useCursorPager();
  const { page, reset } = pager;

  // The URL can change under the inputs (a saved view, Clear filters): follow it.
  useEffect(() => { setSearchInput((v) => (v.trim() === search ? v : search)); }, [search]);
  useEffect(() => { setTechnologyInput((v) => (v.trim() === technology ? v : technology)); }, [technology]);
  useEffect(() => {
    const t = setTimeout(() => {
      const s = searchInput.trim(), tech = technologyInput.trim();
      if (s !== search || tech !== technology) { put({ search: s, technology: tech }); reset(); }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, technologyInput, search, technology]);

  const filters: ListFilters = {
    search, technology, status, visibility, batchId: kind === "candidates" ? batchId : "", ...extra,
    cursor: pager.cursor, limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...(kind === "hotlist" ? salesKeys.hotlist : salesKeys.candidates), filters],
    queryFn: () => (kind === "hotlist" ? salesApi.hotlist(filters) : salesApi.candidates(filters)),
    placeholderData: keepPreviousData,
  });

  return {
    q, page,
    /** Changes with any filter or page, not on a background refetch: selections keyed by it reset only then. */
    filterKey: JSON.stringify(filters),
    searchInput, setSearchInput, technologyInput, setTechnologyInput,
    status, setStatus: (v: string) => { put({ status: v }); reset(); },
    visibility, setVisibility: (v: Visibility | "") => { put({ visibility: v }); reset(); },
    batchId, setBatchId: (v: string) => { put({ batchId: v }); reset(); },
    extra, setExtra: <K extends keyof ExtraFilters>(k: K, v: ExtraFilters[K]) => { put({ [k]: v }); reset(); },
    // The sort is not a filter: it never empties the list.
    hasFilters: Boolean(search || technology || status || visibility || batchId
      || Object.entries(extra).some(([k, v]) => k !== "sort" && Boolean(v))),
    clear: () => {
      setSearchInput(""); setTechnologyInput("");
      put(Object.fromEntries((Object.keys(URL_KEYS) as FilterKey[]).filter((k) => k !== "sort").map((k) => [k, ""])));
      reset();
    },
    /** Replaces every filter at once (a saved view) and returns to page 1. */
    apply: (f: ViewFilters) => {
      setSearchInput(f.search ?? ""); setTechnologyInput(f.technology ?? "");
      put({
        search: f.search ?? "", technology: f.technology ?? "", status: f.status ?? "", visibility: f.visibility ?? "",
        locationId: f.locationId ?? "", visa: f.visa ?? "", documents: f.documents ?? "", resume: f.resume ?? "", stay: f.stay ?? "",
        priority: f.priority ?? "", teamId: f.teamId ?? "", recruiterId: f.recruiterId ?? "", inPerson: f.inPerson ?? "",
        ghLocationId: f.ghLocationId ?? "", sort: f.sort ?? "",
      });
      reset();
    },
    /** The filters in effect (debounced text), without paging. */
    applied: { search, technology, status, visibility, ...extra },
    prev: pager.prev,
    next: () => pager.next(q.data?.nextCursor),
    canNext: Boolean(q.data?.nextCursor) && !q.isPlaceholderData,
  };
}
