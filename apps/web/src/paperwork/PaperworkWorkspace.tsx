import { Fragment, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "../api";
import { RoleName, RoleOptions } from "../lookups";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { Field, fmtDate } from "../sales/ui";
import { PLACEMENT_TYPE_LABELS, fmtDateTime, type PlacementType } from "../pipeline/pipelineApi";
import { PipelineStatus } from "../pipeline/ui";
import { docTypeLabel } from "../lib/format";
import { useSearchParam } from "../lib/router";
import { Tabs } from "../ui/Tabs";
import { DueDate } from "../payments/cells";
import "./paperwork.css";
import { DocumentsSection } from "../documents/DocumentsSection";
import { documentKeys, documentsApi } from "../documents/documentsApi";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import {
  bgcReasonRequired, ENTRY_VERIFICATIONS, ITEM_REASON_REQUIRED, paperworkApi, paperworkKeys, paperworkLabel,
  type Bgc, type BgcChange, type BgcEntry, type EntryFields, type EntryKind, type EntryVerification, type HistoryEntry,
  type ItemChange, type PaperworkDetail, type PaperworkItem,
} from "./paperworkApi";
import { BgcBadge, paperworkError } from "./ui";

/**
 * One placement's paperwork on its own page (/paperwork/<placementId>): documents, the
 * checklist, the background check with its employment and address history rows, and the
 * activity. Replaces the drawer, which had no room for multi-row history.
 */

type Tab = "documents" | "checklist" | "bgc" | "activity";
const TABS: { key: Tab; label: string }[] = [
  { key: "documents", label: "Documents" },
  { key: "checklist", label: "Checklist" },
  { key: "bgc", label: "Background check" },
  { key: "activity", label: "Activity" },
];

export function PaperworkWorkspace({ placementId, me, onBack }: {
  placementId: string; me: Pick<Me, "id" | "roles">; onBack: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: paperworkKeys.detail(placementId), queryFn: () => paperworkApi.detail(placementId) });
  const [, setTabParam] = useSearchParam("tab");
  const [message, setMessage] = useState("");
  const hid = useId();
  const done = (m: string) => {
    setMessage(m);
    void qc.invalidateQueries({ queryKey: paperworkKeys.all });
    void qc.invalidateQueries({ queryKey: ["placements"] });
  };
  const back = <button type="button" className="btn backbtn" onClick={onBack}>← Paperwork &amp; BGC</button>;

  if (q.isLoading) return <>{back}<Loading page /></>;
  if (!q.data) return <>{back}<QueryError query={q} message={paperworkError(q.error)} /></>;
  const d = q.data;
  const name = d.candidate.name ?? "Candidate";
  const attention = needsAttention(d);
  // Open on the work: the first tab with something to do, else the checklist; documents only without a checklist.
  const defaultTab: Tab = attention[0]?.tab ?? (d.items.length > 0 ? "checklist" : "documents");
  const tabs = TABS.map((t) => ({
    key: t.key,
    label: t.key === "checklist" && d.checklist.total > 0
      ? <>{t.label}<span className="tabcount" aria-hidden="true" title={`${d.checklist.open} open`}>{d.checklist.open}</span></>
      : t.key === "bgc" && attention.some((a) => a.tab === "bgc")
        ? <>{t.label}<span className="tabdot" aria-hidden="true" title="Needs attention" /></>
        : t.label,
  }));
  const doneCount = d.checklist.total - d.checklist.open;

  return (
    <>
      {back}
      <div className="pwhead">
        <div>
          <h1 tabIndex={-1}>{name}</h1>
          <p className="sub pwsub">
            {d.placement ? (<>
              <PipelineStatus status={d.placement.status} />
              <span>{PLACEMENT_TYPE_LABELS[d.placement.placementType as PlacementType] ?? d.placement.placementType}</span>
              {d.placement.client && <span>· {d.placement.client.name}</span>}
              <span>· starts {fmtDate(d.placement.tentativeStart)}</span>
            </>) : <span>Placement not visible to you</span>}
            {d.recruiter.name && <span>· Recruiter {d.recruiter.name}</span>}
          </p>
        </div>
      </div>

      {/* Action strip: where this placement stands and what needs doing, before any facts. */}
      <div className="actionstrip pw-strip" role="region" aria-label="Summary">
        <div className="as-status">
          <span className="pw-stripstat">Checklist {d.checklist.total === 0 ? <span className="muted">none</span> : `${doneCount} of ${d.checklist.total} done`}</span>
          {d.checklist.overdue > 0 && <span className="badge overdue">{d.checklist.overdue} overdue</span>}
          {d.checklist.requiredOpen > 0 && <span className="badge on_hold">{d.checklist.requiredOpen} required open</span>}
          <span className="pw-stripsep" aria-hidden="true" />
          <span className="pw-stripstat">Background check</span> <BgcBadge status={d.bgc.status} />
        </div>
        {attention.length > 0 && (
          <div className="as-actions" role="group" aria-label="Needs attention">
            {attention.map((a, k) => (
              <button key={k} type="button" className={`btn sm${k === 0 ? " primary" : ""}`} onClick={() => setTabParam(a.tab === defaultTab ? "" : a.tab)}>{a.text}</button>
            ))}
          </div>
        )}
      </div>
      <p role="status" aria-live="polite" className="livemsg">{message}</p>

      <div className="pwlayout">
        <div className="pwmain">
          <Tabs label="Paperwork sections" urlKey="tab" tabs={tabs} defaultValue={defaultTab} className="pw-tabs" panelClassName="pwpanel">
            {(tab) => (
              <>
                {tab === "documents" && (
                  // Upload and open documents here (0043); a placement the caller cannot read files them on the candidate.
                  <DocumentsSection owner={d.placement ? { kind: "placement", id: placementId } : { kind: "candidate", id: d.candidate.id }}
                    title={d.placement ? "Placement documents" : "Candidate documents"} />
                )}
                {tab === "checklist" && <ChecklistPanel d={d} me={me} placementId={placementId} onDone={done} />}
                {tab === "bgc" && (
                  <>
                    <BgcStatusCard placementId={placementId} bgc={d.bgc} actualStart={d.placement?.actualStart ?? null} onDone={done} />
                    <BgcDetailsCard key={`d${d.bgc.version ?? 0}`} placementId={placementId} bgc={d.bgc} actualStart={d.placement?.actualStart ?? null} onDone={done} />
                    <EntriesCard kind="employment" placementId={placementId} bgc={d.bgc} onDone={done} />
                    <EntriesCard kind="address" placementId={placementId} bgc={d.bgc} onDone={done} />
                    <BgcNotes key={`n${d.bgc.version ?? 0}`} placementId={placementId} bgc={d.bgc} onDone={done} />
                  </>
                )}
                {tab === "activity" && (
                  <section className="card pad" aria-labelledby={`${hid}-act`}>
                    <h2 id={`${hid}-act`}>Background check activity</h2>
                    <p className="hint">Who changed what. Values of personal fields are not shown. Checklist history is on each checklist item.</p>
                    <HistoryList entries={d.bgc.history} label="Background check history" />
                  </section>
                )}
              </>
            )}
          </Tabs>
        </div>

        <aside className="pwrail" aria-label="Placement summary">
          <section className="card pad">
            <h2>Placement</h2>
            <dl className="facts">
              <dt>Candidate</dt><dd>{d.candidate.name ?? "—"}</dd>
              <dt>Recruiter</dt><dd>{d.recruiter.name ?? "—"}</dd>
              {d.placement && <>
                <dt>Status</dt><dd><PipelineStatus status={d.placement.status} /></dd>
                <dt>Type</dt><dd>{PLACEMENT_TYPE_LABELS[d.placement.placementType as PlacementType] ?? d.placement.placementType}</dd>
                <dt>Client</dt><dd>{d.placement.client?.name ?? "—"}</dd>
                <dt>Tentative start</dt><dd>{fmtDate(d.placement.tentativeStart)}</dd>
                {d.placement.actualStart && <><dt>Actual start</dt><dd>{fmtDate(d.placement.actualStart)}</dd></>}
              </>}
            </dl>
          </section>
          <section className="card pad pw-attn">
            <h2>Needs attention</h2>
            {attention.length === 0 ? <p className="muted">Nothing needs attention.</p> : (
              <ul className="pwattn">
                {attention.map((a, k) => (
                  <li key={k}><button type="button" className="linkbtn" onClick={() => setTabParam(a.tab === defaultTab ? "" : a.tab)}>{a.text}</button></li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function needsAttention(d: PaperworkDetail): { text: string; tab: Tab }[] {
  const out: { text: string; tab: Tab }[] = [];
  if (d.checklist.overdue > 0) out.push({ text: `${d.checklist.overdue} checklist ${d.checklist.overdue === 1 ? "item" : "items"} overdue`, tab: "checklist" });
  if (d.checklist.requiredOpen > 0) out.push({ text: `${d.checklist.requiredOpen} required ${d.checklist.requiredOpen === 1 ? "item" : "items"} open`, tab: "checklist" });
  if (d.bgc.status === "failed") out.push({ text: "Background check failed", tab: "bgc" });
  for (const [kind, rows] of [["employment", d.bgc.employment], ["address", d.bgc.addresses]] as const) {
    const gaps = coverage(rows)?.gaps.length ?? 0;
    if (gaps > 0) out.push({ text: `${gaps} ${kind} ${gaps === 1 ? "gap" : "gaps"}`, tab: "bgc" });
    const bad = rows.filter((r) => r.verification === "unverified").length;
    if (bad > 0) out.push({ text: `${bad} ${kind} ${bad === 1 ? "row" : "rows"} could not be verified`, tab: "bgc" });
  }
  return out;
}

// ---------- history ----------

const CHANGED_LABELS: Record<string, string> = {
  status: "status", owner_role: "owner role", assignee: "assignee", due_on: "due date", notes: "notes", document: "document link",
  bgc_company: "BGC company", initiated_on: "initiated date", completed_on: "completed date", helped_by: "helped by",
  education_level: "education level", employment_years: "employment years", address_years: "address years",
  employment_history: "employment history", address_history: "address history",
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

// ---------- checklist ----------

function ChecklistPanel({ d, me, placementId, onDone }: { d: PaperworkDetail; me: Pick<Me, "id" | "roles">; placementId: string; onDone: (m: string) => void }) {
  const hid = useId();
  const [editItem, setEditItem] = useState<PaperworkItem | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ id: string; error?: string } | null>(null);
  /** One-click "Mark received": the most common change, sent with the version the row was read at. */
  const markReceived = async (i: PaperworkItem) => {
    setQuick({ id: i.id });
    try {
      await paperworkApi.updateItem(i.id, { expectedVersion: i.version, status: "received" });
      setQuick(null);
      onDone(`${docTypeLabel(i.docType)} marked Received.`);
    } catch (e) {
      setQuick({ id: i.id, error: paperworkError(e) });
    }
  };
  return (
    <section className="card pad" aria-labelledby={`${hid}-k`}>
      <h2 id={`${hid}-k`}>Paperwork checklist</h2>
      {d.items.length === 0 ? <p className="muted">No paperwork checklist for this placement.</p> : (
        <>
          <p className="muted">{d.checklist.total - d.checklist.open} of {d.checklist.total} done
            {d.checklist.overdue > 0 && `, ${d.checklist.overdue} overdue`}.</p>
          {quick?.error && <p className="error" role="alert">{quick.error}</p>}
          <div className="tablewrap"><table className="mini dtable bo-dtable pw-checklist" aria-labelledby={`${hid}-k`}>
            <thead><tr><th>Document</th><th>Status</th><th>Due</th><th>Owner</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {d.items.map((i) => {
                const label = docTypeLabel(i.docType);
                const canEdit = i.actions.transition.length > 0 || i.actions.editNotes || i.actions.assign;
                return (
                  <Fragment key={i.id}>
                    <tr>
                      <td className="c-primary"><b>{label}</b><span className="block">{i.required ? "Required" : "Optional"}
                        {i.assignee && ` · ${i.assignee.name ?? "assigned"}`}{i.documentId && " · document linked"}</span>
                        {i.notes && <span className="block note">{i.notes}</span>}</td>
                      <td className="c-badge" data-label="Status"><span className={`badge cl-${i.status}`}>{paperworkLabel(i.status)}</span>
                        {i.statusReason && <span className="block muted">{i.statusReason}</span>}</td>
                      <td data-label="Due"><DueDate on={i.dueOn} done />
                        {i.overdue && <> <span className="badge overdue">{i.status === "received" ? "Verification overdue" : "Overdue"}</span></>}</td>
                      <td data-label="Owner"><RoleName k={i.ownerRole} /></td>
                      <td className="c-act">
                        {i.status === "pending" && i.actions.transition.includes("received") && (
                          <button type="button" className="btn sm primary" disabled={quick?.id === i.id && !quick.error} onClick={() => void markReceived(i)}
                            aria-label={`Mark ${label} received`}>Mark received</button>
                        )}
                        {canEdit && (
                          <button type="button" className="btn sm" onClick={() => setEditItem(i)} aria-label={`Update ${label}`}>Update</button>
                        )}
                        <button type="button" className="btn sm" aria-expanded={historyOf === i.id}
                          onClick={() => setHistoryOf(historyOf === i.id ? null : i.id)} aria-label={`History of ${label}`}>History</button>
                      </td>
                    </tr>
                    {historyOf === i.id && (
                      <tr className="pw-histrow"><td colSpan={5}><ItemHistory itemId={i.id} label={label} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table></div>
        </>
      )}
      {editItem && (
        <ItemDialog item={editItem} me={me} candidateId={d.candidate.id} placementId={placementId} onClose={() => setEditItem(null)}
          onDone={(m) => { setEditItem(null); onDone(m); }} />
      )}
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
    <Field label="Linked document" hint={q.isError ? "Documents could not be loaded." : "Upload new files on the Documents tab."}>
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
                  <RoleOptions />
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

// ---------- background check: status ----------

const STEPS = ["not_started", "initiated", "in_progress", "outcome"] as const;

function BgcStatusCard({ placementId, bgc, actualStart: currentStart, onDone }: {
  placementId: string; bgc: Bgc; actualStart: string | null; onDone: (m: string) => void;
}) {
  const hid = useId();
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [actualStart, setActualStart] = useState(currentStart ?? "");
  const [failPlacement, setFailPlacement] = useState(false);
  const [err, setErr] = useState<{ status?: string; reason?: string; actualStart?: string }>({});
  // A cleared check rarely moves again (re-initiate): its move form waits behind "Change status".
  const [changing, setChanging] = useState(bgc.status !== "cleared");
  // Failing is final: the change waits here until the user confirms it in a dialog.
  const [confirming, setConfirming] = useState<BgcChange | null>(null);
  // Clearing the check records the placement's actual start date (PW-7); required.
  const clearing = status === "cleared";
  const submit = useSubmit(paperworkError);
  const transitions = bgc.actions.transition;
  const needsReason = status !== "" && bgcReasonRequired(bgc.status, status);
  const willFail = status === "failed";
  const at = bgc.status === "cleared" || bgc.status === "failed" ? 3 : STEPS.indexOf(bgc.status as (typeof STEPS)[number]);
  const reset = (b: BgcChange) => {
    setStatus(""); setReason(""); setFailPlacement(false); setActualStart(b.status === "cleared" ? actualStart : currentStart ?? "");
    if (bgc.status === "cleared") setChanging(false);
  };
  const message = (b: BgcChange, r: Bgc) =>
    b.failPlacement ? "Background check failed; placement marked BGC failed." : `Background check marked ${paperworkLabel(r.status)}.`;

  return (
    <section className="card pad" aria-labelledby={`${hid}-s`}>
      <div className="pwcardhead">
        <h2 id={`${hid}-s`}>Status</h2>
        <BgcBadge status={bgc.status} />
        {transitions.length > 0 && !changing && (
          <button type="button" className="btn sm pushright" onClick={() => setChanging(true)}>Change status</button>
        )}
      </div>
      {bgc.statusChangedAt && <p className="hint">Last changed {fmtDateTime(bgc.statusChangedAt)}{bgc.statusReason && <> · Reason: {bgc.statusReason}</>}</p>}
      <ol className="stepper" aria-label="Background check progress">
        {STEPS.map((s, i) => (
          <li key={s} className={i < at ? "done" : i === at ? `current${bgc.status === "failed" ? " bad" : ""}` : undefined}
            aria-current={i === at ? "step" : undefined}>
            {s === "outcome" ? (bgc.status === "failed" ? "Failed" : bgc.status === "cleared" ? "Cleared" : "Cleared / Failed") : paperworkLabel(s)}
          </li>
        ))}
      </ol>
      {transitions.length === 0 ? (
        <p className="muted">{bgc.status === "failed" ? "A failed check is final." : "You can't change this check's status."}</p>
      ) : !changing ? null : (
        <form noValidate className="pw-statusform" onSubmit={(e) => {
          e.preventDefault();
          if (!status) { setErr({ status: "Pick a status." }); e.currentTarget.querySelector<HTMLElement>("select")?.focus(); return; }
          if (needsReason && !reason.trim()) { setErr({ reason: "Give a reason." }); e.currentTarget.querySelector<HTMLElement>("textarea")?.focus(); return; }
          if (clearing && !actualStart) { setErr({ actualStart: "Enter the actual start date." }); e.currentTarget.querySelector<HTMLElement>("input[type=date]")?.focus(); return; }
          setErr({});
          const b: BgcChange = { status, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(bgc.version === null ? {} : { expectedVersion: bgc.version }) };
          if (clearing && actualStart !== (currentStart ?? "")) b.actualStart = actualStart;
          if (failPlacement && willFail && bgc.actions.failPlacement) b.failPlacement = true;
          if (willFail) { setConfirming(b); return; }
          void submit.run(async () => {
            const r = await paperworkApi.updateBgc(placementId, b);
            reset(b);
            onDone(message(b, r));
          });
        }}>
          <div className="pwgrid">
            <Field label="Move to" error={err.status}>
              {(p) => (
                <select {...p} value={status} onChange={(e) => { setStatus(e.target.value); setErr({}); }}>
                  <option value="">Choose…</option>
                  {transitions.map((t) => <option key={t} value={t}>{bgc.status === "cleared" && t === "initiated" ? "Re-initiate (more documents needed)" : paperworkLabel(t)}</option>)}
                </select>
              )}
            </Field>
            <div className="pwspan2">
              <Field label={needsReason ? "Reason" : "Reason (optional)"} hint="Up to 500 characters; never in the audit log."
                error={err.reason}>
                {(p) => <textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
            </div>
            {clearing && (
              <Field label="Actual start date" hint="Required to clear the check. Replaces the tentative start." error={err.actualStart}>
                {(p) => <input {...p} type="date" min="2000-01-01" max="2100-12-31" value={actualStart} onChange={(e) => setActualStart(e.target.value)} />}
              </Field>
            )}
          </div>
          {willFail && bgc.actions.failPlacement && (
            <label className="check"><input type="checkbox" checked={failPlacement} onChange={(e) => setFailPlacement(e.target.checked)} />
              {" "}Also mark the placement BGC failed (same rules as on Placements)</label>
          )}
          {submit.error && <p className="error" role="alert">{submit.error}</p>}
          <div className="pwactions">
            {bgc.status === "cleared" && <button type="button" className="btn" onClick={() => { setChanging(false); setStatus(""); setErr({}); }}>Cancel</button>}
            <button type="submit" className={`btn ${willFail ? "danger" : "primary"}`} disabled={submit.busy}>Update status</button>
          </div>
        </form>
      )}
      {confirming && (
        <ConfirmDialog title="Fail this background check?" confirmLabel="Fail check" danger formatError={paperworkError}
          onClose={() => setConfirming(null)}
          action={async () => {
            const r = await paperworkApi.updateBgc(placementId, confirming);
            reset(confirming);
            return r;
          }}
          onDone={() => {
            const b = confirming;
            setConfirming(null);
            onDone(message(b, { ...bgc, status: "failed" }));
          }}>
          <p>A failed check is final: it can't be moved again.</p>
          <p>{confirming.failPlacement
            ? "The placement is also marked BGC failed."
            : bgc.actions.failPlacement ? "The placement keeps its status (you didn't choose to mark it BGC failed)." : "The placement's status doesn't change here."}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

// ---------- background check: details ----------

function BgcDetailsCard({ placementId, bgc, actualStart: currentStart, onDone }: {
  placementId: string; bgc: Bgc; actualStart: string | null; onDone: (m: string) => void;
}) {
  const hid = useId();
  const [editing, setEditing] = useState(false);
  // The actual start date stays editable while the check is cleared (PW-7); it can't be emptied.
  const startEditable = bgc.status === "cleared";
  const [actualStart, setActualStart] = useState(currentStart ?? "");
  const [company, setCompany] = useState(bgc.bgcCompany ?? "");
  const [initiatedOn, setInitiated] = useState(bgc.initiatedOn ?? "");
  const [education, setEducation] = useState(bgc.educationLevel ?? "");
  const [err, setErr] = useState("");
  const submit = useSubmit(paperworkError);
  return (
    <section className="card pad" aria-labelledby={`${hid}-d`}>
      <div className="pwcardhead">
        <h2 id={`${hid}-d`}>Check details</h2>
        {bgc.actions.update && !editing && <button type="button" className="btn sm" onClick={() => setEditing(true)}>Edit<span className="sr-only"> check details</span></button>}
      </div>
      {!editing ? (
        <dl className="pwdetails">
          <div><dt>BGC company</dt><dd>{bgc.bgcCompany ?? "—"}</dd></div>
          <div><dt>Initiated on</dt><dd>{fmtDate(bgc.initiatedOn)}</dd></div>
          <div><dt>Education level</dt><dd>{bgc.educationLevel ?? "—"}</dd></div>
          {currentStart && <div><dt>Actual start</dt><dd>{fmtDate(currentStart)}</dd></div>}
        </dl>
      ) : (
        <form noValidate onSubmit={(e) => {
          e.preventDefault();
          const b: BgcChange = bgc.version === null ? {} : { expectedVersion: bgc.version };
          if (company.trim() !== (bgc.bgcCompany ?? "")) b.bgcCompany = company.trim() || null;
          if (initiatedOn !== (bgc.initiatedOn ?? "")) b.initiatedOn = initiatedOn || null;
          if (education.trim() !== (bgc.educationLevel ?? "")) b.educationLevel = education.trim() || null;
          if (startEditable && actualStart && actualStart !== (currentStart ?? "")) b.actualStart = actualStart;
          if (Object.keys(b).filter((k) => k !== "expectedVersion").length === 0) { setErr("Change at least one field."); return; }
          setErr("");
          void submit.run(async () => {
            await paperworkApi.updateBgc(placementId, b);
            setEditing(false);
            onDone("Check details saved.");
          });
        }}>
          <div className="pwgrid">
            <Field label="BGC company">{(p) => <input {...p} maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />}</Field>
            <Field label="Initiated on">{(p) => <input {...p} type="date" value={initiatedOn} onChange={(e) => setInitiated(e.target.value)} />}</Field>
            <Field label="Education level">{(p) => <input {...p} maxLength={60} placeholder="e.g. Master's" value={education} onChange={(e) => setEducation(e.target.value)} />}</Field>
            {startEditable && (
              <Field label="Actual start date">
                {(p) => <input {...p} type="date" min="2000-01-01" max="2100-12-31" required value={actualStart} onChange={(e) => setActualStart(e.target.value)} />}
              </Field>
            )}
          </div>
          {(err || submit.error) && <p className="error" role="alert">{err || submit.error}</p>}
          <div className="pwactions">
            <button type="button" className="btn" onClick={() => { setEditing(false); setErr(""); }}>Cancel</button>
            <button type="submit" className="btn primary" disabled={submit.busy}>Save</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------- background check: employment and address rows ----------

const monthIdx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const idxMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const thisMonth = () => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); };
export const fmtMonth = (m: string | null) =>
  m ? new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "Present";
const span = (months: number) => {
  const y = Math.floor(months / 12), mo = months % 12;
  return [y > 0 && `${y} ${y === 1 ? "yr" : "yrs"}`, mo > 0 && `${mo} mo`].filter(Boolean).join(" ") || "0 mo";
};

type Seg = "verified" | "pending" | "unverified" | "gap";
/** Months from the earliest row to this month: which are covered (and how well), plus the uncovered runs. */
export function coverage(rows: BgcEntry[], now = thisMonth()) {
  if (rows.length === 0) return null;
  const ranges = rows.map((r) => ({ s: monthIdx(r.startMonth), e: r.endMonth ? monthIdx(r.endMonth) : now, v: r.verification }));
  const from = Math.min(...ranges.map((r) => r.s));
  const runs: { seg: Seg; from: number; to: number }[] = [];
  let covered = 0;
  for (let m = from; m <= now; m++) {
    const on = ranges.filter((r) => r.s <= m && m <= r.e);
    const seg: Seg = on.some((r) => r.v === "verified") ? "verified" : on.some((r) => r.v === "unverified") ? "unverified" : on.length ? "pending" : "gap";
    if (seg !== "gap") covered++;
    const last = runs[runs.length - 1];
    if (last && last.seg === seg) last.to = m; else runs.push({ seg, from: m, to: m });
  }
  const total = Math.max(now - from + 1, 1);
  return { from, total, covered, runs, gaps: runs.filter((r) => r.seg === "gap").map((r) => ({ from: idxMonth(r.from), to: idxMonth(r.to), months: r.to - r.from + 1 })) };
}

const VERIFICATION_LABELS: Record<EntryVerification, string> = { pending: "Pending", verified: "Verified", unverified: "Could not verify" };
const VerificationBadge = ({ v }: { v: EntryVerification }) => <span className={`badge ver-${v}`}>{VERIFICATION_LABELS[v]}</span>;

const KIND_TEXT = {
  employment: { title: "Employment history", one: "employer", many: "employers", add: "Add employer", empty: "No employers recorded yet.", legacy: "employmentYears" },
  address: { title: "Address history", one: "address", many: "addresses", add: "Add address", empty: "No addresses recorded yet.", legacy: "addressYears" },
} as const;

const entryLabel = (e: BgcEntry) => e.kind === "employment" ? e.employer ?? "Employer" : [e.city, e.region, e.country].filter(Boolean).join(", ");

function EntriesCard({ kind, placementId, bgc, onDone }: { kind: EntryKind; placementId: string; bgc: Bgc; onDone: (m: string) => void }) {
  const hid = useId();
  const t = KIND_TEXT[kind];
  const rows = kind === "employment" ? bgc.employment : bgc.addresses;
  const canEdit = bgc.actions.update;
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BgcEntry | null>(null);
  const quick = useSubmit(paperworkError);
  const cov = coverage(rows);
  const legacy = bgc[t.legacy];

  return (
    <section className="card pad" aria-labelledby={`${hid}-h`}>
      <div className="pwcardhead">
        <div>
          <h2 id={`${hid}-h`}>{t.title}</h2>
          {cov && <p className="hint">{rows.length} {rows.length === 1 ? t.one : t.many} · {span(cov.covered)} covered since {fmtMonth(idxMonth(cov.from))}</p>}
        </div>
        {canEdit && !adding && <button type="button" className="btn sm primary" onClick={() => { setAdding(true); setEditId(null); }}>+ {t.add}</button>}
      </div>
      {cov && (
        <>
          <div className="coverage" aria-hidden="true">
            {cov.runs.map((r, k) => <span key={k} className={`cov-${r.seg}`} style={{ width: `${((r.to - r.from + 1) / cov.total) * 100}%` }} />)}
          </div>
          <p className="covlegend" aria-hidden="true">
            <span><i className="cov-verified" />Verified</span><span><i className="cov-pending" />Pending</span>
            <span><i className="cov-unverified" />Could not verify</span><span><i className="cov-gap" />Gap</span>
          </p>
          {cov.gaps.length > 0 && (
            <p className="note warn" role="note">
              {cov.gaps.length === 1 ? "Gap" : "Gaps"}:{" "}
              {cov.gaps.slice(0, 3).map((g) => `${fmtMonth(g.from)}${g.months > 1 ? ` – ${fmtMonth(g.to)}` : ""} (${span(g.months)})`).join("; ")}
              {cov.gaps.length > 3 && `; ${cov.gaps.length - 3} more`}. Add a row or explain the gap in its notes.
            </p>
          )}
        </>
      )}
      {quick.error && <p className="error" role="alert">{quick.error}</p>}
      {rows.length === 0 && !adding ? (
        <p className="muted">{t.empty}{legacy !== null && ` Recorded before history rows: ${legacy} ${legacy === 1 ? "year" : "years"} checked back.`}</p>
      ) : rows.length > 0 && (
        <div className="tablewrap"><table className="mini" aria-label={`${t.title}, newest first`}>
          <thead><tr>
            {kind === "employment" ? <><th>Employer</th><th>Title</th></> : <><th>Address</th><th>Country</th></>}
            <th>From</th><th>To</th><th>Verification</th><th><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>
            {rows.map((e) => editId === e.id ? (
              <tr key={e.id} className="editing"><td colSpan={6}>
                <EntryForm kind={kind} entry={e} placementId={placementId} onCancel={() => setEditId(null)}
                  onRemove={() => setRemoving(e)} onDone={(m) => { setEditId(null); onDone(m); }} />
              </td></tr>
            ) : (
              <tr key={e.id}>
                {kind === "employment" ? (
                  <><td className="wrap">{e.employer}{e.notes && <span className="block note">{e.notes}</span>}</td><td>{e.title ?? <span className="muted">—</span>}</td></>
                ) : (
                  <><td className="wrap">{e.street && <span className="block pwstreet">{e.street}</span>}
                    {[e.city, e.region, e.postalCode].filter(Boolean).join(", ")}
                    {e.notes && <span className="block note">{e.notes}</span>}</td><td>{e.country}</td></>
                )}
                <td>{fmtMonth(e.startMonth)}</td>
                <td>{fmtMonth(e.endMonth)}</td>
                <td><VerificationBadge v={e.verification} /></td>
                <td className="rowactions">
                  {canEdit && e.verification === "pending" && (
                    <button type="button" className="btn sm" disabled={quick.busy} onClick={() => void quick.run(async () => {
                      await paperworkApi.updateEntry(placementId, e.id, { verification: "verified", expectedVersion: e.version });
                      onDone(`${entryLabel(e)} marked verified.`);
                    })}>Mark verified<span className="sr-only"> {entryLabel(e)}</span></button>
                  )}
                  {canEdit && <button type="button" className="btn sm" onClick={() => { setEditId(e.id); setAdding(false); }}>Edit<span className="sr-only"> {entryLabel(e)}</span></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {adding && (
        <div className="pwnewrow">
          <EntryForm kind={kind} placementId={placementId} onCancel={() => setAdding(false)} onDone={(m) => { setAdding(false); onDone(m); }} />
        </div>
      )}
      {removing && (
        <ConfirmDialog title={`Remove ${kind === "employment" ? "employer" : "address"}?`} confirmLabel="Remove" danger
          formatError={paperworkError} onClose={() => setRemoving(null)}
          action={() => paperworkApi.deleteEntry(placementId, removing.id, removing.version)}
          onDone={() => { const l = entryLabel(removing); setRemoving(null); setEditId(null); onDone(`${l} removed.`); }}>
          <p>{entryLabel(removing)} ({fmtMonth(removing.startMonth)} – {fmtMonth(removing.endMonth)}) will be removed from this check. The history keeps that a row was removed, not its contents.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

type FormState = Record<"employer" | "title" | "street" | "city" | "region" | "postalCode" | "country" | "startMonth" | "endMonth" | "notes", string>
  & { current: boolean; verification: EntryVerification };

function EntryForm({ kind, entry, placementId, onCancel, onDone, onRemove }: {
  kind: EntryKind; entry?: BgcEntry; placementId: string; onCancel: () => void; onDone: (m: string) => void; onRemove?: () => void;
}) {
  const [f, setF] = useState<FormState>(() => ({
    employer: entry?.employer ?? "", title: entry?.title ?? "", street: entry?.street ?? "", city: entry?.city ?? "",
    region: entry?.region ?? "", postalCode: entry?.postalCode ?? "", country: entry?.country ?? "",
    startMonth: entry?.startMonth ?? "", endMonth: entry?.endMonth ?? "", notes: entry?.notes ?? "",
    current: entry ? entry.endMonth === null : false, verification: entry?.verification ?? "pending",
  }));
  const [err, setErr] = useState<Partial<Record<keyof FormState | "form", string>>>({});
  const submit = useSubmit(paperworkError);
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const text = (k: keyof FormState, label: string, max: number, extra?: { hint?: string; placeholder?: string }) => (
    <Field label={label} error={err[k]} hint={extra?.hint}>
      {(p) => <input {...p} maxLength={max} placeholder={extra?.placeholder} value={f[k] as string} onChange={(e) => set(k)(e.target.value as never)} />}
    </Field>
  );
  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

  const validate = () => {
    const e: typeof err = {};
    if (kind === "employment" && !f.employer.trim()) e.employer = "Enter the employer.";
    if (kind === "address" && !f.city.trim()) e.city = "Enter the city.";
    if (kind === "address" && !f.country.trim()) e.country = "Enter the country.";
    if (!MONTH.test(f.startMonth)) e.startMonth = "Pick the first month.";
    if (!f.current && f.endMonth && !MONTH.test(f.endMonth)) e.endMonth = "Pick a month.";
    else if (!f.current && !f.endMonth) e.endMonth = "Pick the last month, or tick the current box.";
    else if (!f.current && f.endMonth < f.startMonth) e.endMonth = "“To” must be on or after “From”.";
    return e;
  };

  const fields = (): EntryFields => {
    const keys = kind === "employment" ? (["employer", "title", "notes"] as const) : (["street", "city", "region", "postalCode", "country", "notes"] as const);
    const out: EntryFields = {};
    for (const k of keys) {
      const v = f[k].trim();
      const old = entry ? entry[k] ?? "" : "";
      if (!entry ? v !== "" : v !== old) out[k] = v || null;
    }
    const end = f.current ? null : f.endMonth;
    if (!entry || f.startMonth !== entry.startMonth) out.startMonth = f.startMonth;
    if (!entry ? end !== null : end !== entry.endMonth) out.endMonth = end;
    if (!entry || f.verification !== entry.verification) out.verification = f.verification;
    return out;
  };

  return (
    <form ref={formRef} className="entryform" noValidate aria-label={entry ? `Edit ${entryLabel(entry)}` : KIND_TEXT[kind].add} onSubmit={(e) => {
      e.preventDefault();
      const v = validate();
      setErr(v);
      if (Object.keys(v).length) { setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid]")?.focus()); return; }
      const b = fields();
      if (entry && Object.keys(b).length === 0) { setErr({ form: "Change at least one field." }); return; }
      void submit.run(async () => {
        if (entry) await paperworkApi.updateEntry(placementId, entry.id, { ...b, expectedVersion: entry.version });
        else await paperworkApi.addEntry(placementId, { kind, ...b });
        const label = kind === "employment" ? f.employer.trim() : f.city.trim();
        onDone(entry ? `${label} saved.` : `${label} added.`);
      });
    }}>
      <div className="pwgrid">
        {kind === "employment" ? (<>
          {text("employer", "Employer", 120)}
          {text("title", "Title (optional)", 120)}
        </>) : (<>
          <div className="pwspan2">{text("street", "Street address (optional)", 200)}</div>
          {text("city", "City", 120)}
          {text("region", "State / region (optional)", 120)}
          {text("postalCode", "Postal code (optional)", 20)}
          {text("country", "Country", 60)}
        </>)}
        <Field label="From" error={err.startMonth}>
          {(p) => <input {...p} type="month" min="1950-01" max="2100-12" placeholder="YYYY-MM" value={f.startMonth} onChange={(e) => set("startMonth")(e.target.value)} />}
        </Field>
        {!f.current && (
          <Field label="To" error={err.endMonth}>
            {(p) => <input {...p} type="month" min="1950-01" max="2100-12" placeholder="YYYY-MM" value={f.endMonth} onChange={(e) => set("endMonth")(e.target.value)} />}
          </Field>
        )}
        <Field label="Verification">
          {(p) => (
            <select {...p} value={f.verification} onChange={(e) => set("verification")(e.target.value as EntryVerification)}>
              {ENTRY_VERIFICATIONS.map((v) => <option key={v} value={v}>{VERIFICATION_LABELS[v]}</option>)}
            </select>
          )}
        </Field>
        <div className="pwspan3">
          <Field label="Notes (optional)" hint="Up to 1000 characters, e.g. what the vendor confirmed or why a gap exists.">
            {(p) => <textarea {...p} rows={2} maxLength={1000} value={f.notes} onChange={(e) => set("notes")(e.target.value)} />}
          </Field>
        </div>
      </div>
      {(err.form || submit.error) && <p className="error" role="alert">{err.form || submit.error}</p>}
      <div className="pwactions">
        <label className="check pwcurrent"><input type="checkbox" checked={f.current} onChange={(e) => set("current")(e.target.checked)} />
          {kind === "employment" ? " Currently works here" : " Current address"}</label>
        {onRemove && <button type="button" className="btn danger" onClick={onRemove}>Remove</button>}
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={submit.busy}>{entry ? "Save" : KIND_TEXT[kind].add}</button>
      </div>
    </form>
  );
}

// ---------- background check: notes ----------

/** The BGC record's notes, saved in place by whoever may update the check; read-only for everyone else. */
function BgcNotes({ placementId, bgc, onDone }: { placementId: string; bgc: Bgc; onDone: (m: string) => void }) {
  const hid = useId();
  const [notes, setNotes] = useState(bgc.notes ?? "");
  const submit = useSubmit(paperworkError);
  const changed = notes.trim() !== (bgc.notes ?? "");
  return (
    <section className="card pad" aria-labelledby={`${hid}-n`}>
      <h2 id={`${hid}-n`}>Notes</h2>
      {!bgc.actions.update ? <p className={bgc.notes ? undefined : "muted"}>{bgc.notes ?? "No notes yet."}</p> : (
        <form noValidate onSubmit={(e) => {
          e.preventDefault();
          void submit.run(async () => {
            await paperworkApi.updateBgc(placementId, { notes: notes.trim() || null, ...(bgc.version === null ? {} : { expectedVersion: bgc.version }) });
            onDone("Notes saved.");
          });
        }}>
          <Field label="Add or edit notes" hint="Up to 1000 characters. Avoid personal data." error={submit.error || undefined}>
            {(p) => <textarea {...p} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
          <div className="pwactions"><button type="submit" className="btn sm" disabled={!changed || submit.busy}>Save notes</button></div>
        </form>
      )}
    </section>
  );
}
