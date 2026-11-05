import { useId, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLACEMENT_STATUSES } from "@eureka/shared";
import type { Me } from "../api";
import { RoleName, RoleOptions, useLookups } from "../lookups";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Field, fmtDate } from "../sales/ui";
import { PLACEMENT_TYPE_LABELS, pipelineLabel, type PlacementType } from "../pipeline/pipelineApi";
import { PipelineStatus } from "../pipeline/ui";
import { docTypeLabel } from "../lib/format";
import { useRoutedId, useSearchParams } from "../lib/router";
import { FilterBar, type FilterChip } from "../ui/FilterBar";
import { Tabs } from "../ui/Tabs";
import { RecordLink } from "../ui/RecordLink";
import { DueDate, ToggleGroup, fmtDay, fromControl } from "../payments/cells";
import "./paperwork.css";
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
  if (openId) return <PaperworkWorkspace key={openId} placementId={openId} me={me} onBack={() => setOpenId(null)} />;
  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Paperwork &amp; BGC</h1>
          <p className="sub">Outstanding paperwork, overdue items and background checks for the placements in your scope.</p>
        </div>
      </div>
      {templates.isSuccess ? (
        // Sections are real tabs (underline); the queue's "Show" filter is a toggle group, so the two never look alike.
        <Tabs label="Paperwork sections" urlKey="section" tabs={[{ key: "queue", label: "Work queue" }, { key: "templates", label: "Templates" }]}
          className="pw-sections" panelClassName="pw-sectionpanel">
          {(tab) => tab === "templates"
            ? <TemplatesPanel templates={templates.data.templates} canPublish={templates.data.canPublish} />
            : <WorkQueue onOpen={setOpenId} />}
        </Tabs>
      ) : <WorkQueue onOpen={setOpenId} />}
    </>
  );
}

