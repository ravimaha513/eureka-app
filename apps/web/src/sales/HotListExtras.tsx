/** Hot List saved views, bulk actions and export (apps/api/src/modules/hotlist). The server checks every action. */
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, Download } from "lucide-react";
import { ApiError, type Candidate } from "../api";
import { saveBlob } from "../lib/download";
import { TeamChecklist } from "./TeamChecklist";
import {
  BULK_STATUS_OPTIONS,
  hotlistApi,
  salesKeys,
  statusLabel,
  viewFilters,
  viewsApi,
  type BulkError,
  type BulkResponse,
  type Priority,
  type ViewList,
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
    if (e.status === 422 && e.detail === "no_team") return "You are not on a team, so there is no one to share this view with.";
    if (e.status === 422) return "Give the view a name of 1 to 80 characters.";
    if (e.status === 404) return "That saved view no longer exists.";
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

// ---- saved views -------------------------------------------------------------------------------

/**
 * Saved views of one list: your own (rename, update, delete) and those your team shares with you
 * (apply only). Saving can share the view with your team.
 */
export function SavedViews({ s, list = "hotlist" }: { s: ListState; list?: ViewList }) {
  const id = useId();
  const qc = useQueryClient();
  const api = viewsApi(list);
  const key = salesKeys.views(list);
  const views = useQuery({ queryKey: key, queryFn: api.views });
  const items = views.data?.items ?? [];
  const mine = items.filter((v) => v.mine);
  const team = items.filter((v) => !v.mine);
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<null | "save" | "rename" | "delete">(null);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [msg, setMsg] = useState("");
  const current = items.find((v) => v.id === selected);

  const done = (text: string) => { setMsg(text); setMode(null); void qc.invalidateQueries({ queryKey: key }); };
  const save = useMutation({
    mutationFn: () => api.createView(name.trim(), viewFilters(s.applied), share),
    onSuccess: (v) => { setSelected(v.id); done(v.shared ? `Saved view “${v.name}”, shared with your team.` : `Saved view “${v.name}”.`); },
  });
  const rename = useMutation({
    mutationFn: () => api.updateView(selected, { name: name.trim() }),
    onSuccess: (v) => done(`Renamed to “${v.name}”.`),
  });
  const refilter = useMutation({
    mutationFn: () => api.updateView(selected, { filters: viewFilters(s.applied) }),
    onSuccess: (v) => done(`Updated “${v.name}” with the current filters.`),
  });
  const reshare = useMutation({
    mutationFn: (on: boolean) => api.updateView(selected, { shared: on }),
    onSuccess: (v) => done(v.shared ? `“${v.name}” is shared with your team.` : `“${v.name}” is now only yours.`),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteView(selected),
    onSuccess: () => { const n = current?.name ?? ""; setSelected(""); done(`Deleted view “${n}”.`); },
  });
  const all = [save, rename, refilter, reshare, remove];
  const failed = all.find((m) => m.isError);
  const reset = () => all.forEach((m) => m.reset());

  const open = (m: "save" | "rename" | "delete") => {
    reset(); setMsg(""); setMode(m); setShare(false); setName(m === "rename" ? current?.name ?? "" : "");
  };
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
            {team.length === 0 ? mine.map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? " (shared)" : ""}</option>) : (
              <>
                {mine.length > 0 && (
                  <optgroup label="My views">
                    {mine.map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? " (shared)" : ""}</option>)}
                  </optgroup>
                )}
                <optgroup label="Shared by my team">
                  {team.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.owner}</option>)}
                </optgroup>
              </>
            )}
          </select>
        </div>
        <button type="button" className="btn" onClick={() => open("save")}><BookmarkPlus size={16} aria-hidden="true" /><span className="btnlabel">Save current filters…</span></button>
        {current?.mine && (
          <>
            <button type="button" className="btn" onClick={() => open("rename")}>Rename</button>
            <button type="button" className="btn" disabled={refilter.isPending} onClick={() => { reset(); refilter.mutate(); }}>Update with current filters</button>
            <button type="button" className="btn" disabled={reshare.isPending} onClick={() => { reset(); reshare.mutate(!current.shared); }}>
              {current.shared ? "Stop sharing" : "Share with my team"}
            </button>
            <button type="button" className="btn danger" onClick={() => open("delete")}>Delete</button>
          </>
        )}
        {current && !current.mine && <span className="muted">Shared by {current.owner}</span>}
      </div>
      {(mode === "save" || mode === "rename") && (
        <form className="toolbar" aria-label={mode === "save" ? "Save view" : "Rename view"} onSubmit={submit}>
          <div className="field inline">
            <label htmlFor={`${id}-name`}>View name</label>
            <input id={`${id}-name`} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          </div>
          {mode === "save" && (
            <label className="checkline">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
              Share with my team
            </label>
          )}
          <button type="submit" className="btn primary" disabled={!name.trim() || save.isPending || rename.isPending}>
            {mode === "save" ? "Save view" : "Save name"}
          </button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === "delete" && current && (
        <div className="toolbar" role="group" aria-label="Confirm delete">
          <span>Delete saved view “{current.name}”?{current.shared ? " Your team will lose it too." : ""} This only removes the view, not any candidates.</span>
          <button type="button" className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete view</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {failed ? <p className="error" role="alert">{viewError(failed.error)}</p> : <p className="muted" role="status">{msg}</p>}
    </section>
  );
}

// ---- export ------------------------------------------------------------------------------------

/** Export button; render only when the user holds report:export (the server checks again). */
export function ExportButton({ s }: { s: ListState }) {
  const run = useMutation({
    mutationFn: () => hotlistApi.exportCsv(viewFilters(s.applied)),
    onSuccess: (r) => saveBlob(r.blob, r.filename),
  });
  const n = run.data?.rows ?? 0;
  return (
    <div className="export">
      <button type="button" className="btn" disabled={run.isPending} onClick={() => run.mutate()} aria-describedby="hotlist-export-hint"
        title={`Exports this view for candidates in your scope, up to ${EXPORT_ROW_CAP.toLocaleString("en-US")} rows. Phones are masked.`}>
        <Download size={16} aria-hidden="true" /><span className="btnlabel">{run.isPending ? "Exporting…" : "Export CSV"}</span>
      </button>
      <small id="hotlist-export-hint" className="sr-only">Exports this view for candidates in your scope, up to {EXPORT_ROW_CAP.toLocaleString("en-US")} rows. Phones are masked.</small>
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
  invalid_teams: "the picked teams include no team besides its own",
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
  const [pri, setPri] = useState<Priority | "">("");
  const [vis, setVis] = useState<Visibility | "">("");
  const [teams, setTeams] = useState<Set<string>>(() => new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: (a: { kind: "status"; to: string } | { kind: "priority"; priority: Priority }
      | { kind: "visibility"; visibility: Visibility; teamIds?: string[] }) => {
      const ids = [...selected];
      setNames(Object.fromEntries(items.filter((c) => selected.has(c.id)).map((c) => [c.id, c.name])));
      return a.kind === "status" ? hotlistApi.bulkStatus(ids, a.to)
        : a.kind === "priority" ? hotlistApi.bulkPriority(ids, a.priority)
        : hotlistApi.bulkVisibility(ids, a.visibility, a.teamIds);
    },
    onSuccess: () => { setTo(""); setPri(""); setVis(""); setTeams(new Set()); onDone(); void qc.invalidateQueries({ queryKey: salesKeys.hotlist }); },
  });
  const r: BulkResponse | undefined = run.data;
  const n = selected.size;
  const pickTeams = vis === "selected_teams";
  // The bar shows while rows are selected, and stays after a change (which clears the selection) to report its outcome.
  if (n === 0 && run.isIdle) return null;

  return (
    <section className="bulkbar" aria-label="Bulk actions">
      {n === 0 ? (
        <div className="toolbar"><span className="muted">Bulk change finished.</span>
          <button type="button" className="btn sm push" onClick={() => run.reset()}>Dismiss</button></div>
      ) : (
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
            <div className="field inline">
              <label htmlFor={`${id}-pri`}>Set priority</label>
              <select id={`${id}-pri`} value={pri} onChange={(e) => setPri(e.target.value as Priority | "")}>
                <option value="">Choose a priority</option>
                <option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
              </select>
            </div>
            <button type="button" className="btn primary" disabled={!n || !pri || run.isPending}
              onClick={() => pri && run.mutate({ kind: "priority", priority: pri })}>Apply priority</button>
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
                <option value="selected_teams">Selected teams</option>
              </select>
            </div>
            <button type="button" className="btn primary" disabled={!n || !vis || (pickTeams && teams.size === 0) || run.isPending}
              onClick={() => vis && run.mutate({ kind: "visibility", visibility: vis, ...(pickTeams ? { teamIds: [...teams] } : {}) })}>Apply visibility</button>
          </>
        )}
        <button type="button" className="btn" disabled={!n} onClick={onDone}>Clear selection</button>
      </div>
      )}
      {n > 0 && canVisibility && pickTeams && (
        <div className="bulkteams">
          <p id={`${id}-teams`} className="hint">
            Picked teams can see and submit these candidates while they're active. Each candidate's own team always sees it.
          </p>
          <TeamChecklist picked={teams} onChange={setTeams} disabled={run.isPending} describedBy={`${id}-teams`} />
        </div>
      )}
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
