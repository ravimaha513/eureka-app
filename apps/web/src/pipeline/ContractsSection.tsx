import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CONTRACT_KINDS, CONTRACT_KIND_LABELS, CONTRACT_NOTES_MAX, CONTRACT_REFERENCE_MAX, CONTRACT_TITLE_MAX, type ContractKind } from "@eureka/shared";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { Field, fmtDate } from "../sales/ui";
import { contractError, contractKeys, contractsApi } from "./contractsApi";

/**
 * Contracts of a placement (docs/alerts-calendar-birthdays.md CT-1..CT-6) in
 * the placement drawer: the MSA / PO / SOW records of the closure. The files
 * themselves go to "Placement documents" with the matching document type.
 */
export function ContractsSection({ placementId }: { placementId: string }) {
  const hid = useId();
  const q = useQuery({ queryKey: contractKeys.list(placementId), queryFn: () => contractsApi.list(placementId) });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <section className="manageblock" aria-labelledby={`${hid}-k`}>
      <h3 id={`${hid}-k`}>Contracts</h3>
      {q.isLoading ? <p className="muted">Loading contracts…</p> : q.error ? <p className="error" role="alert">{contractError(q.error)}</p> : !q.data?.items.length ? (
        <p className="muted">No contract recorded yet.</p>
      ) : (
        <div className="tablewrap"><table className="mini" aria-labelledby={`${hid}-k`}>
          <thead><tr><th>Kind</th><th>Title</th><th>Reference</th><th>Period</th><th>Added</th></tr></thead>
          <tbody>
            {q.data.items.map((c) => (
              <tr key={c.id}>
                <td>{CONTRACT_KIND_LABELS[c.kind] ?? c.kind}</td>
                <td>{c.title}{c.notes && <span className="block muted">{c.notes}</span>}</td>
                <td>{c.reference ?? <span className="muted">—</span>}</td>
                <td>{c.startsOn || c.endsOn ? `${c.startsOn ? fmtDate(c.startsOn) : "…"} – ${c.endsOn ? fmtDate(c.endsOn) : "open"}` : <span className="muted">—</span>}</td>
                <td>{c.createdBy.name ?? "—"}<span className="block muted">{fmtDate(c.createdAt)}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {notice && <p className="hint">{notice}</p>}
      {q.data?.canAdd && (
        <div className="rowactions">
          <button type="button" className="btn sm" onClick={() => setAdding(true)}>Add contract</button>
          <span className="hint">Accounts, HR and Associate HR are alerted. Upload the MSA, PO or SOW files under Placement documents.</span>
        </div>
      )}
      {adding && <AddContractDialog placementId={placementId} onClose={() => setAdding(false)} onDone={(kind) => { setAdding(false); setNotice(`${CONTRACT_KIND_LABELS[kind]} added.`); }} />}
    </section>
  );
}

function AddContractDialog({ placementId, onClose, onDone }: { placementId: string; onClose: () => void; onDone: (kind: ContractKind) => void }) {
  const qc = useQueryClient();
  const { busy, error, setError, run } = useSubmit(contractError);
  const [kind, setKind] = useState<ContractKind>("po");
  const [title, setTitle] = useState("");
  const [reference, setReference] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [notes, setNotes] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError("Give the contract a title."); return; }
    if (startsOn && endsOn && endsOn < startsOn) { setError("The end date must be on or after the start date."); return; }
    void run(async () => {
      await contractsApi.create(placementId, {
        kind, title: title.trim(), reference: reference.trim() || null, startsOn: startsOn || null, endsOn: endsOn || null, notes: notes.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: contractKeys.list(placementId) });
      onDone(kind);
    });
  };
  return (
    <Dialog title="Add contract" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Kind">{(a) => <select {...a} value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>{CONTRACT_KINDS.map((k) => <option key={k} value={k}>{CONTRACT_KIND_LABELS[k]}</option>)}</select>}</Field>
        <Field label="Title" hint={`${title.length}/${CONTRACT_TITLE_MAX}. For example "PO 4471 – Q4 staffing".`}>{(a) => <input {...a} data-autofocus maxLength={CONTRACT_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Reference (PO / MSA number)">{(a) => <input {...a} maxLength={CONTRACT_REFERENCE_MAX} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        <Field label="Start date">{(a) => <input {...a} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}</Field>
        <Field label="End date">{(a) => <input {...a} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}</Field>
        <Field label="Notes for Accounts and HR" hint={`${notes.length}/${CONTRACT_NOTES_MAX}. Billing terms, invoicing contact. No personal details.`}>{(a) => <textarea {...a} rows={3} maxLength={CONTRACT_NOTES_MAX} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <DialogActions onCancel={onClose} submitLabel="Add contract" busy={busy} error={error} />
      </form>
    </Dialog>
  );
}
