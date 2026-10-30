/** Reference lists for pickers (GET /api/v1/lookups, docs/placements-api.md) and the picker control. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
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
  /** Live non-admin roles in ladder order (docs/roles-api.md): key as `id`, label as `name`. */
  roles: Named[];
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

/** A role's label from the lookups, the key while they load. */
export function RoleName({ k }: { k: string }) {
  const q = useLookups();
  return <>{q.data?.roles.find((r) => r.id === k)?.name ?? k}</>;
}

/** `<option>`s for a role select: every live business role (docs/roles-api.md). */
export function RoleOptions() {
  const q = useLookups();
  return <>{(q.data?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</>;
}

const OTHER = "__other__";
const ADD = "__add__";

/**
 * Lists that can be added to from the picker (POST /api/v1/lookups/<path>,
 * docs/lookups-api.md; technology:create, client:create, vendor:create). These are always a dropdown, never a
 * pasted ID: the add option is shown only to callers the screen says may add.
 */
const ADDABLE: Partial<Record<LookupKind, { path: string; noun: string; plural: string; onlyWithAdd?: boolean }>> = {
  technologies: { path: "technologies", noun: "technology", plural: "technologies" },
  // Restricted lists: a dropdown only for callers who may add; others keep the typed-ID fallback.
  clients: { path: "clients", noun: "client", plural: "clients", onlyWithAdd: true },
  vendors: { path: "vendors", noun: "vendor", plural: "vendors", onlyWithAdd: true },
};

/**
 * Inline "add a new entry" row under a picker. On success the new row joins
 * the cached list (sorted like the server) and becomes the selection; an
 * existing name in any case comes back as that row instead of a duplicate.
 */
function AddEntry({ kind, onAdded, onCancel }: { kind: LookupKind; onAdded: (id: string) => void; onCancel: () => void }) {
  const { path, noun } = ADDABLE[kind]!;
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const add = useMutation({
    mutationFn: (n: string) => api<Named & { created: boolean }>(`/api/v1/lookups/${path}`, { method: "POST", body: JSON.stringify({ name: n }) }),
    onSuccess: ({ id, name: saved }) => {
      qc.setQueryData<Lookups>(lookupsKey, (old) => {
        if (!old || old[kind].some((r) => r.id === id)) return old;
        const rows = [...old[kind], { id, name: saved }].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        return { ...old, [kind]: rows };
      });
      setName("");
      onAdded(id);
    },
    onError: (e) => setError(e instanceof ApiError && e.status === 409
      ? `That ${noun} has been retired; ask an admin to restore it.`
      : e instanceof ApiError && e.status === 422 ? "Use 1–60 characters." : `Couldn't add the ${noun}. Try again.`),
  });
  const submit = () => {
    const n = name.trim().replace(/\s+/g, " ");
    if (!n) { setError(`Enter a ${noun} name.`); return; }
    if (n.length > 60) { setError("Use 1–60 characters."); return; }
    setError(undefined);
    add.mutate(n);
  };
  return (
    // Input and buttons share one row; hint and error sit under the whole row.
    <Field label={`New ${noun}`} error={error} hint="Adds it to the list for everyone.">
      {(p) => (
        <div className="addentry">
          <input {...p} autoFocus value={name} maxLength={60} autoComplete="off"
            placeholder={`New ${noun} name`} disabled={add.isPending}
            onChange={(e) => { setName(e.target.value); setError(undefined); }}
            // Inside a dialog form: Enter adds the entry instead of submitting the dialog.
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
          <button type="button" className="btn" disabled={add.isPending} onClick={submit}>{add.isPending ? "Adding…" : "Add"}</button>
          <button type="button" className="btn ghost" disabled={add.isPending} onClick={onCancel}>Cancel</button>
        </div>
      )}
    </Field>
  );
}

/**
 * A labelled select fed by the lookups endpoint. While the list loads the
 * select is disabled. If the list can't be loaded, or comes back empty (the
 * server withholds restricted lists from roles that may not see them), the
 * picker falls back to `fallback` options (if any) plus a typed ID so the
 * form is never blocked; the hint says why. Lists in ADDABLE stay a dropdown
 * even when empty, and end with "Add a new …" when `canAdd` (the caller holds
 * the create permission; the API checks again).
 */
export function LookupPicker({ kind, label, value, onChange, error, optional, placeholder, fallback = [], autoFocus, canAdd = false }: {
  kind: LookupKind; label: string; value: string; onChange: (id: string) => void; error?: string;
  optional?: boolean; placeholder?: string; fallback?: Named[]; autoFocus?: boolean; canAdd?: boolean;
}) {
  const q = useLookups();
  const [typing, setTyping] = useState(false);
  const [adding, setAdding] = useState(false);
  const af = autoFocus ? { "data-autofocus": true } : {};
  const empty = placeholder ?? (optional ? "None" : "Choose…");
  const rows = q.data?.[kind] ?? [];
  const addable = ADDABLE[kind]?.onlyWithAdd && !canAdd ? undefined : ADDABLE[kind];

  if (q.isPending && rows.length === 0) {
    return (
      <Field label={label} error={error}>
        {(p) => <select {...p} {...af} value="" disabled aria-busy="true"><option value="">Loading…</option></select>}
      </Field>
    );
  }

  if (rows.length > 0 || addable) {
    const offerAdd = !!addable && canAdd && !!q.data;
    const first = rows.length > 0 ? empty : !q.data ? "Couldn't load the list" : `No ${addable!.plural} yet`;
    const hint = rows.length > 0 || adding ? undefined
      : !q.data ? "The list couldn't be loaded; reload the page to try again."
        : offerAdd ? `Choose “Add a new ${addable!.noun}…” to create the first one.`
          : "Ask a lead, manager or admin to add one.";
    return (
      <>
        <Field label={label} error={adding ? undefined : error} hint={hint}>
          {(p) => (
            <select {...p} {...af} value={adding ? ADD : value} onChange={(e) => {
              if (e.target.value === ADD) { setAdding(true); return; }
              setAdding(false);
              onChange(e.target.value);
            }}>
              <option value="" disabled={!optional}>{first}</option>
              {value && !rows.some((r) => r.id === value) && <option value={value}>Current selection</option>}
              {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              {offerAdd && <option value={ADD}>Add a new {addable!.noun}…</option>}
            </select>
          )}
        </Field>
        {adding && offerAdd && (
          <AddEntry kind={kind} onAdded={(id) => { setAdding(false); onChange(id); }} onCancel={() => setAdding(false)} />
        )}
      </>
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
