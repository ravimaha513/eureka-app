/** Reference lists for pickers (GET /api/v1/lookups, docs/placements-api.md) and the picker control. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { Field } from "./sales/ui";

export interface Named { id: string; name: string }
export interface Lookups {
  technologies: Named[];
  clients: Named[];
  vendors: Named[];
  locations: Named[];
  coaches: Named[];
}
export type LookupKind = keyof Lookups;

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
 * select is disabled; if it can't be loaded, the picker falls back to
 * `fallback` options (if any) plus a typed ID so the form is never blocked.
 */
export function LookupPicker({ kind, label, value, onChange, error, optional, placeholder, fallback = [], autoFocus }: {
  kind: LookupKind; label: string; value: string; onChange: (id: string) => void; error?: string;
  optional?: boolean; placeholder?: string; fallback?: Named[]; autoFocus?: boolean;
}) {
  const q = useLookups();
  const [typing, setTyping] = useState(false);
  const af = autoFocus ? { "data-autofocus": true } : {};
  const empty = placeholder ?? (optional ? "None" : "Choose…");

  if (q.data) {
    const rows = q.data[kind] ?? [];
    return (
      <Field label={label} error={error} hint={rows.length === 0 ? "No active entries are available." : undefined}>
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

  // The list is unavailable: offer what the screen already knows, then a typed ID.
  const showInput = typing || fallback.length === 0;
  return (
    <>
      {fallback.length > 0 && (
        <Field label={label} error={showInput ? undefined : error}>
          {(p) => (
            <select {...p} {...af} value={typing ? OTHER : value} onChange={(e) => {
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
        <Field label={fallback.length > 0 ? `${label} ID` : label} error={error}
          hint="The list couldn't be loaded; paste the ID instead.">
          {(p) => <input {...p} {...(fallback.length === 0 ? af : {})} value={value} onChange={(e) => onChange(e.target.value.trim())} spellCheck={false} />}
        </Field>
      )}
    </>
  );
}
