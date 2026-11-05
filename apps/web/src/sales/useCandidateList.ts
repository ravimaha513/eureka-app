import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCursorPager } from "../ui/Pager";
import { useSearchParams } from "../lib/router";
import {
  MULTI_FILTER_KEYS, salesApi, salesKeys, type ListFilters, type MultiKey, type SingleFilters, type ViewFilters,
} from "./salesApi";

export const PAGE_SIZE = 50;

export type MultiState = Record<MultiKey, string[]>;

/** Short URL parameter per filter, so a filtered list survives a reload and can be shared as a link. */
const MULTI_URL: Record<MultiKey, string> = {
  status: "status", technology: "tech", visibility: "vis", batchId: "batch", locationId: "loc", visa: "visa",
  documents: "docs", priority: "pri", teamId: "team", recruiterId: "rec", ghLocationId: "gh",
};
const SINGLE_URL: Record<keyof SingleFilters, string> = { resume: "resume", stay: "stay", inPerson: "inperson", sort: "sort" };
const URL_KEYS: readonly string[] = ["q", "not", ...Object.values(MULTI_URL), ...Object.values(SINGLE_URL)];

/** Several values in one parameter: each value is URI-encoded, then joined with commas. */
const decodeList = (raw: string): string[] => (raw ? raw.split(",").map((v) => decodeURIComponent(v)).filter(Boolean) : []);
const encodeList = (vs: readonly string[]): string => vs.map((v) => encodeURIComponent(v)).join(",");
const MULTI_BY_URL: Partial<Record<string, MultiKey>> = Object.fromEntries((Object.entries(MULTI_URL) as [MultiKey, string][]).map(([k, u]) => [u, k]));

/**
 * Filter, facet-count and cursor-pagination state shared by the Hot List and the Candidates list.
 * Pick-from-a-list filters hold several values and can be inverted ("is none of"); the name search
 * is debounced; any filter change returns to page 1. Every filter lives in the URL.
 */
export function useCandidateList(kind: "hotlist" | "candidates") {
  const [raw, setParams] = useSearchParams<string>(URL_KEYS);
  const params = (k: string): string => raw[k] ?? "";
  const search = params("q");
  const [searchInput, setSearchInput] = useState(search);
  const pager = useCursorPager();
  const { page, reset } = pager;

  const multi = Object.fromEntries(MULTI_FILTER_KEYS.map((k) => [k, decodeList(params(MULTI_URL[k]))])) as unknown as MultiState;
  const not = decodeList(params("not")).map((u) => MULTI_BY_URL[u]).filter((k): k is MultiKey => Boolean(k));
  const single: SingleFilters = {
    resume: params("resume") as SingleFilters["resume"], stay: params("stay") as SingleFilters["stay"],
    inPerson: params("inperson") as SingleFilters["inPerson"], sort: params("sort") as SingleFilters["sort"],
  };

  // Back/forward or a saved view changes the URL: the search box follows.
  useEffect(() => { setSearchInput((cur) => (cur.trim() === search ? cur : search)); }, [search]);
  useEffect(() => {
    const t = setTimeout(() => {
      const v = searchInput.trim();
      if (v !== search) { setParams({ q: v }); reset(); }
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
  const notParam = (ks: readonly MultiKey[]) => encodeList(ks.map((k) => MULTI_URL[k]));

  return {
    q, facets, counts, page,
    /** Changes with any filter or page, not on a background refetch: selections keyed by it reset only then. */
    filterKey: JSON.stringify(filters),
    searchInput, setSearchInput,
    values: (k: MultiKey) => multi[k],
    setValues: (k: MultiKey, v: string[]) => {
      setParams({ [MULTI_URL[k]]: encodeList(v), ...(v.length ? {} : { not: notParam(not.filter((x) => x !== k)) }) });
      reset();
    },
    isNot: (k: MultiKey) => not.includes(k),
    setNot: (k: MultiKey, on: boolean) => {
      setParams({ not: notParam(on ? [...not.filter((x) => x !== k), k] : not.filter((x) => x !== k)) });
      if (multi[k].length) reset();
    },
    single,
    setSingle: <K extends keyof SingleFilters>(k: K, v: SingleFilters[K]) => { setParams({ [SINGLE_URL[k]]: v }); reset(); },
    // The sort is not a filter: it never empties the list.
    hasFilters,
    clear: () => {
      setSearchInput("");
      setParams(Object.fromEntries(URL_KEYS.filter((u) => u !== "sort").map((u) => [u, ""])));
      reset();
    },
    /** Replaces every filter at once (a saved view) and returns to page 1. */
    apply: (f: ViewFilters) => {
      setSearchInput(f.search ?? "");
      setParams({
        q: f.search ?? "",
        ...Object.fromEntries(MULTI_FILTER_KEYS.map((k) => [MULTI_URL[k], encodeList(f[k] ?? [])])),
        not: notParam(f.not ?? []),
        resume: f.resume ?? "", stay: f.stay ?? "", inperson: f.inPerson ?? "", sort: f.sort ?? "",
      });
      reset();
    },
    /** The filters in effect (debounced text), without paging. */
    applied,
    prev: pager.prev,
    next: () => pager.next(q.data?.nextCursor),
    canNext: Boolean(q.data?.nextCursor) && !q.isPlaceholderData,
  };
}
