import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Me } from "../api";
import { adminApi } from "./adminApi";

export const keys = {
  meta: ["admin", "meta"] as const,
  users: ["admin", "users"] as const,
  people: ["admin", "users", "people"] as const,
  requests: ["admin", "role-requests"] as const,
  teams: ["admin", "teams"] as const,
};

export interface AccessCtx {
  me: Me;
  /** Polite, page-level announcement of a completed action (aria-live). */
  announce: (msg: string) => void;
}
export const AccessContext = createContext<AccessCtx | null>(null);
export const useAccess = () => {
  const c = useContext(AccessContext);
  if (!c) throw new Error("useAccess outside AccessPage");
  return c;
};

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: adminApi.meta, staleTime: 5 * 60_000 });

/** Active users for pickers (manager, lead, member). Capped at the API max of 200. */
export const usePeople = () =>
  useQuery({ queryKey: keys.people, queryFn: () => adminApi.users({ status: "active", limit: 200 }).then((p) => p.items) });

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
