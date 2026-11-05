import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Plus, Trash2 } from "lucide-react";
import type { Me } from "../api";
import { ConfirmDialog } from "../ui/Dialog";
import { fmtDate } from "../sales/ui";
import { Avatar } from "../shell/ui";
import { BatchDetailView } from "./BatchDetail";
import { NewBatchDialog } from "./NewBatchDialog";
import { BATCH_STATUSES, BATCH_STATUS_LABELS, trainingApi, trainingError, trainingKeys, type BatchCard } from "./trainingApi";
import { BatchStatusPill, CoverArt, schedule } from "./ui";
import "./training.css";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";

/** Training Batches (docs/training-api.md): cards with status filter; a card opens the batch. */
export function TrainingPage({ me, initialOpenId = null, onOpenChange }: {
  me: Me; initialOpenId?: string | null;
  /** Keeps the open batch in the address bar (/training/<id>). */
  onOpenChange?: (id: string | null) => void;
}) {
  const [openId, setOpen] = useState<string | null>(initialOpenId);
  useEffect(() => { setOpen(initialOpenId); }, [initialOpenId]);
  const setOpenId = (next: string | null) => { setOpen(next); onOpenChange?.(next); };
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
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const shown = needle ? items.filter((b) => [b.name, b.technology.name, b.location.name, b.trainer?.name ?? ""].some((v) => (v ?? "").toLowerCase().includes(needle))) : items;
  return (
    <>
      <div className="pagehead">
        <div>
          <h1 ref={heading} tabIndex={-1}>Training Batches{q.data && <span className="h1count">{items.length}</span>}</h1>
          <p className="sub">Manage student batches and track their progress.</p>
        </div>
        <div className="toolbar push tb-tools">
          <div className="field inline tb-search"><label htmlFor={`${id}-q`}>Search</label>
            <input id={`${id}-q`} type="search" placeholder="Batch, technology, location, trainer" value={text} onChange={(e) => setText(e.target.value)} /></div>
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
      {q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={trainingError(q.error)} />
      ) : items.length === 0 ? (
        <div className="card"><p className="empty">{status ? "No batches with this status." : "No training batches to show yet."}</p></div>
      ) : (
        <>
          <div className="tb-summary">
            <span className="muted">{shown.length === items.length ? `${items.length} ${items.length === 1 ? "batch" : "batches"}` : `${shown.length} of ${items.length} batches`}</span>
          </div>
          {shown.length === 0 ? <div className="card"><p className="empty">No batches match this search. <button type="button" className="linkbtn" onClick={() => setText("")}>Clear search</button></p></div> : (
            <ul className="tb-grid" aria-label="Training batches">
              {shown.map((b) => {
                const sched = schedule(b);
                return (
                  <li key={b.id} className="card tb-card">
                    <div className="tb-top">
                      <CoverArt cover={b.cover} size="sm" />
                      <div className="tb-titles">
                        <h2 className="tb-title">{b.name}</h2>
                        <p className="tb-sub">{b.technology.name} · {b.location.name}</p>
                      </div>
                      <BatchStatusPill status={b.status} />
                    </div>
                    {/* The whole card opens the batch: one affordance, stretched over the card. */}
                    <button type="button" className="cardopen tb-open" aria-label={`Open ${b.name}`} onClick={() => onOpen(b.id)} />
                    <div className="tb-facts">
                      <span className="tb-trainer"><Avatar name={b.trainer?.name ?? "?"} size="sm" /><small>{b.trainer ? `by ${b.trainer.name}` : "No trainer yet"}</small></span>
                      <span className="tb-stat"><b>{b.students}</b><small>Students</small></span>
                      <span className="tb-stat"><b>{b.courses}</b><small>Courses</small></span>
                    </div>
                    <div className="tb-sched">
                      <span className="tb-dates"><CalendarDays size={14} aria-hidden="true" />{fmtDate(b.startDate)}{b.endDate ? ` – ${fmtDate(b.endDate)}` : ""}</span>
                      {sched && <span className="tb-schedlabel">{sched.label}</span>}
                      {sched && sched.pct !== null && (
                        <span className="tb-bar" role="progressbar" aria-label={`Schedule of ${b.name}: ${sched.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={sched.pct}>
                          <span className={sched.pct >= 100 ? "done" : undefined} style={{ width: `${sched.pct}%` }} />
                        </span>
                      )}
                    </div>
                    {b.actions.delete && (
                      <button type="button" className="iconbtn sm tb-del" aria-label={`Delete ${b.name}`} title="Delete batch" onClick={() => setDeleting(b)}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {creating && (
        <NewBatchDialog me={me} onClose={() => setCreating(false)} onDone={(bid, _name, added) => {
          setCreating(false);
          setNotice(added > 0 ? `Training batch created with ${added} candidate${added === 1 ? "" : "s"}.` : "Training batch created.");
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

