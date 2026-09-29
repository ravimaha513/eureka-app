import { useState } from "react";
import { Dialog, DialogActions } from "../admin/Dialog";
import { fieldErrors, salesError } from "./errors";
import { salesApi, type CandidateProfile, type Priority, type ProfileUpdate } from "./salesApi";
import { Field } from "./ui";

const FIELDS = ["priority", "marketingStartDate", "marketingEmail", "vitelNumber", "inPersonOk"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Edits the profile fields a candidate:update holder may change (ProfileUpdate;
 * team, recruiter, status, visibility and rating have their own actions).
 * Only changed fields are sent. Marketing email, VITEL number and in-person
 * preference are not returned by the API, so empty means "keep as is".
 */
export function EditProfileDialog({ candidate, onClose, onSaved }: {
  candidate: CandidateProfile; onClose: () => void; onSaved: () => void;
}) {
  const [v, setV] = useState({
    priority: candidate.priority as Priority,
    marketingStartDate: candidate.marketingStartDate?.slice(0, 10) ?? "",
    marketingEmail: "", vitelNumber: "", inPersonOk: "" as "" | "yes" | "no",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (v.marketingEmail.trim() && !EMAIL.test(v.marketingEmail.trim())) e.marketingEmail = "Enter a valid email address.";
    if (v.vitelNumber.trim().length > 20) e.vitelNumber = "Use at most 20 characters.";
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { ev.currentTarget.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(); return; }

    const body: ProfileUpdate = {};
    if (v.priority !== candidate.priority) body.priority = v.priority;
    if (v.marketingStartDate && v.marketingStartDate !== (candidate.marketingStartDate?.slice(0, 10) ?? "")) body.marketingStartDate = v.marketingStartDate;
    if (v.marketingEmail.trim()) body.marketingEmail = v.marketingEmail.trim();
    if (v.vitelNumber.trim()) body.vitelNumber = v.vitelNumber.trim();
    if (v.inPersonOk) body.inPersonOk = v.inPersonOk === "yes";
    if (Object.keys(body).length === 0) { setFormError("Nothing changed."); return; }

    setBusy(true);
    try {
      await salesApi.update(candidate.id, body);
      onSaved();
    } catch (err) {
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      setErrors(perField);
      setFormError(_form ?? salesError(err, "profile"));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Edit ${candidate.name}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Priority" error={errors.priority}>
          {(p) => (
            <select {...p} value={v.priority} onChange={(e) => setV((s) => ({ ...s, priority: e.target.value as Priority }))} data-autofocus>
              <option value="P1">P1 (highest)</option><option value="P2">P2</option><option value="P3">P3</option>
            </select>
          )}
        </Field>
        <Field label="Marketing start date" error={errors.marketingStartDate}>
          {(p) => <input {...p} type="date" value={v.marketingStartDate} onChange={(e) => setV((s) => ({ ...s, marketingStartDate: e.target.value }))} />}
        </Field>
        <Field label="Marketing email" hint="Leave empty to keep the current value." error={errors.marketingEmail}>
          {(p) => <input {...p} type="email" value={v.marketingEmail} onChange={(e) => setV((s) => ({ ...s, marketingEmail: e.target.value }))} />}
        </Field>
        <Field label="VITEL number" hint="Leave empty to keep the current value." error={errors.vitelNumber}>
          {(p) => <input {...p} value={v.vitelNumber} onChange={(e) => setV((s) => ({ ...s, vitelNumber: e.target.value }))} />}
        </Field>
        <Field label="In-person interviews" error={errors.inPersonOk}>
          {(p) => (
            <select {...p} value={v.inPersonOk} onChange={(e) => setV((s) => ({ ...s, inPersonOk: e.target.value as typeof v.inPersonOk }))}>
              <option value="">Keep as is</option><option value="yes">Open to in-person</option><option value="no">Remote only</option>
            </select>
          )}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Save changes" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
