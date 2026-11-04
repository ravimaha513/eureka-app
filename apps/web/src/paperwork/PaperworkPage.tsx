import { useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLACEMENT_STATUSES } from "@eureka/shared";
import type { Me } from "../api";
import { RoleName, RoleOptions } from "../lookups";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Field, fmtDate } from "../sales/ui";
import { PLACEMENT_TYPE_LABELS, fmtDateTime, pipelineLabel, type PlacementType } from "../pipeline/pipelineApi";
import { PipelineStatus } from "../pipeline/ui";
import { docTypeLabel } from "../lib/format";
import { useRoutedId } from "../lib/router";
import { screenPath } from "../nav";
import {
  BGC_STATUSES, paperworkApi, paperworkKeys, paperworkLabel,
  type QueueFilters, type QueueRow, type TemplateItem, type TemplateVersion,
} from "./paperworkApi";
import { BgcBadge, paperworkError } from "./ui";
import { PaperworkWorkspace } from "./PaperworkWorkspace";
import { Pager, useCursorPager } from "../ui/Pager";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";

const PAGE_SIZE = 50;

export { BgcBadge, paperworkError };

/** "Paperwork & BGC": the work queue (HR, Accounts, Immigration, Documents Team) and, for org-wide roles, the templates. */
export function PaperworkPage({ me, initialOpenId = null, onOpenChange }: {
  me: Pick<Me, "id" | "roles" | "capabilities">;
  /** The open placement from the URL (/paperwork/<placementId>); its page replaces the queue. */
  initialOpenId?: string | null;
  onOpenChange?: (id: string | null) => void;
}) {
  const [openId, setOpenId] = useRoutedId(initialOpenId, onOpenChange);
  const templates = useQuery({ queryKey: paperworkKeys.templates, queryFn: paperworkApi.templates, retry: false });
  const [tab, setTab] = useState<"queue" | "templates">("queue");
  const showTemplates = templates.isSuccess;
  if (openId) return <PaperworkWorkspace key={openId} placementId={openId} me={me} onBack={() => setOpenId(null)} />;
  return (
    <>
      <div>
        <h1 tabIndex={-1}>Paperwork &amp; BGC</h1>
        <p className="sub">Outstanding paperwork, overdue items and background checks for the placements in your scope.</p>
      </div>
      {showTemplates && (
        <div className="tabs" role="tablist" aria-label="Paperwork sections">
          <button type="button" className="tab" role="tab" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>Work queue</button>
          <button type="button" className="tab" role="tab" aria-selected={tab === "templates"} onClick={() => setTab("templates")}>Templates</button>
        </div>
      )}
      {tab === "templates" && templates.data
        ? <TemplatesPanel templates={templates.data.templates} canPublish={templates.data.canPublish} />
        : <WorkQueue onOpen={setOpenId} />}
    </>
  );
}

const VIEWS = [["outstanding", "Outstanding"], ["overdue", "Overdue"], ["all", "All"]] as const;

