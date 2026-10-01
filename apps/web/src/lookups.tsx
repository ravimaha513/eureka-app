/** Reference lists for pickers (GET /api/v1/lookups, docs/placements-api.md) and the picker control. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { Field } from "./sales/ui";

export interface Named { id: string; name: string }
/**
 * Every key is always present. `technologies` and `locations` are open to any
 * signed-in user; `coaches` (interview:create/update) and `clients`, `vendors`,
 * `implementationPartners` (submission:read/create or placement:read) come
 * back as [] when the caller's role doesn't allow them.
 */
export interface Lookups {
  technologies: Named[];
  clients: Named[];
  vendors: Named[];
  implementationPartners: Named[];
  locations: Named[];
  coaches: Named[];
}
export type LookupKind = keyof Lookups;

/** Lists the server withholds (as []) from roles without the matching permission. */
export const RESTRICTED_LOOKUPS: ReadonlySet<LookupKind> = new Set<LookupKind>(["clients", "vendors", "implementationPartners", "coaches"]);

export const lookupsKey = ["lookups"] as const;

/** Active reference rows, cached for the session (they change rarely; the server validates every ID anyway). */
export const useLookups = () =>
  useQuery({ queryKey: lookupsKey, queryFn: () => api<Lookups>("/api/v1/lookups"), staleTime: 10 * 60_000, gcTime: 30 * 60_000 });

/** Display name for an ID from a lookup list, when the list is loaded and has it. */
export function useLookupName(kind: LookupKind, id: string | null | undefined): string | undefined {
  const q = useLookups();
  if (!id) return undefined;
  return q.data?.[kind]?.find((r) => r.id === id)?.name;
}

const OTHER = "__other__";

/**
 * A labelled select fed by the lookups endpoint. While the list loads the
 * select is disabled. If the list can't be loaded, or comes back empty (the
 * server withholds restricted lists from roles that may not see them), the
 * picker falls back to `fallback` options (if any) plus a typed ID so the
 * form is never blocked; the hint says why.
 */
export function LookupPicker({ kind, label, value, onChange, error, optional, placeholder, fallback = [], autoFocus }: {
  kind: LookupKind; label: string; value: string; onChange: (id: string) => void; error?: string;
  optional?: boolean; placeholder?: string; fallback?: Named[]; autoFocus?: boolean;
}) {
  const q = useLookups();
  const [typing, setTyping] = useState(false);
  const af = autoFocus ? { "data-autofocus": true } : {};
  const empty = placeholder ?? (optional ? "None" : "Choose…");
  const rows = q.data?.[kind] ?? [];

  if (rows.length > 0) {
    return (
      <Field label={label} error={error}>
        {(p) => (
          <select {...p} {...af} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="" disabled={!optional}>{empty}</option>
            {value && !rows.some((r) => r.id === value) && <option value={value}>Current selection</option>}
            {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </Field>
    );
  }

  if (q.isPending) {
    return (
      <Field label={label} error={error}>
        {(p) => <select {...p} {...af} value="" disabled aria-busy="true"><option value="">Loading…</option></select>}
      </Field>
    );
  }

  // No list to choose from: offer what the screen already knows, then a typed ID.
  const hint = !q.data
    ? "The list couldn't be loaded; paste the ID instead."
    : RESTRICTED_LOOKUPS.has(kind)
      ? "Not available for your role; paste the ID instead."
      : "No active entries are available; paste the ID instead.";
  const known = fallback.some((r) => r.id === value);
  const showInput = typing || fallback.length === 0 || (value !== "" && !known);
  return (
    <>
      {fallback.length > 0 && (
        <Field label={label} error={showInput ? undefined : error}>
          {(p) => (
            <select {...p} {...af} value={showInput ? OTHER : value} onChange={(e) => {
              const other = e.target.value === OTHER;
              setTyping(other);
              onChange(other ? "" : e.target.value);
            }}>
              <option value="" disabled={!optional}>{empty}</option>
              {fallback.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value={OTHER}>Other (enter an ID)…</option>
            </select>
          )}
        </Field>
      )}
      {showInput && (
        <Field label={fallback.length > 0 ? `${label} ID` : label} error={error} hint={hint}>
          {(p) => <input {...p} {...(fallback.length === 0 ? af : {})} value={value} onChange={(e) => onChange(e.target.value.trim())} spellCheck={false} />}
        </Field>
      )}
    </>
  );
}
