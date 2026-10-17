import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { salesApi, salesKeys, type ListFilters, type ViewFilters, type Visibility } from "./salesApi";

export const PAGE_SIZE = 50;

/** Select filters added for Eureka App 4: office location, visa, documents, resume, stay ("" = any). */
export interface ExtraFilters {
  locationId: string;
  visa: string;
  documents: string;
  resume: "" | "yes" | "no";
  stay: "" | "guest_house" | "remote";
}
const NO_EXTRA: ExtraFilters = { locationId: "", visa: "", documents: "", resume: "", stay: "" };

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
  // cursors[i] loads page i; page 0 has no cursor.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);

  useEffect(() => {
    const t = setTimeout(() => {
      const s = searchInput.trim(), tech = technologyInput.trim();
      if (s !== search || tech !== technology) { setSearch(s); setTechnology(tech); reset(); }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, technologyInput, search, technology]);

  const filters: ListFilters = {
    search, technology, status, visibility, batchId: kind === "candidates" ? batchId : "", ...extra,
    cursor: cursors[page], limit: PAGE_SIZE,
  };
  const q = useQuery({
    queryKey: [...(kind === "hotlist" ? salesKeys.hotlist : salesKeys.candidates), filters],
    queryFn: () => (kind === "hotlist" ? salesApi.hotlist(filters) : salesApi.candidates(filters)),
    placeholderData: keepPreviousData,
  });

  return {
    q, page,
    searchInput, setSearchInput, technologyInput, setTechnologyInput,
    status, setStatus: (v: string) => { setStatusRaw(v); reset(); },
    visibility, setVisibility: (v: Visibility | "") => { setVisibilityRaw(v); reset(); },
    batchId, setBatchId: (v: string) => { setBatchIdRaw(v); reset(); },
    extra, setExtra: <K extends keyof ExtraFilters>(k: K, v: ExtraFilters[K]) => { setExtraRaw((e) => ({ ...e, [k]: v })); reset(); },
    hasFilters: Boolean(search || technology || status || visibility || batchId || Object.values(extra).some(Boolean)),
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
      });
      reset();
    },
    /** The filters in effect (debounced text), without paging. */
    applied: { search, technology, status, visibility, ...extra },
    prev: () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c)),
    next: () => { const n = q.data?.nextCursor; if (n) setCursors((c) => [...c, n]); },
    canNext: Boolean(q.data?.nextCursor) && !q.isPlaceholderData,
  };
}
