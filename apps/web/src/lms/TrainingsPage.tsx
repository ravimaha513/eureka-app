import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen } from "lucide-react";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import { BatchDetailView } from "./BatchDetail";
import { BATCH_STATUSES, lmsApi, lmsError, lmsKeys, localYear } from "./lmsApi";
import { BatchStatusChip, StatusFilter } from "./ui";

/** Trainings: card grid of training batches with a status filter; opens the batch detail in place. */
export function TrainingsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const filters = { status };
  const q = useQuery({ queryKey: lmsKeys.batches(filters), queryFn: () => lmsApi.batches(filters) });
  const items = q.data?.items ?? [];

  if (openId) return <BatchDetailView id={openId} onBack={() => setOpenId(null)} onNotice={setNotice} />;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Trainings</h1>
          <p className="sub">Training batches: the courses assigned to each cohort and how far every student has got.</p>
        </div>
        <button type="button" className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>Add Training Batch</button>
      </div>
      <StatusFilter value={status} onChange={setStatus} statuses={BATCH_STATUSES} />
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{lmsError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : items.length === 0 ? (
        <p className="empty card">{status ? "No batches with this status." : "No training batches yet. Add one to get started."}</p>
      ) : (
        <ul className="lmsgrid" aria-label="Training batches">
          {items.map((b) => (
            <li key={b.id} className="card lmscard">
              <div className="lmscover" aria-hidden="true"><BookOpen size={26} /><span>{b.year}</span></div>
              <div className="lmscardbody">
                <div><BatchStatusChip status={b.status} /></div>
                <h2>{b.name}</h2>
                <div className="lmsmeta">
                  <span>{b.studentCount} {b.studentCount === 1 ? "student" : "students"}</span>
                  <span>{b.courseCount} {b.courseCount === 1 ? "course" : "courses"}</span>
                </div>
                <p className="muted">{fmtDate(b.startDate)} – {fmtDate(b.endDate)}</p>
                <button type="button" className="btn sm lmsopen" onClick={() => setOpenId(b.id)} aria-label={`Open batch ${b.name}`}>
                  Open <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <BatchFormDialog onClose={() => setAdding(false)} onSaved={(b) => {
          setAdding(false); setNotice(`Batch ${b.name} created.`);
          void qc.invalidateQueries({ queryKey: lmsKeys.all });
        }} />
      )}
    </>
  );
}

/** Create (no `batch`) or edit a training batch. */
export function BatchFormDialog({ batch, onClose, onSaved }: {
  batch?: { id: string; name: string; startDate: string; endDate: string; year: number };
  onClose: () => void; onSaved: (b: { name: string }) => void;
}) {
  const [name, setName] = useState(batch?.name ?? "");
  const [start, setStart] = useState(batch?.startDate.slice(0, 10) ?? "");
  const [end, setEnd] = useState(batch?.endDate.slice(0, 10) ?? "");
  const [errs, setErrs] = useState<{ name?: string; start?: string; end?: string }>({});
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const submit = useSubmit(lmsError);
  return (
    <Dialog title={batch ? "Edit training batch" : "Add Training Batch"} onClose={onClose}>
      <form ref={form} noValidate onSubmit={(ev) => {
        ev.preventDefault();
        const e: typeof errs = {};
        const n = name.trim();
        if (!n) e.name = "Enter a batch name."; else if (n.length > 120) e.name = "Use 120 characters or fewer.";
        if (!start) e.start = "Choose a start date.";
        if (!end) e.end = "Choose an end date."; else if (start && end < start) e.end = "The end date can't be before the start date.";
        setErrs(e);
        if (e.name || e.start || e.end) { failed(); return; }
        void submit.run(async () => {
          const saved = batch
            ? await lmsApi.updateBatch(batch.id, { name: n, startDate: start, endDate: end })
            : await lmsApi.createBatch({ name: n, startDate: start, endDate: end, year: Number(start.slice(0, 4)) || localYear() });
          onSaved({ name: saved?.name ?? n });
        }).then(() => failed());
      }}>
        <Field label="Batch name" error={errs.name}>
          {(p) => <input {...p} value={name} maxLength={130} onChange={(e) => setName(e.target.value)} data-autofocus />}
        </Field>
        <div className="grid2">
          <Field label="Start date" error={errs.start}>{(p) => <input {...p} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="End date" error={errs.end}>{(p) => <input {...p} type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
        <DialogActions onCancel={onClose} submitLabel={batch ? "Save changes" : "Add batch"} busy={submit.busy} error={submit.error} />
      </form>
    </Dialog>
  );
}
