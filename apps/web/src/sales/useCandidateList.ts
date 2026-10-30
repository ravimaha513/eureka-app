import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCursorPager } from "../ui/Pager";
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

/**
 * Filter + cursor-pagination state shared by the Hot List and the Candidates list.
 * Text filters are debounced; any filter change returns to page 1.
 */
export function useCandidateList(kind: "hotlist" | "candidates") {
  const [searchInput, setSearchInput] = useState("");
  const [technologyInput, setTechnologyInput] = useState("");
  const [search, setSearch] = useState("");
  const [technology, setTechnology] = useState("");
  const [status, setStatusRaw] = useState("");
  const [visibility, setVisibilityRaw] = useState<Visibility | "">("");
  const [batchId, setBatchIdRaw] = useState("");
  const [extra, setExtraRaw] = useState<ExtraFilters>(NO_EXTRA);
  const pager = useCursorPager();
  const { page, reset } = pager;

  useEffect(() => {
    const t = setTimeout(() => {
      const s = searchInput.trim(), tech = technologyInput.trim();
      if (s !== search || tech !== technology) { setSearch(s); setTechnology(tech); reset(); }
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
    status, setStatus: (v: string) => { setStatusRaw(v); reset(); },
    visibility, setVisibility: (v: Visibility | "") => { setVisibilityRaw(v); reset(); },
    batchId, setBatchId: (v: string) => { setBatchIdRaw(v); reset(); },
    extra, setExtra: <K extends keyof ExtraFilters>(k: K, v: ExtraFilters[K]) => { setExtraRaw((e) => ({ ...e, [k]: v })); reset(); },
    // The sort is not a filter: it never empties the list.
    hasFilters: Boolean(search || technology || status || visibility || batchId
      || Object.entries(extra).some(([k, v]) => k !== "sort" && Boolean(v))),
    clear: () => {
      setSearchInput(""); setTechnologyInput(""); setSearch(""); setTechnology(""); setStatusRaw(""); setVisibilityRaw("");
      setBatchIdRaw(""); setExtraRaw(NO_EXTRA); reset();
    },
    /** Replaces every filter at once (a saved view) and returns to page 1. */
    apply: (f: ViewFilters) => {
      setSearchInput(f.search ?? ""); setSearch(f.search ?? "");
      setTechnologyInput(f.technology ?? ""); setTechnology(f.technology ?? "");
      setStatusRaw(f.status ?? ""); setVisibilityRaw(f.visibility ?? "");
      setExtraRaw({
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
