import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import { navigate } from "../lib/router";
import { screenPath } from "../nav";
import { OPEN_BATCH_STATUSES, salesApi, salesKeys } from "../sales/salesApi";
import { fmtDate } from "../sales/ui";
import { ConfirmDialog, Dialog } from "../ui/Dialog";
import { trainingApi, trainingError, trainingKeys } from "./trainingApi";
import { BatchStatusPill, ProgressBar } from "./ui";

/**
 * Training progress on a candidate profile (docs/training-api.md TR-11), and
 * attaching the candidate to a batch (TR-14).
 * Shown to training:read holders whose scope covers the candidate or its batch;
 * the card stays hidden when the server refuses (403/404).
 */
export function CandidateTraining({ candidateId, onChanged }: { candidateId: string; onChanged?: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [modal, setModal] = useState<"pick" | "remove" | null>(null);
  const [notice, setNotice] = useState("");
  const q = useQuery({
    queryKey: trainingKeys.candidate(candidateId),
    queryFn: () => trainingApi.candidate(candidateId),
    retry: false,
  });
  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;
  const batch = q.data?.batch ?? null;
  const changed = (message: string) => {
    setModal(null);
    setNotice(message);
    void qc.invalidateQueries({ queryKey: trainingKeys.all });
    void qc.invalidateQueries({ queryKey: salesKeys.batches });
    onChanged?.();
  };
  return (
    <section className="card pad" aria-labelledby={`${id}-h`}>
      <div className="pagehead">
        <h2 id={`${id}-h`}>Training</h2>
        {q.data?.canChangeBatch && (
          <div className="rowactions push">
            <button type="button" className="btn sm" onClick={() => setModal("pick")}>{batch ? "Change batch" : "Add to batch"}</button>
            {batch && <button type="button" className="btn sm danger" onClick={() => setModal("remove")}>Remove from batch</button>}
          </div>
        )}
      </div>
      <p role="status" aria-live="polite" className="livemsg">{notice}</p>
      {q.isLoading ? <p className="muted">Loading…</p> : q.error ? <p className="muted">{trainingError(q.error)}</p>
        : !batch ? <p className="muted">Not in a training batch.</p> : (
          <>
            <p>
              <button type="button" className="linkbtn" onClick={() => navigate(screenPath("training", batch.id))}><b>{batch.name}</b></button>{" "}
              <BatchStatusPill status={batch.status} />
              <span className="block muted">{fmtDate(batch.startDate)}{batch.endDate ? ` – ${fmtDate(batch.endDate)}` : ""}</span>
            </p>
            {/* The bar has a flex basis meant for rows; the card is a column. */}
            <div><ProgressBar percent={q.data?.percent ?? 0} label="Overall training progress" /></div>
            {(q.data?.courses ?? []).length > 0 && (
              <ul className="tr-cardcourses" aria-label="Progress per course">
                {q.data!.courses!.map((c) => (
                  <li key={c.id}>
                    <span>{c.title} <small className="muted">{c.completedModules} of {c.totalModules} modules</small></span>
                    <ProgressBar percent={c.percent} label={`${c.title} progress`} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      {modal === "pick" && q.data && (
        <BatchPickerDialog candidateId={candidateId} locationId={q.data.locationId} currentId={batch?.id ?? null}
          onClose={() => setModal(null)} onSaved={() => changed("Batch saved.")} />
      )}
      {modal === "remove" && batch && (
        <ConfirmDialog title={`Remove from ${batch.name}?`} confirmLabel="Remove from batch" danger formatError={trainingError}
          action={() => trainingApi.setCandidateBatch(candidateId, null)} onClose={() => setModal(null)}
          onDone={() => changed("Removed from the batch.")}>
          <p>Recorded progress is kept and comes back if they rejoin this batch.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Open batches at the candidate's location; picking one moves the candidate there. */
function BatchPickerDialog({ candidateId, locationId, currentId, onClose, onSaved }: {
  candidateId: string; locationId: string; currentId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const id = useId();
  const q = useQuery({ queryKey: [...salesKeys.batches, locationId], queryFn: () => salesApi.batches(locationId) });
  const options = (q.data?.items ?? []).filter((b) => OPEN_BATCH_STATUSES.includes(b.status) && b.id !== currentId);
  const [batchId, setBatchId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={currentId ? "Change batch" : "Add to batch"} onClose={onClose}>
      <form noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!batchId) { setError("Choose a batch."); return; }
        setBusy(true); setError("");
        try { await trainingApi.setCandidateBatch(candidateId, batchId); onSaved(); }
        catch (err) { setError(trainingError(err)); } finally { setBusy(false); }
      }}>
        <div className="field">
          <label htmlFor={`${id}-b`}>Batch</label>
          <select id={`${id}-b`} data-autofocus value={batchId} onChange={(e) => setBatchId(e.target.value)} disabled={q.isLoading}>
            <option value="" disabled>{q.isLoading ? "Loading…" : options.length ? "Choose…" : "No other open batches at this location"}</option>
            {options.map((b) => <option key={b.id} value={b.id}>{b.customName ? `${b.customName} (${b.label})` : b.label}</option>)}
          </select>
          <p className="hint">Planned or in-training batches at the candidate's location.</p>
        </div>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save batch"}</button>
        </div>
      </form>
    </Dialog>
  );
}
