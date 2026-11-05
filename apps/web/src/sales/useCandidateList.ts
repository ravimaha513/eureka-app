import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCursorPager } from "../ui/Pager";
import {
  MULTI_FILTER_KEYS, salesApi, salesKeys, type ListFilters, type MultiKey, type SingleFilters, type ViewFilters,
} from "./salesApi";

export const PAGE_SIZE = 50;

export type MultiState = Record<MultiKey, string[]>;
const NO_MULTI = Object.fromEntries(MULTI_FILTER_KEYS.map((k) => [k, []])) as unknown as MultiState;
const NO_SINGLE: SingleFilters = { resume: "", stay: "", inPerson: "", sort: "" };

/**
 * Filter, facet-count and cursor-pagination state shared by the Hot List and the Candidates list.
 * Pick-from-a-list filters hold several values and can be inverted ("is none of"); the name search
 * is debounced; any filter change returns to page 1.
 */
export function useCandidateList(kind: "hotlist" | "candidates") {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [multi, setMulti] = useState<MultiState>(NO_MULTI);
  const [not, setNotRaw] = useState<MultiKey[]>([]);
  const [single, setSingleRaw] = useState<SingleFilters>(NO_SINGLE);
  const pager = useCursorPager();
  const { page, reset } = pager;

  useEffect(() => {
    const t = setTimeout(() => {
      const v = searchInput.trim();
      if (v !== search) { setSearch(v); reset(); }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  const applied: ViewFilters = {
    search, ...multi, batchId: kind === "candidates" ? multi.batchId : [],
    not: not.filter((k) => multi[k].length > 0), ...single,
  };
  const filters: ListFilters = { ...applied, cursor: pager.cursor, limit: PAGE_SIZE };
  const q = useQuery({
    queryKey: [...(kind === "hotlist" ? salesKeys.hotlist : salesKeys.candidates), filters],
    queryFn: () => (kind === "hotlist" ? salesApi.hotlist(filters) : salesApi.candidates(filters)),
    placeholderData: keepPreviousData,
  });
  // Counts ignore paging and the sort, so they refetch only when a filter changes.
  const { sort: _sort, ...countFilters } = applied;
  const facets = useQuery({
    queryKey: [...salesKeys.facets(kind), countFilters],
    queryFn: () => (kind === "hotlist" ? salesApi.hotlistFacets(countFilters) : salesApi.candidateFacets(countFilters)),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  /** Count per value of one filter (with the other filters applied); undefined until loaded. */
  const counts = (k: keyof NonNullable<typeof facets.data>["facets"]) => {
    const list = facets.data?.facets?.[k];
    return list ? new Map(list.map((x) => [x.value, x.count])) : undefined;
  };

  const hasFilters = Boolean(search) || MULTI_FILTER_KEYS.some((k) => applied[k]?.length)
    || Boolean(single.resume || single.stay || single.inPerson);

  return {
    q, facets, counts, page,
    /** Changes with any filter or page, not on a background refetch: selections keyed by it reset only then. */
    filterKey: JSON.stringify(filters),
    searchInput, setSearchInput,
    values: (k: MultiKey) => multi[k],
    setValues: (k: MultiKey, v: string[]) => { setMulti((m) => ({ ...m, [k]: v })); if (!v.length) setNotRaw((n) => n.filter((x) => x !== k)); reset(); },
    isNot: (k: MultiKey) => not.includes(k),
    setNot: (k: MultiKey, on: boolean) => {
      setNotRaw((n) => (on ? [...n.filter((x) => x !== k), k] : n.filter((x) => x !== k)));
      if (multi[k].length) reset();
    },
    single,
    setSingle: <K extends keyof SingleFilters>(k: K, v: SingleFilters[K]) => { setSingleRaw((s) => ({ ...s, [k]: v })); reset(); },
    // The sort is not a filter: it never empties the list.
    hasFilters,
    clear: () => {
      setSearchInput(""); setSearch(""); setMulti(NO_MULTI); setNotRaw([]); setSingleRaw((s) => ({ ...NO_SINGLE, sort: s.sort })); reset();
    },
    /** Replaces every filter at once (a saved view) and returns to page 1. */
    apply: (f: ViewFilters) => {
      setSearchInput(f.search ?? ""); setSearch(f.search ?? "");
      setMulti(Object.fromEntries(MULTI_FILTER_KEYS.map((k) => [k, f[k] ?? []])) as unknown as MultiState);
      setNotRaw(f.not ?? []);
      setSingleRaw({ resume: f.resume ?? "", stay: f.stay ?? "", inPerson: f.inPerson ?? "", sort: f.sort ?? "" });
      reset();
    },
    /** The filters in effect (debounced text), without paging. */
    applied,
    prev: pager.prev,
    next: () => pager.next(q.data?.nextCursor),
    canNext: Boolean(q.data?.nextCursor) && !q.isPlaceholderData,
  };
}
