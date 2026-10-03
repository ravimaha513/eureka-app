import { useId, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLACEMENT_STATUSES, ROLES, ROLE_LABELS, type Role } from "@eureka/shared";
import { ApiError, type Me } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { Drawer, Field, fmtDate } from "../sales/ui";
import { PLACEMENT_TYPE_LABELS, fmtDateTime, pipelineLabel, type PlacementType } from "../pipeline/pipelineApi";
import { PipelineStatus } from "../pipeline/ui";
import { docTypeLabel } from "../pipeline/PlacementsPage";
import { DocumentsSection } from "../documents/DocumentsSection";
import { documentKeys, documentsApi } from "../documents/documentsApi";
import {
  BGC_REASON_REQUIRED, BGC_STATUSES, ITEM_REASON_REQUIRED, PAPERWORK_ERRORS,
  paperworkApi, paperworkKeys, paperworkLabel,
  type Bgc, type BgcChange, type HistoryEntry, type ItemChange, type PaperworkItem, type QueueFilters, type QueueRow,
  type TemplateItem, type TemplateVersion,
} from "./paperworkApi";

const PAGE_SIZE = 50;
const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? paperworkLabel(r);

export function paperworkError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && PAPERWORK_ERRORS[e.detail]) return PAPERWORK_ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that for this record.";
    case 404: return "This placement's paperwork doesn't exist or is outside your scope.";
    case 409: return PAPERWORK_ERRORS.version_mismatch!;
    case 422: return e.errors?.length ? "Some fields need attention. Check the values and try again." : "The server rejected this change.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

export const BgcBadge = ({ status }: { status: string }) => <span className={`badge bgc-${status}`}>{paperworkLabel(status)}</span>;

/** "Paperwork & BGC": the work queue (HR, Accounts, Immigration, Documents Team) and, for org-wide roles, the templates. */
export function PaperworkPage({ me }: { me: Pick<Me, "id" | "roles" | "capabilities"> }) {
  const templates = useQuery({ queryKey: paperworkKeys.templates, queryFn: paperworkApi.templates, retry: false });
  const [tab, setTab] = useState<"queue" | "templates">("queue");
  const showTemplates = templates.isSuccess;
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
        : <WorkQueue me={me} />}
    </>
  );
}

const VIEWS = [["outstanding", "Outstanding"], ["overdue", "Overdue"], ["all", "All"]] as const;

function WorkQueue({ me }: { me: Pick<Me, "id" | "roles" | "capabilities"> }) {
  const [view, setViewRaw] = useState<"outstanding" | "overdue" | "all">("outstanding");
  const [ownerRole, setOwnerRaw] = useState("");
  const [mine, setMineRaw] = useState(false);
  const [bgcStatus, setBgcRaw] = useState("");
  const [placementStatus, setPlStatusRaw] = useState("");
  const [placementType, setTypeRaw] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [openId, setOpenId] = useState<string | null>(null);
  const page = cursors.length - 1;
  const reset = () => setCursors([null]);
  const set = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); reset(); };

  const filters: QueueFilters = { view, ownerRole, mine, bgcStatus, placementStatus, placementType, cursor: cursors[page] ?? "", limit: PAGE_SIZE };
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
              {ROLES.filter((r) => r !== "org_admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
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
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
          <p className="empty error" role="alert">{paperworkError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
        ) : (
          <table aria-label="Paperwork queue" aria-busy={q.isFetching || undefined}>
            <thead><tr><th>Candidate</th><th>Placement</th><th>Checklist</th><th>Next due</th><th>BGC</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((r) => <QueueTableRow key={r.placementId} r={r} onOpen={() => setOpenId(r.placementId)} />)}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="empty">{hasFilters ? "No placements match these filters." : "Nothing outstanding. New placements appear here with their paperwork."}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="listfoot">
        <p role="status" aria-live="polite" className="muted">{countMsg}</p>
        <nav className="pager" aria-label="Paperwork pages">
          <button type="button" className="btn sm" disabled={page === 0} onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn sm" disabled={!q.data?.nextCursor || q.isPlaceholderData}
            onClick={() => { const nx = q.data?.nextCursor; if (nx) setCursors((c) => [...c, nx]); }}>Next</button>
        </nav>
      </div>
      {openId && <PaperworkDrawer placementId={openId} me={me} onClose={() => setOpenId(null)} />}
    </>
  );
}