const VIEWS = [["outstanding", "Outstanding"], ["overdue", "Overdue"], ["all", "All"]] as const;
type View = (typeof VIEWS)[number][0];
const SORTS = [["overdue", "Most overdue first"], ["due", "Next due first"], ["queue", "Queue order"]] as const;
type Sort = (typeof SORTS)[number][0];
const PLACEMENT_TYPES = ["c2c", "w2", "1099"] as const;
const FILTER_KEYS = ["view", "role", "mine", "bgc", "pstatus", "ptype", "sort"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Most urgent first: overdue count, then the earliest next due date, then candidate name (within the loaded page). */
function sortRows(rows: QueueRow[], sort: Sort): QueueRow[] {
  if (sort === "queue") return rows;
  const due = (r: QueueRow) => r.checklist.nextDue ?? "9999-12-31";
  return [...rows].sort((a, b) =>
    (sort === "overdue" ? b.checklist.overdue - a.checklist.overdue : 0)
    || due(a).localeCompare(due(b))
    || (a.candidate.name ?? "").localeCompare(b.candidate.name ?? ""));
}

function WorkQueue({ onOpen }: { onOpen: (placementId: string) => void }) {
  const id = useId();
  const roles = useLookups().data?.roles ?? [];
  const [p, setP] = useSearchParams(FILTER_KEYS);
  const view: View = VIEWS.some(([k]) => k === p.view) ? (p.view as View) : "outstanding";
  const sort: Sort = SORTS.some(([k]) => k === p.sort) ? (p.sort as Sort) : "overdue";
  const mine = p.mine === "1";
  const pager = useCursorPager();
  const { page, reset } = pager;
  /** Every filter change starts again on page 1; filters live in the URL. */
  const set = (patch: Partial<Record<FilterKey, string>>) => { setP(patch); reset(); };

  const filters: QueueFilters = {
    view, ownerRole: p.role, mine, bgcStatus: p.bgc, placementStatus: p.pstatus, placementType: p.ptype, cursor: pager.cursor ?? "", limit: PAGE_SIZE,
  };
  const q = useQuery({ queryKey: paperworkKeys.queue(filters), queryFn: () => paperworkApi.queue(filters), placeholderData: keepPreviousData });
  const rows = useMemo(() => sortRows(q.data?.items ?? [], sort), [q.data, sort]);
  const hasFilters = Boolean(p.role || mine || p.bgc || p.pstatus || p.ptype || view !== "outstanding");
  const n = rows.length;
  const more = q.data?.nextCursor ? "+" : "";
  const countMsg = q.isLoading || q.error ? "" : `${n} ${n === 1 ? "placement" : "placements"} on page ${page + 1}${q.data?.nextCursor ? ", more on the next page" : ""}.`;

  const chips: FilterChip[] = [];
  if (p.role) chips.push({ key: "role", label: `Owner role: ${roles.find((r) => r.id === p.role)?.name ?? p.role}`, onRemove: () => set({ role: "" }) });
  if (mine) chips.push({ key: "mine", label: "Assigned to me", onRemove: () => set({ mine: "" }) });
  if (p.bgc) chips.push({ key: "bgc", label: `BGC: ${paperworkLabel(p.bgc)}`, onRemove: () => set({ bgc: "" }) });
  if (p.pstatus) chips.push({ key: "pstatus", label: `Placement: ${pipelineLabel(p.pstatus)}`, onRemove: () => set({ pstatus: "" }) });
  if (p.ptype) chips.push({ key: "ptype", label: `Type: ${PLACEMENT_TYPE_LABELS[p.ptype as PlacementType] ?? p.ptype}`, onRemove: () => set({ ptype: "" }) });
  const moreSet = [p.pstatus, p.ptype].filter(Boolean).length;

  return (
    <>
      <FilterBar label="Paperwork filters" chips={chips} moreCount={moreSet} activeCount={chips.length}
        hasFilters={hasFilters} onClear={() => set({ view: "", role: "", mine: "", bgc: "", pstatus: "", ptype: "" })}
        search={<ToggleGroup label="Show" className="pw-view" options={VIEWS} value={view} onChange={(v) => set({ view: v === "outstanding" ? "" : v })} />}
        primary={
          <>
            <div className="field inline">
              <label htmlFor={`${id}-role`}>Owner role</label>
              <select id={`${id}-role`} value={p.role} onChange={(e) => set({ role: e.target.value })}>
                <option value="">Any role</option>
                <RoleOptions />
              </select>
            </div>
            <div className="field inline">
              <label htmlFor={`${id}-bgc`}>BGC status</label>
              <select id={`${id}-bgc`} value={p.bgc} onChange={(e) => set({ bgc: e.target.value })}>
                <option value="">Any</option>
                {BGC_STATUSES.map((s) => <option key={s} value={s}>{paperworkLabel(s)}</option>)}
              </select>
            </div>
            <label className="check pw-mine"><input type="checkbox" checked={mine} onChange={(e) => set({ mine: e.target.checked ? "1" : "" })} /> Assigned to me</label>
          </>
        }
        more={
          <>
            <div className="field inline">
              <label htmlFor={`${id}-ps`}>Placement status</label>
              <select id={`${id}-ps`} value={p.pstatus} onChange={(e) => set({ pstatus: e.target.value })}>
                <option value="">Any</option>
                {PLACEMENT_STATUSES.map((s) => <option key={s} value={s}>{pipelineLabel(s)}</option>)}
              </select>
            </div>
            <div className="field inline">
              <label htmlFor={`${id}-pt`}>Placement type</label>
              <select id={`${id}-pt`} value={p.ptype} onChange={(e) => set({ ptype: e.target.value })}>
                <option value="">Any</option>
                {PLACEMENT_TYPES.map((t) => <option key={t} value={t}>{PLACEMENT_TYPE_LABELS[t]}</option>)}
              </select>
            </div>
          </>
        }
        summaryEnd={
          <>
            <div className="field inline fb-sort">
              <label htmlFor={`${id}-sort`}>Sort</label>
              <select id={`${id}-sort`} value={sort} onChange={(e) => setP({ sort: e.target.value === "overdue" ? "" : e.target.value })}>
                {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {!q.isLoading && !q.error && <span className="muted pw-count">{n}{more} {n === 1 && !more ? "placement" : "placements"}</span>}
          </>
        } />

      <div className="card tablewrap listcard">
        {q.isLoading ? <Loading /> : q.error ? (
          <QueryError query={q} message={paperworkError(q.error)} />
        ) : (
          <table className="dtable bo-dtable pwqueue" aria-label="Paperwork queue" aria-busy={q.isFetching || undefined}>
            <thead><tr>
              <th>Candidate</th><th>BGC</th><th>Checklist</th><th className="num">Overdue</th><th>Next due</th>
              <th>Placement</th><th className="p2">Client · type</th><th className="p3">Starts</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => <QueueTableRow key={r.placementId} r={r} onOpen={() => onOpen(r.placementId)} />)}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="empty">{hasFilters ? "No placements match these filters." : "Nothing outstanding. New placements appear here with their paperwork."}</td></tr>
              )}
            </tbody>
          </table>
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
  const type = r.placement ? PLACEMENT_TYPE_LABELS[r.placement.placementType as PlacementType] ?? r.placement.placementType : null;
  return (
    <tr className="rowopen" onClick={(e) => { if (!fromControl(e)) onOpen(); }}>
      <td className="c-primary">
        <RecordLink kind="paperwork" id={r.placementId} onOpen={onOpen}><b>{name}</b></RecordLink>
        <span className="block">{r.recruiter.name}</span>
      </td>
      <td className="c-badge" data-label="BGC"><BgcBadge status={r.bgc.status} /></td>
      <td data-label="Checklist">{r.checklist.total === 0 ? <span className="muted">No checklist</span> : (
        <span className="pw-progress">
          <span>{done} of {r.checklist.total} done</span>
          <span className="pw-bar" aria-hidden="true"><span style={{ width: `${Math.round((done / r.checklist.total) * 100)}%` }} /></span>
          {r.checklist.requiredOpen > 0 && <span className="block">{r.checklist.requiredOpen} required open</span>}
        </span>
      )}</td>
      <td className="num" data-label="Overdue">{r.checklist.overdue > 0
        ? <span className="badge overdue">{r.checklist.overdue} overdue</span>
        : <span className="muted">—</span>}</td>
      <td data-label="Next due"><DueDate on={r.checklist.nextDue} done={r.checklist.overdue === 0} /></td>
      <td data-label="Placement">{r.placement ? <PipelineStatus status={r.placement.status} /> : <span className="muted">Not visible to you</span>}</td>
      <td className="p2" data-label="Client · type">{r.placement ? <>{r.placement.client?.name ?? "—"}<span className="block">{type}</span></> : <span className="muted">—</span>}</td>
      <td className="p3" data-label="Starts">{r.placement ? fmtDay(r.placement.tentativeStart) : "—"}</td>
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
