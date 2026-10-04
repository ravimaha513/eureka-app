import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WORK_AUTH_NUMBER_RE, WORK_AUTH_STATUSES, WORK_AUTH_STATUS_LABELS, WORK_AUTH_TYPES, WORK_AUTH_TYPE_LIST,
  normalizeWorkAuthNumber, type WorkAuthStatus, type WorkAuthType,
} from "@eureka/shared";
import { ApiError } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { Field, fmtDate, useFocusAfterFailure } from "../sales/ui";
import { workAuthApi, workAuthKeys, type WorkAuthInput, type WorkAuthorization } from "./workAuthApi";
import { StepUpDialog } from "../documents/StepUpDialog";
import { documentKeys, isStepUpRequired } from "../documents/documentsApi";

/** A revealed number is hidden again after this long. */
export const REVEAL_VISIBLE_MS = 60_000;

export function workAuthError(e: unknown, action: "load" | "save" | "reveal"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "step_up_required") return "Confirm it's you to show the number.";
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return action === "save" ? "You can't change work authorization for this candidate." : "You can't see work authorization for this candidate.";
    case 404: return "This record or candidate isn't available from your account.";
    case 409: return "No number is stored for this record.";
    case 412: return "Someone else changed this record. Close the form and open it again to see the latest version.";
    case 422: return e.errors?.[0]?.message ?? (e.detail ? `Check the form: ${e.detail}.` : "Check the form.");
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? "Something went wrong.";
  }
}

function expiryText(w: WorkAuthorization): string {
  if (!w.validTo) return "No expiry date";
  if (w.expired) return `Expired ${fmtDate(w.validTo)}`;
  if (w.daysToExpiry !== null && w.daysToExpiry <= 90) return `${fmtDate(w.validTo)} (in ${w.daysToExpiry} day${w.daysToExpiry === 1 ? "" : "s"})`;
  return fmtDate(w.validTo);
}

/**
 * Work authorization on the candidate profile (FR-VIS-01, 02). Shown to
 * visa:read holders (HR, Immigration); the server decides per candidate
 * (403/404 hide the section). Numbers are masked; "Show number" asks the
 * server, which audits each reveal and needs a step-up of this session
 * ("Confirm it's you", the same as restricted documents).
 */
