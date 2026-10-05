import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarDays, Plus, Trash2 } from "lucide-react";
import type { Me } from "../api";
import { ConfirmDialog } from "../admin/Dialog";
import { fmtDate } from "../sales/ui";
import { Avatar } from "../shell/ui";
import { BatchDetailView } from "./BatchDetail";
import { BatchDialog } from "./BatchDialog";
import { BATCH_STATUSES, BATCH_STATUS_LABELS, trainingApi, trainingError, trainingKeys, type BatchCard } from "./trainingApi";
import { BatchStatusPill, CoverArt } from "./ui";

/** Training Batches (docs/training-api.md): cards with status filter; a card opens the batch. */
export function TrainingPage({ me }: { me: Me }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const [returned, setReturned] = useState(false);
  useEffect(() => { if (returned) { heading.current?.focus(); setReturned(false); } }, [returned]);
  if (openId) {
    return <BatchDetailView id={openId} me={me} onBack={() => { setOpenId(null); setReturned(true); }}
      onDeleted={(name) => { setOpenId(null); setNotice(`${name} deleted.`); setReturned(true); }} />;
  }
  return <BatchList me={me} onOpen={setOpenId} heading={heading} notice={notice} setNotice={setNotice} />;
}

function BatchList({ me, onOpen, heading, notice, setNotice }: {
  me: Me; onOpen: (id: string) => void; heading: React.RefObject<HTMLHeadingElement>; notice: string; setNotice: (s: string) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BatchCard | null>(null);
  const q = useQuery({ queryKey: trainingKeys.batches(status), queryFn: () => trainingApi.batches(status) });
  const items = q.data?.items ?? [];
  return (
    <>
      <div className="pagehead">
        <div>
          <h1 ref={heading} tabIndex={-1}>Training Batches</h1>
          <p className="sub">Manage student batches and track their progress.</p>
        </div>
        <div className="toolbar push">
          <label className="field inline" htmlFor={`${id}-st`}>Status
            <select id={`${id}-st`} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {BATCH_STATUSES.map((s) => <option key={s} value={s}>{BATCH_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          {q.data?.canCreate && (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Add training batch</button>
          )}
        </div>
      </div>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{trainingError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : items.length === 0 ? (
        <div className="card"><p className="empty">{status ? "No batches with this status." : "No training batches to show yet."}</p></div>
      ) : (
        <ul className="tr-grid" aria-label="Training batches">
          {items.map((b) => (
            <li key={b.id} className="card tr-card">
              <div className="tr-coverwrap">
                <CoverArt cover={b.cover} caption="Training batch" />
                {b.actions.delete && (
                  <button type="button" className="iconbtn tr-del" aria-label={`Delete ${b.name}`} onClick={() => setDeleting(b)}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              <h2 className="tr-title">{b.name}</h2>
              <div><BatchStatusPill status={b.status} /> <span className="muted">{b.technology.name} · {b.location.name}</span></div>
              <div className="tr-meta">
                <span className="tr-trainer">
                  <Avatar name={b.trainer?.name ?? "?"} size="sm" />
                  <small>{b.trainer ? `by ${b.trainer.name}` : "No trainer yet"}</small>
                </span>
                <span><b>{b.students}</b><small>Students</small></span>
                <span><b>{b.courses}</b><small>Courses</small></span>
              </div>
              <div className="tr-foot">
                <span className="muted"><CalendarDays size={14} aria-hidden="true" /> {fmtDate(b.startDate)}{b.endDate ? ` – ${fmtDate(b.endDate)}` : ""}</span>
                <button type="button" className="iconbtn" aria-label={`Open ${b.name}`} onClick={() => onOpen(b.id)}>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <BatchDialog me={me} onClose={() => setCreating(false)} onSaved={(bid) => {
          setCreating(false);
          setNotice("Training batch created.");
          void qc.invalidateQueries({ queryKey: trainingKeys.all });
          onOpen(bid);
        }} />
      )}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete batch" danger formatError={trainingError}
          action={() => trainingApi.deleteBatch(deleting.id)} onClose={() => setDeleting(null)}
          onDone={() => { setNotice(`${deleting.name} deleted.`); setDeleting(null); void qc.invalidateQueries({ queryKey: trainingKeys.all }); }}>
          <p>The batch has no students. Its course list goes with it. This can't be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

