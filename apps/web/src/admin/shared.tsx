import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Me } from "../api";
import { adminApi, type Department } from "./adminApi";

export const keys = {
  meta: ["admin", "meta"] as const,
  users: ["admin", "users"] as const,
  people: ["admin", "users", "people"] as const,
  requests: ["admin", "role-requests"] as const,
  teams: ["admin", "teams"] as const,
  departments: ["admin", "departments"] as const,
  locations: ["admin", "locations"] as const,
  roles: ["admin", "roles"] as const,
  permissions: ["admin", "permissions"] as const,
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

export const useDepartments = () =>
  useQuery({ queryKey: keys.departments, queryFn: () => adminApi.departments().then((r) => r.items), staleTime: 5 * 60_000 });

/** Departments as select options: each top-level one followed by its sub-departments. */
export function departmentOptions(items: Department[]): { id: string; label: string; sub: boolean }[] {
  const top = items.filter((d) => !d.parentId);
  return top.flatMap((t) => [
    { id: t.id, label: t.name, sub: false },
    ...items.filter((d) => d.parentId === t.id).map((d) => ({ id: d.id, label: `${t.name} › ${d.name}`, sub: true })),
  ]);
}

/** Active users for pickers (manager, lead, member). Capped at the API max of 200. */
export const usePeople = () =>
  useQuery({ queryKey: keys.people, queryFn: () => adminApi.users({ status: "active", limit: 200 }).then((p) => p.items) });

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
