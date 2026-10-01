/** Hot List saved views, bulk actions and export (apps/api/src/modules/hotlist). The server checks every action. */
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type Candidate } from "../api";
import {
  BULK_STATUS_OPTIONS,
  hotlistApi,
  salesKeys,
  statusLabel,
  viewFilters,
  type BulkError,
  type BulkResponse,
  type Visibility,
} from "./salesApi";
import type { useCandidateList } from "./useCandidateList";

type ListState = ReturnType<typeof useCandidateList>;

/** Row cap of an export (EXPORT_ROW_CAP in the API; design A6.5). */
export const EXPORT_ROW_CAP = 50_000;

function viewError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return "You already have a saved view with that name.";
    if (e.status === 422 && e.detail === "too_many_views") return "You can keep up to 50 saved views. Delete one first.";
    if (e.status === 422) return "Give the view a name of 1 to 80 characters.";
    if (e.status === 404) return "That saved view no longer exists.";
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

// ---- saved views -------------------------------------------------------------------------------

export function SavedViews({ s }: { s: ListState }) {
  const id = useId();
  const qc = useQueryClient();
  const views = useQuery({ queryKey: salesKeys.hotlistViews, queryFn: hotlistApi.views });
  const items = views.data?.items ?? [];
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<null | "save" | "rename" | "delete">(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const current = items.find((v) => v.id === selected);

  const done = (text: string) => { setMsg(text); setMode(null); void qc.invalidateQueries({ queryKey: salesKeys.hotlistViews }); };
  const save = useMutation({
    mutationFn: () => hotlistApi.createView(name.trim(), viewFilters(s.applied)),
    onSuccess: (v) => { setSelected(v.id); done(`Saved view “${v.name}”.`); },
  });
  const rename = useMutation({
    mutationFn: () => hotlistApi.updateView(selected, { name: name.trim() }),
    onSuccess: (v) => done(`Renamed to “${v.name}”.`),
  });
  const refilter = useMutation({
    mutationFn: () => hotlistApi.updateView(selected, { filters: viewFilters(s.applied) }),
    onSuccess: (v) => done(`Updated “${v.name}” with the current filters.`),
  });
  const remove = useMutation({
    mutationFn: () => hotlistApi.deleteView(selected),
    onSuccess: () => { const n = current?.name ?? ""; setSelected(""); done(`Deleted view “${n}”.`); },
  });
  const failed = [save, rename, refilter, remove].find((m) => m.isError);
  const reset = () => [save, rename, refilter, remove].forEach((m) => m.reset());

  const open = (m: "save" | "rename" | "delete") => { reset(); setMsg(""); setMode(m); setName(m === "rename" ? current?.name ?? "" : ""); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; (mode === "rename" ? rename : save).mutate(); };

  return (
    <section className="savedviews" aria-label="Saved views">
      <div className="toolbar">
        <div className="field inline">
          <label htmlFor={`${id}-view`}>Saved view</label>
          <select id={`${id}-view`} value={selected} onChange={(e) => {
            const v = items.find((x) => x.id === e.target.value);
            setSelected(e.target.value); setMode(null); reset();
            if (v) { s.apply(v.filters); setMsg(`Showing saved view “${v.name}”.`); } else setMsg("");
          }}>
            <option value="">{views.isLoading ? "Loading…" : items.length ? "Choose a saved view" : "No saved views yet"}</option>
            {items.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <button type="button" className="btn" onClick={() => open("save")}>Save current filters…</button>
        {current && (
          <>
            <button type="button" className="btn" onClick={() => open("rename")}>Rename</button>
            <button type="button" className="btn" disabled={refilter.isPending} onClick={() => { reset(); refilter.mutate(); }}>Update with current filters</button>
            <button type="button" className="btn danger" onClick={() => open("delete")}>Delete</button>
          </>
        )}
      </div>
      {(mode === "save" || mode === "rename") && (
        <form className="toolbar" aria-label={mode === "save" ? "Save view" : "Rename view"} onSubmit={submit}>
          <div className="field inline">
            <label htmlFor={`${id}-name`}>View name</label>
            <input id={`${id}-name`} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
          <button type="submit" className="btn primary" disabled={!name.trim() || save.isPending || rename.isPending}>
            {mode === "save" ? "Save view" : "Save name"}
          </button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === "delete" && current && (
        <div className="toolbar" role="group" aria-label="Confirm delete">
          <span>Delete saved view “{current.name}”? This only removes the view, not any candidates.</span>
          <button type="button" className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete view</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {failed ? <p className="error" role="alert">{viewError(failed.error)}</p> : <p className="muted" role="status">{msg}</p>}
    </section>
  );
}

// ---- export ------------------------------------------------------------------------------------

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Export button; render only when the user holds report:export (the server checks again). */
export function ExportButton({ s }: { s: ListState }) {
  const run = useMutation({
    mutationFn: () => hotlistApi.exportCsv(viewFilters(s.applied)),
    onSuccess: (r) => download(r.blob, r.filename),
  });
  const n = run.data?.rows ?? 0;
  return (
    <div className="export">
      <button type="button" className="btn" disabled={run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? "Exporting…" : "Export CSV"}
      </button>
      <small className="hint">Exports this view for candidates in your scope, up to {EXPORT_ROW_CAP.toLocaleString("en-US")} rows. Phones are masked.</small>
      {run.isError ? (
        <p className="error" role="alert">
          {run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many exports. Try again later.")
            : run.error instanceof ApiError && run.error.status === 403 ? "You don't have permission to export."
            : "The export failed. Try again."}
        </p>
      ) : (
        <p className="muted" role="status">
          {run.data ? (run.data.truncated
            ? `Exported the first ${n.toLocaleString("en-US")} rows (the export limit). Narrow the filters to export the rest.`
            : `Exported ${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}.`) : ""}
        </p>
      )}
    </div>
  );
}

// ---- bulk actions ------------------------------------------------------------------------------

const BULK_REASON: Record<BulkError, string> = {
  not_found: "not found or outside your scope",
  forbidden: "you don't have permission to change this candidate",
  invalid_transition: "that status change isn't allowed from its current status",
  placement_open: "an open placement controls its status",
  failed: "could not be changed; try again",
};

export function BulkBar({ selected, items, canStatus, canVisibility, onDone }: {
  selected: ReadonlySet<string>;
  items: readonly Candidate[];
  canStatus: boolean;
  canVisibility: boolean;
  onDone: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [to, setTo] = useState("");
  const [vis, setVis] = useState<Visibility | "">("");
  const [names, setNames] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: (a: { kind: "status"; to: string } | { kind: "visibility"; visibility: Visibility }) => {
      const ids = [...selected];
      setNames(Object.fromEntries(items.filter((c) => selected.has(c.id)).map((c) => [c.id, c.name])));
      return a.kind === "status" ? hotlistApi.bulkStatus(ids, a.to) : hotlistApi.bulkVisibility(ids, a.visibility);
    },
    onSuccess: () => { setTo(""); setVis(""); onDone(); void qc.invalidateQueries({ queryKey: salesKeys.hotlist }); },
  });
  const r: BulkResponse | undefined = run.data;
  const n = selected.size;

  return (
    <section className="bulkbar" aria-label="Bulk actions">
      <div className="toolbar">
        <span className="muted"><b>{n}</b> {n === 1 ? "candidate" : "candidates"} selected</span>
        {canStatus && (
          <>
            <div className="field inline">
              <label htmlFor={`${id}-to`}>Set status</label>
              <select id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a status</option>
                {BULK_STATUS_OPTIONS.map((st) => <option key={st} value={st}>{statusLabel(st)}</option>)}
              </select>
            </div>
            <button type="button" className="btn primary" disabled={!n || !to || run.isPending}
              onClick={() => run.mutate({ kind: "status", to })}>Apply status</button>
          </>
        )}
        {canVisibility && (
          <>
            <div className="field inline">
              <label htmlFor={`${id}-vis`}>Set visibility</label>
              <select id={`${id}-vis`} value={vis} onChange={(e) => setVis(e.target.value as Visibility | "")}>
                <option value="">Choose visibility</option>
                <option value="team">Team only</option>
                <option value="all_teams">Open to all teams</option>
              </select>
            </div>
            <button type="button" className="btn primary" disabled={!n || !vis || run.isPending}
              onClick={() => vis && run.mutate({ kind: "visibility", visibility: vis })}>Apply visibility</button>
          </>
        )}
        <button type="button" className="btn" disabled={!n} onClick={onDone}>Clear selection</button>
      </div>
      {run.isError ? (
        <p className="error" role="alert">
          {run.error instanceof ApiError && run.error.status === 429 ? (run.error.detail ?? "Too many requests. Try again in a minute.")
            : "The bulk change failed. Nothing was reported as changed; refresh and try again."}
        </p>
      ) : (
        <div role="status" aria-live="polite">
          {r && (
            <>
              <p className="muted">{r.succeeded} updated{r.failed ? `, ${r.failed} not changed` : ""}.</p>
              {r.failed > 0 && (
                <ul className="bulkfail">
                  {r.results.filter((x) => !x.ok).map((x) => (
                    <li key={x.id}>{names[x.id] ?? "A candidate"}: {BULK_REASON[x.error ?? "failed"]}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
