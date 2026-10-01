import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import { Dialog, DialogActions } from "../admin/Dialog";
import { fieldErrors } from "../sales/errors";
import { Field } from "../sales/ui";
import { pipelineError } from "./errors";
import {
  CONTACT_KIND_LABELS, PLACEMENT_TYPE_LABELS, WORK_MODE_LABELS, pipelineApi,
  pipelineKeys, type ContactKind, type CreatePlacement, type PlacementType, type Submission, type WorkMode,
} from "./pipelineApi";

const FIELDS = ["placementType", "rate", "workMode", "projectCity", "projectState", "tentativeStart", "contacts"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;

interface ContactRow { key: number; kind: ContactKind; name: string; email: string; phone: string }
type ContactErrors = Partial<Record<"name" | "email" | "phone", string>>;

/** A fresh key per dialog open (design B3); a definitive 4xx answer mints a new one so an edited retry is a new request. */
const newKey = () => crypto.randomUUID();

/**
 * Create a placement from a selected submission (POST /api/v1/placements).
 * The rate is optional input: users without rate:read may enter it but never
 * see it back. Snapshots and first-placement are set by the server (PL-2, PL-3).
 */
export function CreatePlacementDialog({ submission, onClose, onCreated }: {
  submission: Pick<Submission, "id" | "candidateName" | "jobTitle" | "client">;
  onClose: () => void;
  onCreated: (r: { id: string; isFirstPlacement: boolean }) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const keyRef = useRef<string>(newKey());
  const nextRow = useRef(1);
  const [v, setV] = useState({
    placementType: "" as PlacementType | "", workMode: "" as WorkMode | "", projectCity: "", projectState: "", tentativeStart: "", rate: "",
  });
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [contactErrors, setContactErrors] = useState<Record<number, ContactErrors>>({});
  const [formError, setFormError] = useState("");
  const [blocked, setBlocked] = useState(false);
  /** 409 idempotency_key_reused: an earlier attempt with this key already created the placement. */
  const [alreadyCreated, setAlreadyCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const refreshAndClose = () => {
    void qc.invalidateQueries({ queryKey: pipelineKeys.placements });
    void qc.invalidateQueries({ queryKey: pipelineKeys.submissions });
    onClose();
  };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const addContact = () => {
    const key = nextRow.current++;
    setContacts((c) => [...c, { key, kind: "vendor_poc", name: "", email: "", phone: "" }]);
    // Move focus to the new row's first control once it renders.
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-row="${key}"] select`)?.focus());
  };
  const removeContact = (key: number, index: number) => {
    setContacts((c) => c.filter((r) => r.key !== key));
    setContactErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    // Keep focus in the editor: the next row's remove button, the previous one, or "Add contact".
    requestAnimationFrame(() => {
      const rows = formRef.current?.querySelectorAll<HTMLElement>("[data-row] .rmcontact") ?? [];
      (rows[index] ?? rows[index - 1] ?? formRef.current?.querySelector<HTMLElement>(".addcontact"))?.focus();
    });
  };
  const setContact = (key: number, k: keyof Omit<ContactRow, "key">, value: string) =>
    setContacts((c) => c.map((r) => (r.key === key ? { ...r, [k]: value } : r)));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.placementType) e.placementType = "Choose the placement type.";
    if (!v.workMode) e.workMode = "Choose the work mode.";
    if (!v.tentativeStart) e.tentativeStart = "Choose the tentative start date.";
    if (v.rate.trim()) {
      const r = Number(v.rate);
      if (!Number.isFinite(r) || r <= 0 || r > 1000) e.rate = "Enter an hourly rate between 0 and 1000, or leave it empty.";
    }
    if (v.projectCity.length > 80) e.projectCity = "Keep the city under 80 characters.";
    if (v.projectState.length > 40) e.projectState = "Keep the state under 40 characters.";
    const ce: Record<number, ContactErrors> = {};
    for (const c of contacts) {
      const x: ContactErrors = {};
      if (!c.name.trim()) x.name = "Enter the contact's name.";
      if (c.email.trim() && !EMAIL.test(c.email.trim())) x.email = "Enter a valid email or leave it empty.";
      if (c.phone.trim() && !PHONE.test(c.phone.trim())) x.phone = "Enter a valid phone number or leave it empty.";
      if (Object.keys(x).length) ce[c.key] = x;
    }
    return { e, ce };
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const { e, ce } = validate();
    setErrors(e); setContactErrors(ce); setFormError("");
    if (Object.keys(e).length || Object.keys(ce).length) {
      // After React applies this round's errors, so stale marks from an earlier attempt don't win.
      const form = ev.currentTarget;
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    const body: CreatePlacement = {
      submissionId: submission.id,
      placementType: v.placementType as PlacementType,
      workMode: v.workMode as WorkMode,
      tentativeStart: v.tentativeStart,
      ...(v.rate.trim() ? { rate: Number(v.rate) } : {}),
      ...(v.projectCity.trim() ? { projectCity: v.projectCity.trim() } : {}),
      ...(v.projectState.trim() ? { projectState: v.projectState.trim() } : {}),
      ...(contacts.length ? {
        contacts: contacts.map((c) => ({
          kind: c.kind, name: c.name.trim(),
          ...(c.email.trim() ? { email: c.email.trim() } : {}),
          ...(c.phone.trim() ? { phone: c.phone.trim() } : {}),
        })),
      } : {}),
    };
    setBusy(true);
    try {
      const r = await pipelineApi.createPlacement(body, keyRef.current);
      onCreated(r);
    } catch (err) {
      // The server answered definitively: nothing was created, so an edited retry must be a new request.
      // Network failures and 5xx keep the key, so a retry can't create a second placement.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) keyRef.current = newKey();
      if (err instanceof ApiError && (err.detail === "placement_exists" || err.detail === "submission_not_selected" || err.status === 409)) setBlocked(true);
      if (err instanceof ApiError && err.status === 409 && err.detail === "idempotency_key_reused") {
        setAlreadyCreated(true);
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(".refreshclose")?.focus());
      }
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      const { contacts: contactsErr, ...rest } = perField;
      setErrors(rest);
      setFormError([_form ?? pipelineError(err, "createPlacement"), contactsErr && `Contacts: ${contactsErr}`].filter(Boolean).join(" "));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Create placement · ${submission.candidateName ?? "Candidate"}`} onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <p className="hint">{submission.jobTitle} at {submission.client}. Candidate, team, client and vendor come from the submission.</p>
        <div className="grid2">
          <Field label="Placement type" error={errors.placementType}>
            {(p) => (
              <select {...p} value={v.placementType} onChange={set("placementType")} data-autofocus>
                <option value="" disabled>Choose…</option>
                {(Object.keys(PLACEMENT_TYPE_LABELS) as PlacementType[]).map((t) => <option key={t} value={t}>{PLACEMENT_TYPE_LABELS[t]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Work mode" error={errors.workMode}>
            {(p) => (
              <select {...p} value={v.workMode} onChange={set("workMode")}>
                <option value="" disabled>Choose…</option>
                {(Object.keys(WORK_MODE_LABELS) as WorkMode[]).map((m) => <option key={m} value={m}>{WORK_MODE_LABELS[m]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Project city (optional)" error={errors.projectCity}>
            {(p) => <input {...p} maxLength={80} value={v.projectCity} onChange={set("projectCity")} />}
          </Field>
          <Field label="Project state (optional)" error={errors.projectState}>
            {(p) => <input {...p} maxLength={40} value={v.projectState} onChange={set("projectState")} />}
          </Field>
          <Field label="Tentative start date" error={errors.tentativeStart}>
            {(p) => <input {...p} type="date" value={v.tentativeStart} onChange={set("tentativeStart")} />}
          </Field>
          <Field label="Rate per hour (optional)" hint="Saved with the placement; shown only to people allowed to see rates." error={errors.rate}>
            {(p) => <input {...p} type="number" inputMode="decimal" min="0" max="1000" step="0.01" value={v.rate} onChange={set("rate")} autoComplete="off" />}
          </Field>
        </div>

        <fieldset className="contacts">
          <legend>Contacts (optional)</legend>
          {contacts.length === 0 && <p className="hint">Add the vendor, invoicing or client contacts for HR and Accounts.</p>}
          {contacts.map((c, i) => {
            const ce = contactErrors[c.key] ?? {};
            const n = i + 1;
            return (
              <div key={c.key} className="contactrow" data-row={c.key} role="group" aria-label={`Contact ${n}`}>
                <div className="field">
                  <label htmlFor={`${id}-k${c.key}`}>Kind</label>
                  <select id={`${id}-k${c.key}`} value={c.kind} onChange={(e) => setContact(c.key, "kind", e.target.value)}>
                    {(Object.keys(CONTACT_KIND_LABELS) as ContactKind[]).map((k) => <option key={k} value={k}>{CONTACT_KIND_LABELS[k]}</option>)}
                  </select>
                </div>
                <ContactInput id={`${id}-n${c.key}`} label="Name" value={c.name} error={ce.name} onChange={(x) => setContact(c.key, "name", x)} maxLength={120} />
                <ContactInput id={`${id}-e${c.key}`} label="Email (optional)" type="email" value={c.email} error={ce.email} onChange={(x) => setContact(c.key, "email", x)} maxLength={254} />
                <ContactInput id={`${id}-p${c.key}`} label="Phone (optional)" type="tel" value={c.phone} error={ce.phone} onChange={(x) => setContact(c.key, "phone", x)} maxLength={20} />
                <button type="button" className="btn sm danger rmcontact" onClick={() => removeContact(c.key, i)} aria-label={`Remove contact ${n}`}>Remove</button>
              </div>
            );
          })}
          <button type="button" className="btn sm addcontact" onClick={addContact} disabled={contacts.length >= 10}>Add contact</button>
        </fieldset>

        {alreadyCreated ? (
          <>
            <p className="error formerr" role="alert">{formError}</p>
            <div className="actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary refreshclose" onClick={refreshAndClose}>Refresh and close</button>
            </div>
          </>
        ) : (
          <DialogActions onCancel={onClose} submitLabel="Create placement" busy={busy} disabled={blocked} error={formError} />
        )}
      </form>
    </Dialog>
  );
}

function ContactInput({ id, label, value, error, onChange, type = "text", maxLength }: {
  id: string; label: string; value: string; error?: string; onChange: (v: string) => void; type?: string; maxLength: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} maxLength={maxLength} autoComplete="off" onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} />
      {error && <small id={`${id}-err`} className="error fielderr">{error}</small>}
    </div>
  );
}