function WorkQueue({ onOpen }: { onOpen: (placementId: string) => void }) {
  const [view, setViewRaw] = useState<"outstanding" | "overdue" | "all">("outstanding");
  const [ownerRole, setOwnerRaw] = useState("");
  const [mine, setMineRaw] = useState(false);
  const [bgcStatus, setBgcRaw] = useState("");
  const [placementStatus, setPlStatusRaw] = useState("");
  const [placementType, setTypeRaw] = useState("");
  const pager = useCursorPager();
  const { page, reset } = pager;
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); reset(); };

  const filters: QueueFilters = { view, ownerRole, mine, bgcStatus, placementStatus, placementType, cursor: pager.cursor ?? "", limit: PAGE_SIZE };
  const q = useQuery({ queryKey: paperworkKeys.queue(filters), queryFn: () => paperworkApi.queue(filters), placeholderData: keepPreviousData });
  const rows = q.data?.items ?? [];
  const hasFilters = Boolean(ownerRole || mine || bgcStatus || placementStatus || placementType || view !== "outstanding");
  const n = rows.length;
  const countMsg = q.isLoading || q.error ? "" : `${n} ${n === 1 ? "placement" : "placements"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;

  return (
    <>
      <form className="filters" role="search" aria-label="Paperwork filters" onSubmit={(e) => e.preventDefault()}>
        <div className="chipfilter">
          <span id="pw-view" className="chiplabel">Show</span>
          <div className="tabs wrap" role="group" aria-labelledby="pw-view">
            {VIEWS.map(([k, label]) => (
              <button key={k} type="button" className="tab" aria-pressed={view === k} onClick={() => set(setViewRaw)(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="toolbar">
          <label className="field inline">Owner role
            <select value={ownerRole} onChange={(e) => set(setOwnerRaw)(e.target.value)}>
              <option value="">Any role</option>
              <RoleOptions />
            </select>
          </label>
          <label className="field inline">BGC status
            <select value={bgcStatus} onChange={(e) => set(setBgcRaw)(e.target.value)}>
              <option value="">Any</option>
              {BGC_STATUSES.map((s) => <option key={s} value={s}>{paperworkLabel(s)}</option>)}
            </select>
          </label>
          <label className="field inline">Placement status
            <select value={placementStatus} onChange={(e) => set(setPlStatusRaw)(e.target.value)}>
              <option value="">Any</option>
              {PLACEMENT_STATUSES.map((s) => <option key={s} value={s}>{pipelineLabel(s)}</option>)}
            </select>
          </label>
          <label className="field inline">Placement type
            <select value={placementType} onChange={(e) => set(setTypeRaw)(e.target.value)}>
              <option value="">Any</option>
              {(["c2c", "w2", "1099"] as const).map((t) => <option key={t} value={t}>{PLACEMENT_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={mine} onChange={(e) => set(setMineRaw)(e.target.checked)} /> Assigned to me</label>
          {hasFilters && (
            <button type="button" className="btn" onClick={() => {
              setViewRaw("outstanding"); setOwnerRaw(""); setMineRaw(false); setBgcRaw(""); setPlStatusRaw(""); setTypeRaw(""); reset();
            }}>Clear filters</button>
          )}
        </div>
      </form>

      <div className="card tablewrap">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={paperworkError(q.error)} />
        ) : (
          <div className="tablewrap"><table aria-label="Paperwork queue" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>Candidate</th><th>Placement</th><th>Checklist</th><th>Next due</th><th>BGC</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((r) => <QueueTableRow key={r.placementId} r={r} onOpen={() => onOpen(r.placementId)} />)}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="empty">{hasFilters ? "No placements match these filters." : "Nothing outstanding. New placements appear here with their paperwork."}</td></tr>
              )}
            </tbody>
          </table></div>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <Pager pager={pager} label="Paperwork pages" nextCursor={q.data?.nextCursor} pending={q.isPlaceholderData} />
      </div>
    </>
  );
}

function QueueTableRow({ r, onOpen }: { r: QueueRow; onOpen: () => void }) {
  const done = r.checklist.total - r.checklist.open;
  const name = r.candidate.name ?? "Candidate";
  return (
    <tr>
      <td><a className="rowlink" href={screenPath("paperwork", r.placementId)}
        onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpen(); }}>{name}</a>
        <span className="block">{r.recruiter.name}</span></td>
      <td>{r.placement ? (
        <><PipelineStatus status={r.placement.status} /><span className="block">
          {PLACEMENT_TYPE_LABELS[r.placement.placementType as PlacementType] ?? r.placement.placementType}
          {r.placement.client && ` · ${r.placement.client.name}`} · starts {fmtDate(r.placement.tentativeStart)}</span></>
      ) : <span className="muted">Not visible to you</span>}</td>
      <td>{r.checklist.total === 0 ? <span className="muted">No checklist</span> : (
        <>{done} of {r.checklist.total} done
          {r.checklist.requiredOpen > 0 && <span className="block">{r.checklist.requiredOpen} required open</span>}
          {r.checklist.overdue > 0 && <> <span className="badge overdue">{r.checklist.overdue} overdue</span></>}</>
      )}</td>
      <td>{r.checklist.nextDue ? fmtDate(r.checklist.nextDue) : <span className="muted">—</span>}</td>
      <td><BgcBadge status={r.bgc.status} /></td>
      <td className="rowactions"><button type="button" className="btn sm" onClick={onOpen} aria-label={`Open paperwork of ${name}`}>Open</button></td>
    </tr>
  );
}

const KINDS = ["paperwork", "onboarding"] as const;
const TYPES = ["c2c", "w2", "1099"] as const;

/** Latest version per kind and placement type; publishing appends a version (existing placements keep their copy). */
function TemplatesPanel({ templates, canPublish }: { templates: TemplateVersion[]; canPublish: boolean }) {
  const [editing, setEditing] = useState<{ kind: string; placementType: string; current: TemplateVersion | null } | null>(null);
  const [message, setMessage] = useState("");
  const qc = useQueryClient();
  const latest = (kind: string, type: string) => templates.filter((t) => t.kind === kind && t.placementType === type).sort((a, b) => b.version - a.version)[0] ?? null;
  return (
    <>
      <p className="sub">Each placement copies the latest paperwork template of its type when it is created. Publishing a new version never changes existing placements. Template content is still an open product decision: none ships with the app.</p>
      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {KINDS.map((kind) => (
        <section key={kind} className="card pad" aria-label={`${paperworkLabel(kind)} templates`}>
          <h2>{paperworkLabel(kind)} templates</h2>
          {kind === "onboarding" && <p className="muted">Onboarding items attach to assignments when the employees work lands.</p>}
          <div className="tablewrap"><table className="mini" aria-label={`${paperworkLabel(kind)} templates`}>
            <thead><tr><th>Placement type</th><th>Version</th><th>Documents</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {TYPES.map((type) => {
                const t = latest(kind, type);
                return (
                  <tr key={type}>
                    <td>{PLACEMENT_TYPE_LABELS[type]}</td>
                    <td>{t ? `v${t.version} · ${fmtDate(t.publishedAt)}` : <span className="muted">None</span>}</td>
                    <td>{t && t.items.length
                      ? t.items.map((i, k) => <span key={i.docType}>{k > 0 && "; "}{docTypeLabel(i.docType)} (<RoleName k={i.ownerRole} />{i.required ? "" : ", optional"})</span>)
                      : <span className="muted">No documents</span>}</td>
                    <td className="rowactions">{canPublish && (
                      <button type="button" className="btn sm" onClick={() => setEditing({ kind, placementType: type, current: t })}
                        aria-label={`New ${paperworkLabel(kind).toLowerCase()} version for ${PLACEMENT_TYPE_LABELS[type]}`}>New version</button>
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </section>
      ))}
      {editing && (
        <TemplateDialog {...editing} onClose={() => setEditing(null)} onDone={(v) => {
          setEditing(null);
          setMessage(`Published version ${v}.`);
          void qc.invalidateQueries({ queryKey: paperworkKeys.templates });
        }} />
      )}
    </>
  );
}

function TemplateDialog({ kind, placementType, current, onClose, onDone }: {
  kind: string; placementType: string; current: TemplateVersion | null; onClose: () => void; onDone: (version: number) => void;
}) {
  const [items, setItems] = useState<TemplateItem[]>(current?.items.map((i) => ({ ...i })) ?? []);
  const [err, setErr] = useState("");
  const submit = useSubmit(paperworkError);
  const update = (k: number, patch: Partial<TemplateItem>) => setItems((xs) => xs.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  const title = `New ${paperworkLabel(kind).toLowerCase()} template version for ${PLACEMENT_TYPE_LABELS[placementType as PlacementType]}`;
  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        const bad = items.find((i) => !/^[a-z][a-z0-9_]{0,59}$/.test(i.docType));
        if (bad) { setErr("Document types are snake_case keys, e.g. sample_document."); return; }
        if (new Set(items.map((i) => i.docType)).size !== items.length) { setErr("Each document type may appear once."); return; }
        setErr("");
        void submit.run(async () => {
          const r = await paperworkApi.publishTemplate({ kind, placementType, items, expectedVersion: current?.version ?? 0 });
          onDone(r.version);
        });
      }}>
        <p className="dialogbody">Based on {current ? `version ${current.version}` : "an empty template"}. Existing placements keep the version they were created with.</p>
        <fieldset className="contacts">
          <legend>Documents</legend>
          {items.length === 0 && <p className="muted">No documents: placements of this type get no checklist.</p>}
          {items.map((it, k) => (
            <div key={k} className="contactrow">
              <Field label={`Document type ${k + 1}`}>{(p) => <input {...p} value={it.docType} maxLength={60} onChange={(e) => update(k, { docType: e.target.value })} />}</Field>
              <Field label={`Owner role ${k + 1}`}>
                {(p) => (
                  <select {...p} value={it.ownerRole} onChange={(e) => update(k, { ownerRole: e.target.value })}>
                    <RoleOptions />
                  </select>
                )}
              </Field>
              <label className="check"><input type="checkbox" checked={it.required} onChange={(e) => update(k, { required: e.target.checked })} /> Required</label>
              <button type="button" className="btn sm rmcontact" onClick={() => setItems((xs) => xs.filter((_, i) => i !== k))}>Remove document {k + 1}</button>
            </div>
          ))}
          <button type="button" className="btn sm addcontact" disabled={items.length >= 50}
            onClick={() => setItems((xs) => [...xs, { docType: "", ownerRole: "hr", required: true }])}>Add document</button>
        </fieldset>
        {err && <p className="error" role="alert">{err}</p>}
        <DialogActions onCancel={onClose} submitLabel="Publish version" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