function QueueTableRow({ r, onOpen }: { r: QueueRow; onOpen: () => void }) {
  const done = r.checklist.total - r.checklist.open;
  const name = r.candidate.name ?? "Candidate";
  return (
    <tr>
      <td><b>{name}</b><span className="block">{r.recruiter.name}</span></td>
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

function PaperworkDrawer({ placementId, me, onClose }: { placementId: string; me: Pick<Me, "id" | "roles">; onClose: () => void }) {
  const hid = useId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: paperworkKeys.detail(placementId), queryFn: () => paperworkApi.detail(placementId) });
  const [editItem, setEditItem] = useState<PaperworkItem | null>(null);
  const [editBgc, setEditBgc] = useState(false);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const d = q.data;
  const done = (m: string) => {
    setMessage(m);
    void qc.invalidateQueries({ queryKey: paperworkKeys.all });
    void qc.invalidateQueries({ queryKey: ["placements"] });
  };
  return (
    <>
      <Drawer title={d ? `Paperwork · ${d.candidate.name ?? "Candidate"}` : "Paperwork"} onClose={onClose} wide
        suspended={editItem !== null || editBgc} closeLabel="Close paperwork details">
        {q.isLoading ? <p className="empty">Loading…</p> : !d ? <p className="error" role="alert">{paperworkError(q.error)}</p> : (
          <>
            <dl className="facts">
              <dt>Candidate</dt><dd>{d.candidate.name ?? "—"}</dd>
              <dt>Recruiter</dt><dd>{d.recruiter.name ?? "—"}</dd>
              {d.placement && <>
                <dt>Placement</dt><dd><PipelineStatus status={d.placement.status} /> {PLACEMENT_TYPE_LABELS[d.placement.placementType as PlacementType] ?? d.placement.placementType}</dd>
                <dt>Client</dt><dd>{d.placement.client?.name ?? "—"}</dd>
                <dt>Tentative start</dt><dd>{fmtDate(d.placement.tentativeStart)}</dd>
              </>}
            </dl>
            <p role="status" aria-live="polite" className="livemsg">{message}</p>

            <section className="manageblock" aria-labelledby={`${hid}-k`}>
              <h3 id={`${hid}-k`}>Paperwork checklist</h3>
              {d.items.length === 0 ? <p className="muted">No paperwork checklist for this placement.</p> : (
                <>
                  <p className="muted">{d.checklist.total - d.checklist.open} of {d.checklist.total} done
                    {d.checklist.overdue > 0 && `, ${d.checklist.overdue} overdue`}.</p>
                  <table className="mini" aria-labelledby={`${hid}-k`}>
                    <thead><tr><th>Document</th><th>Owner</th><th>Status</th><th>Due</th><th><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {d.items.map((i) => (
                        <tr key={i.id}>
                          <td>{docTypeLabel(i.docType)}<span className="block">{i.required ? "Required" : "Optional"}
                            {i.assignee && ` · ${i.assignee.name ?? "assigned"}`}{i.documentId && " · document linked"}</span>
                            {i.notes && <span className="block note">{i.notes}</span>}</td>
                          <td>{roleLabel(i.ownerRole)}</td>
                          <td><span className={`badge cl-${i.status}`}>{paperworkLabel(i.status)}</span>
                            {i.statusReason && <span className="block muted">{i.statusReason}</span>}</td>
                          <td>{i.dueOn ? fmtDate(i.dueOn) : <span className="muted">—</span>}{i.overdue && <> <span className="badge overdue">Overdue</span></>}</td>
                          <td className="rowactions">
                            {(i.actions.transition.length > 0 || i.actions.editNotes || i.actions.assign) && (
                              <button type="button" className="btn sm" onClick={() => setEditItem(i)} aria-label={`Update ${docTypeLabel(i.docType)}`}>Update</button>
                            )}
                            <button type="button" className="btn sm" aria-expanded={historyOf === i.id}
                              onClick={() => setHistoryOf(historyOf === i.id ? null : i.id)} aria-label={`History of ${docTypeLabel(i.docType)}`}>History</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {historyOf && <ItemHistory itemId={historyOf} label={docTypeLabel(d.items.find((i) => i.id === historyOf)?.docType ?? "")} />}
                </>
              )}
            </section>

            {/* Upload and open documents here (0043); a placement the caller cannot read files them on the candidate. */}
            <DocumentsSection owner={d.placement ? { kind: "placement", id: placementId } : { kind: "candidate", id: d.candidate.id }}
              title={d.placement ? "Placement documents" : "Candidate documents"} />

            <BgcSection hid={hid} bgc={d.bgc} onEdit={() => setEditBgc(true)} />
          </>
        )}
      </Drawer>
      {d && editItem && (
        <ItemDialog item={editItem} me={me} candidateId={d.candidate.id} placementId={placementId} onClose={() => setEditItem(null)}
          onDone={(m) => { setEditItem(null); done(m); }} />
      )}
      {d && editBgc && (
        <BgcDialog placementId={placementId} bgc={d.bgc} onClose={() => setEditBgc(false)}
          onDone={(m) => { setEditBgc(false); done(m); }} />
      )}
    </>
  );
}

const CHANGED_LABELS: Record<string, string> = {
  status: "status", owner_role: "owner role", assignee: "assignee", due_on: "due date", notes: "notes", document: "document link",
  bgc_company: "BGC company", initiated_on: "initiated date", completed_on: "completed date", helped_by: "helped by",
  education_level: "education level", employment_years: "employment years", address_years: "address years",
};

function HistoryList({ entries, label }: { entries: HistoryEntry[]; label: string }) {
  if (entries.length === 0) return <p className="muted">No changes yet.</p>;
  return (
    <ul className="history" aria-label={label}>
      {entries.map((e, k) => (
        <li key={k}>
          <b>{fmtDateTime(e.at)}</b> · {e.actor?.name ?? "System"}:{" "}
          {e.from !== null && e.to !== null ? `${paperworkLabel(e.from)} → ${paperworkLabel(e.to)}` : "updated"}
          {e.changed.filter((c) => c !== "status").length > 0 && ` (${e.changed.filter((c) => c !== "status").map((c) => CHANGED_LABELS[c] ?? c).join(", ")})`}
          {e.reason && <span className="block muted">Reason: {e.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function ItemHistory({ itemId, label }: { itemId: string; label: string }) {
  const q = useQuery({ queryKey: paperworkKeys.history(itemId), queryFn: () => paperworkApi.itemHistory(itemId) });
  return q.isLoading ? <p className="muted">Loading history…</p> : q.error ? <p className="error" role="alert">{paperworkError(q.error)}</p>
    : <HistoryList entries={q.data!.items} label={`History of ${label}`} />;
}

function BgcSection({ hid, bgc, onEdit }: { hid: string; bgc: Bgc; onEdit: () => void }) {
  return (
    <section className="manageblock" aria-labelledby={`${hid}-b`}>
      <h3 id={`${hid}-b`}>Background check</h3>
      <dl className="facts">
        <dt>Status</dt><dd><BgcBadge status={bgc.status} />{bgc.statusReason && <span className="block muted">{bgc.statusReason}</span>}</dd>
        <dt>BGC company</dt><dd>{bgc.bgcCompany ?? "—"}</dd>
        <dt>Initiated</dt><dd>{fmtDate(bgc.initiatedOn)}</dd>
        <dt>Completed</dt><dd>{fmtDate(bgc.completedOn)}</dd>
        <dt>Helped by</dt><dd>{bgc.helpedBy?.name ?? "—"}</dd>
        <dt>Education level</dt><dd>{bgc.educationLevel ?? "—"}</dd>
        <dt>Employment years</dt><dd>{bgc.employmentYears ?? "—"}</dd>
        <dt>Address years</dt><dd>{bgc.addressYears ?? "—"}</dd>
        {bgc.notes && <><dt>Notes</dt><dd>{bgc.notes}</dd></>}
      </dl>
      {bgc.actions.update && <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={onEdit}>Update background check</button>}
      <HistoryList entries={bgc.history} label="Background check history" />
    </section>
  );
}

/**
 * Documents (0043) of the item's candidate that may be linked: candidate-level ones and
 * those filed on this placement. The list follows the caller's document scope (restricted
 * documents only for roles that read them); the server checks the link again (PW-5).
 */
function DocumentPicker({ candidateId, placementId, current, value, onChange }: {
  candidateId: string; placementId: string; current: string | null; value: string; onChange: (v: string) => void;
}) {
  const q = useQuery({ queryKey: documentKeys.list({ kind: "candidate", id: candidateId }), queryFn: () => documentsApi.list({ kind: "candidate", id: candidateId }) });
  const docs = (q.data?.items ?? []).filter((d) => (d.placementId === null || d.placementId === placementId)
    && (d.status === "pending" || d.status === "clean"));
  return (
    <Field label="Linked document" hint={q.isError ? "Documents could not be loaded." : "Upload new files in the Documents section of this drawer."}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">No document</option>
          {current && !docs.some((d) => d.id === current) && <option value={current}>Current document</option>}
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.docTypeLabel} · {fmtDate(d.createdAt)}{d.placementId ? " · this placement" : ""}{d.status === "pending" ? " (scanning)" : ""}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function ItemDialog({ item, me, candidateId, placementId, onClose, onDone }: {
  item: PaperworkItem; me: Pick<Me, "id" | "roles">; candidateId: string; placementId: string;
  onClose: () => void; onDone: (m: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [ownerRole, setOwnerRole] = useState(item.ownerRole);
  const [assignee, setAssignee] = useState(item.assignee?.id ?? "");
  const [dueOn, setDueOn] = useState(item.dueOn ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [docId, setDocId] = useState(item.documentId ?? "");
  const [fieldErr, setFieldErr] = useState<{ reason?: string; form?: string }>({});
  const submit = useSubmit(paperworkError);
  const a = item.actions;
  const iHoldOwner = me.roles.some((r) => r.key === ownerRole);
  const needsReason = status !== "" && ITEM_REASON_REQUIRED.has(status);
  const name = docTypeLabel(item.docType);

  const build = (): ItemChange => {
    const b: ItemChange = { expectedVersion: item.version };
    if (status) { b.status = status; if (reason.trim()) b.reason = reason.trim(); }
    if (a.assign) {
      if (ownerRole !== item.ownerRole) b.ownerRole = ownerRole;
      if (assignee !== (item.assignee?.id ?? "")) b.assigneeId = assignee || null;
      if (dueOn !== (item.dueOn ?? "")) b.dueOn = dueOn || null;
    }
    if (a.editNotes && notes.trim() !== (item.notes ?? "")) b.notes = notes.trim() || null;
    if (a.editNotes && docId !== (item.documentId ?? "")) b.documentId = docId || null;
    return b;
  };

  return (
    <Dialog title={`Update ${name}`} onClose={onClose}>
      <form ref={formRef} noValidate onSubmit={(e) => {
        e.preventDefault();
        const b = build();
        if (needsReason && !reason.trim()) { setFieldErr({ reason: "Give a reason." }); formRef.current?.querySelector<HTMLElement>("textarea")?.focus(); return; }
        if (Object.keys(b).length === 1) { setFieldErr({ form: "Change at least one field." }); return; }
        setFieldErr({});
        void submit.run(async () => {
          const r = await paperworkApi.updateItem(item.id, b);
          onDone(b.status ? `${name} marked ${paperworkLabel(r.status)}.` : `${name} updated.`);
        });
      }}>
        {a.transition.length > 0 && (
          <Field label="Status" hint={`Now ${paperworkLabel(item.status)}.`}>
            {(p) => (
              <select {...p} value={status} onChange={(e) => setStatus(e.target.value)} data-autofocus>
                <option value="">No change</option>
                {a.transition.map((t) => <option key={t} value={t}>{t === "pending" ? "Back to pending (return or reopen)" : paperworkLabel(t)}</option>)}
              </select>
            )}
          </Field>
        )}
        {status !== "" && (
          <Field label={needsReason ? "Reason" : "Reason (optional)"} hint="Up to 500 characters. Visible to paperwork roles; never in the audit log." error={fieldErr.reason}>
            {(p) => <textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        )}
        {a.assign && (
          <div className="grid2">
            <Field label="Owner role">
              {(p) => (
                <select {...p} value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
                  {ROLES.filter((r) => r !== "org_admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              )}
            </Field>
            <Field label="Due date">
              {(p) => <input {...p} type="date" min="2000-01-01" max="2100-12-31" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />}
            </Field>
            <Field label="Assignee" hint="Assignees must hold the owner role.">
              {(p) => (
                <select {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Unassigned</option>
                  {item.assignee && item.assignee.id !== me.id && <option value={item.assignee.id}>{item.assignee.name ?? "Current assignee"}</option>}
                  {(iHoldOwner || assignee === me.id) && <option value={me.id}>Me</option>}
                </select>
              )}
            </Field>
          </div>
        )}
        {a.editNotes && (
          <Field label="Notes" hint="Up to 1000 characters. Avoid personal data such as numbers from documents.">
            {(p) => <textarea {...p} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        )}
        {a.editNotes && <DocumentPicker candidateId={candidateId} placementId={placementId} current={item.documentId} value={docId} onChange={setDocId} />}
        {fieldErr.form && <p className="error" role="alert">{fieldErr.form}</p>}
        <DialogActions onCancel={onClose} submitLabel="Save" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}

function BgcDialog({ placementId, bgc, onClose, onDone }: { placementId: string; bgc: Bgc; onClose: () => void; onDone: (m: string) => void }) {
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [company, setCompany] = useState(bgc.bgcCompany ?? "");
  const [initiatedOn, setInitiated] = useState(bgc.initiatedOn ?? "");
  const [completedOn, setCompleted] = useState(bgc.completedOn ?? "");
  const [education, setEducation] = useState(bgc.educationLevel ?? "");
  const [employment, setEmployment] = useState(bgc.employmentYears === null ? "" : String(bgc.employmentYears));
  const [address, setAddress] = useState(bgc.addressYears === null ? "" : String(bgc.addressYears));
  const [notes, setNotes] = useState(bgc.notes ?? "");
  const [failPlacement, setFailPlacement] = useState(false);
  const [err, setErr] = useState<{ reason?: string; form?: string }>({});
  const submit = useSubmit(paperworkError);
  const willFail = status === "failed" || (status === "" && bgc.status === "failed");
  const needsReason = status !== "" && BGC_REASON_REQUIRED.has(status);

  const build = (): BgcChange => {
    const b: BgcChange = bgc.version === null ? {} : { expectedVersion: bgc.version };
    const text = (v: string, old: string | null, k: "bgcCompany" | "educationLevel" | "notes") => { if (v.trim() !== (old ?? "")) b[k] = v.trim() || null; };
    const date = (v: string, old: string | null, k: "initiatedOn" | "completedOn") => { if (v !== (old ?? "")) b[k] = v || null; };
    const num = (v: string, old: number | null, k: "employmentYears" | "addressYears") => { if (v !== (old === null ? "" : String(old))) b[k] = v === "" ? null : Number(v); };
    if (status) { b.status = status; if (reason.trim()) b.reason = reason.trim(); }
    text(company, bgc.bgcCompany, "bgcCompany");
    date(initiatedOn, bgc.initiatedOn, "initiatedOn");
    date(completedOn, bgc.completedOn, "completedOn");
    text(education, bgc.educationLevel, "educationLevel");
    num(employment, bgc.employmentYears, "employmentYears");
    num(address, bgc.addressYears, "addressYears");
    text(notes, bgc.notes, "notes");
    if (failPlacement && willFail && bgc.actions.failPlacement) b.failPlacement = true;
    return b;
  };

  return (
    <Dialog title="Update background check" onClose={onClose}>
      <form noValidate onSubmit={(e) => {
        e.preventDefault();
        const b = build();
        if (needsReason && !reason.trim()) { setErr({ reason: "Give a reason." }); e.currentTarget.querySelector<HTMLElement>("textarea")?.focus(); return; }
        if (Object.keys(b).filter((k) => k !== "expectedVersion").length === 0) { setErr({ form: "Change at least one field." }); return; }
        setErr({});
        void submit.run(async () => {
          const r = await paperworkApi.updateBgc(placementId, b);
          onDone(b.failPlacement ? "Background check failed; placement marked BGC failed." : `Background check ${b.status ? `marked ${paperworkLabel(r.status)}` : "updated"}.`);
        });
      }}>
        {bgc.actions.transition.length > 0 && (
          <Field label="Status" hint={`Now ${paperworkLabel(bgc.status)}.`}>
            {(p) => (
              <select {...p} value={status} onChange={(e) => setStatus(e.target.value)} data-autofocus>
                <option value="">No change</option>
                {bgc.actions.transition.map((t) => <option key={t} value={t}>{paperworkLabel(t)}</option>)}
              </select>
            )}
          </Field>
        )}
        {status !== "" && (
          <Field label={needsReason ? "Reason" : "Reason (optional)"} hint="Up to 500 characters; never in the audit log." error={err.reason}>
            {(p) => <textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        )}
        {willFail && bgc.actions.failPlacement && (
          <label className="check"><input type="checkbox" checked={failPlacement} onChange={(e) => setFailPlacement(e.target.checked)} />
            {" "}Also mark the placement BGC failed (same rules as on Placements)</label>
        )}
        <div className="grid2">
          <Field label="BGC company">{(p) => <input {...p} maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />}</Field>
          <Field label="Education level">{(p) => <input {...p} maxLength={60} value={education} onChange={(e) => setEducation(e.target.value)} />}</Field>
          <Field label="Initiated on">{(p) => <input {...p} type="date" value={initiatedOn} onChange={(e) => setInitiated(e.target.value)} />}</Field>
          <Field label="Completed on">{(p) => <input {...p} type="date" value={completedOn} onChange={(e) => setCompleted(e.target.value)} />}</Field>
          <Field label="Employment years">{(p) => <input {...p} type="number" min={0} max={50} value={employment} onChange={(e) => setEmployment(e.target.value)} />}</Field>
          <Field label="Address years">{(p) => <input {...p} type="number" min={0} max={50} value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
        </div>
        <Field label="Notes" hint="Up to 1000 characters. Avoid personal data.">
          {(p) => <textarea {...p} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        {err.form && <p className="error" role="alert">{err.form}</p>}
        <DialogActions onCancel={onClose} submitLabel="Save" busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
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
          <table className="mini" aria-label={`${paperworkLabel(kind)} templates`}>
            <thead><tr><th>Placement type</th><th>Version</th><th>Documents</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {TYPES.map((type) => {
                const t = latest(kind, type);
                return (
                  <tr key={type}>
                    <td>{PLACEMENT_TYPE_LABELS[type]}</td>
                    <td>{t ? `v${t.version} · ${fmtDate(t.publishedAt)}` : <span className="muted">None</span>}</td>
                    <td>{t && t.items.length ? t.items.map((i) => `${docTypeLabel(i.docType)} (${roleLabel(i.ownerRole)}${i.required ? "" : ", optional"})`).join("; ") : <span className="muted">No documents</span>}</td>
                    <td className="rowactions">{canPublish && (
                      <button type="button" className="btn sm" onClick={() => setEditing({ kind, placementType: type, current: t })}
                        aria-label={`New ${paperworkLabel(kind).toLowerCase()} version for ${PLACEMENT_TYPE_LABELS[type]}`}>New version</button>
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                    {ROLES.filter((r) => r !== "org_admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
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