export function CandidateWorkAuthorization({ candidateId }: { candidateId: string }) {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<WorkAuthorization | "new" | null>(null);
  const [stepUpFor, setStepUpFor] = useState<WorkAuthorization | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const q = useQuery({ queryKey: workAuthKeys.list(candidateId), queryFn: () => workAuthApi.list(candidateId) });

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;

  const hide = (id: string) => {
    setRevealed((r) => { const { [id]: _, ...rest } = r; return rest; });
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  };

  const reveal = async (w: WorkAuthorization) => {
    setError(""); setMessage(""); setBusy(w.id);
    try {
      const { number } = await workAuthApi.reveal(candidateId, w.id);
      setRevealed((r) => ({ ...r, [w.id]: number }));
      timers.current.set(w.id, setTimeout(() => hide(w.id), REVEAL_VISIBLE_MS));
      setMessage(`${WORK_AUTH_TYPES[w.type]} number shown. It hides again in a minute.`);
    } catch (err) {
      if (isStepUpRequired(err)) setStepUpFor(w);
      else setError(workAuthError(err, "reveal"));
    } finally {
      setBusy(null);
    }
  };

  const items = q.data?.items ?? [];
  return (
    <section className="card pad" aria-labelledby="workauth-h">
      <h2 id="workauth-h">Work authorization</h2>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {error && <p className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error">{workAuthError(q.error, "load")}</p>
        : items.length === 0 ? <p className="muted">No work authorization recorded.</p>
        : (
          <div className="tablewrap"><table aria-label="Work authorization records">
            <thead><tr>
              <th scope="col">Type</th><th scope="col">Number</th><th scope="col">Valid from</th><th scope="col">Expires</th>
              <th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td>{WORK_AUTH_TYPES[w.type]}</td>
                  <td>
                    {!w.hasNumber ? "—" : revealed[w.id] !== undefined
                      ? <><code>{revealed[w.id]}</code>{" "}<button type="button" className="btn sm" onClick={() => hide(w.id)}>Hide<span className="sr-only"> number</span></button></>
                      : <>
                        <span aria-label="Number hidden">{w.numberMasked}</span>{" "}
                        {q.data?.canReveal && (
                          <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === w.id || undefined} onClick={() => void reveal(w)}>
                            Show number<span className="sr-only"> for {WORK_AUTH_TYPES[w.type]}</span>
                          </button>
                        )}
                      </>}
                  </td>
                  <td>{fmtDate(w.validFrom)}</td>
                  <td>{expiryText(w)}</td>
                  <td><span className={`badge workauth-${w.expired ? "expired" : w.status}`}>{w.expired ? "Expired" : WORK_AUTH_STATUS_LABELS[w.status]}</span></td>
                  <td>
                    {q.data?.canEdit && (
                      <button type="button" className="btn sm" onClick={() => setEditing(w)}>
                        Edit<span className="sr-only"> {WORK_AUTH_TYPES[w.type]}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      {q.data?.canEdit && (
        <button type="button" className="btn" onClick={() => setEditing("new")}>Add work authorization</button>
      )}
      {editing && (
        <WorkAuthDialog candidateId={candidateId} record={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage(text);
            if (editing !== "new") hide(editing.id);
            void qc.invalidateQueries({ queryKey: workAuthKeys.list(candidateId) });
          }} />
      )}
      {stepUpFor && (
        <StepUpDialog onClose={() => setStepUpFor(null)}
          onConfirmed={() => { const w = stepUpFor; setStepUpFor(null); void qc.invalidateQueries({ queryKey: documentKeys.stepUp }); void reveal(w); }} />
      )}
    </section>
  );
}

function WorkAuthDialog({ candidateId, record, onClose, onSaved }: {
  candidateId: string; record: WorkAuthorization | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, setError, run } = useSubmit((e) => workAuthError(e, "save"));
  const [type, setType] = useState<WorkAuthType>(record?.type ?? "h1b");
  const [status, setStatus] = useState<WorkAuthStatus>(record?.status ?? "valid");
  const [validFrom, setValidFrom] = useState(record?.validFrom ?? "");
  const [validTo, setValidTo] = useState(record?.validTo ?? "");
  const [number, setNumber] = useState("");
  const [removeNumber, setRemoveNumber] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ number?: string; validTo?: string }>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    const n = normalizeWorkAuthNumber(number);
    if (n && !WORK_AUTH_NUMBER_RE.test(n)) errs.number = "Use 1-40 letters, digits or hyphens.";
    if (validFrom && validTo && validTo < validFrom) errs.validTo = "The expiry date can't be before the start date.";
    setFieldErrors(errs);
    if (Object.keys(errs).length) { setError(""); failed(); return; }
    void run(async () => {
      try {
        const body: WorkAuthInput = { type, status, validFrom: validFrom || null, validTo: validTo || null };
        if (record) {
          const changes: Partial<WorkAuthInput> = { ...body, ...(removeNumber ? { number: null } : n ? { number: n } : {}) };
          await workAuthApi.update(candidateId, record.id, record.rowVersion, changes);
          onSaved("Work authorization saved.");
        } else {
          await workAuthApi.create(candidateId, n ? { ...body, number: n } : body);
          onSaved("Work authorization added.");
        }
      } catch (err) {
        failed();
        throw err;
      }
    });
  };

  return (
    <Dialog title={record ? "Edit work authorization" : "Add work authorization"} onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="Type">
          {(p) => (
            <select {...p} value={type} onChange={(e) => setType(e.target.value as WorkAuthType)} data-autofocus>
              {WORK_AUTH_TYPE_LIST.map((t) => <option key={t} value={t}>{WORK_AUTH_TYPES[t]}</option>)}
            </select>
          )}
        </Field>
        <Field label="Number" error={fieldErrors.number}
          hint={record?.hasNumber ? "Leave empty to keep the stored number. Stored encrypted; only HR and Immigration can show it." : "Optional. Stored encrypted; only HR and Immigration can show it."}>
          {(p) => <input {...p} value={number} autoComplete="off" spellCheck={false} disabled={removeNumber}
            onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        {record?.hasNumber && (
          <div className="field">
            <label><input type="checkbox" checked={removeNumber} onChange={(e) => setRemoveNumber(e.target.checked)} /> Remove the stored number</label>
          </div>
        )}
        <Field label="Valid from">{(p) => <input {...p} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}</Field>
        <Field label="Expires on" error={fieldErrors.validTo} hint="HR and Immigration are reminded before this date.">
          {(p) => <input {...p} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />}
        </Field>
        <Field label="Status">
          {(p) => (
            <select {...p} value={status} onChange={(e) => setStatus(e.target.value as WorkAuthStatus)}>
              {WORK_AUTH_STATUSES.map((s) => <option key={s} value={s}>{WORK_AUTH_STATUS_LABELS[s]}</option>)}
            </select>
          )}
        </Field>
        <DialogActions onCancel={onClose} submitLabel={record ? "Save" : "Add"} busy={busy} error={error} />
      </form>
    </Dialog>
  );
}
