import { useRef, useState } from "react";
import { Dialog, DialogActions } from "../admin/Dialog";
import { LookupPicker } from "../lookups";
import { UUID_RE, fieldErrors, salesError } from "./errors";
import { salesApi, type CreateCandidate } from "./salesApi";
import { Field, useFocusAfterFailure } from "./ui";

const FIELDS = ["firstName", "lastName", "phone", "technologyId", "locationId"] as const;
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * New candidate (POST /api/v1/candidates). The team defaults server-side to the
 * creator's team and a recruiter becomes the candidate's recruiter.
 * Technology and location come from the lookups pickers; `locations` (the ones
 * the user has already seen) are the fallback when the lookup list is unavailable.
 */
export function CreateCandidateDialog({ locations, onClose, onCreated }: {
  locations: { id: string; name: string }[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [v, setV] = useState({ firstName: "", lastName: "", phone: "", technologyId: "", locationId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.firstName.trim()) e.firstName = "Enter a first name.";
    if (!v.lastName.trim()) e.lastName = "Enter a last name.";
    if (v.phone.trim() && !E164.test(v.phone.trim())) e.phone = "Use international format, e.g. +14695550142.";
    if (!UUID_RE.test(v.technologyId.trim())) e.technologyId = "Choose a technology.";
    if (!UUID_RE.test(v.locationId.trim())) e.locationId = "Choose a location.";
    return e;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { failed(); return; }
    const body: CreateCandidate = {
      firstName: v.firstName.trim(), lastName: v.lastName.trim(),
      technologyId: v.technologyId.trim(), locationId: v.locationId.trim(),
      ...(v.phone.trim() ? { phone: v.phone.trim() } : {}),
    };
    setBusy(true);
    try {
      const { id } = await salesApi.create(body);
      onCreated(id);
    } catch (err) {
      const fe = fieldErrors(err, FIELDS);
      const { _form, ...perField } = fe;
      setErrors(perField);
      setFormError(_form ?? salesError(err, "create"));
      failed();
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="New candidate" onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="First name" error={errors.firstName}>
          {(p) => <input {...p} autoComplete="off" value={v.firstName} onChange={set("firstName")} data-autofocus />}
        </Field>
        <Field label="Last name" error={errors.lastName}>
          {(p) => <input {...p} autoComplete="off" value={v.lastName} onChange={set("lastName")} />}
        </Field>
        <Field label="Phone (optional)" hint="International format, e.g. +14695550142" error={errors.phone}>
          {(p) => <input {...p} type="tel" value={v.phone} onChange={set("phone")} />}
        </Field>
        <LookupPicker kind="technologies" label="Technology" value={v.technologyId} error={errors.technologyId}
          onChange={(id) => setV((s) => ({ ...s, technologyId: id }))} />
        <LookupPicker kind="locations" label="Location" value={v.locationId} error={errors.locationId} fallback={locations}
          onChange={(id) => setV((s) => ({ ...s, locationId: id }))} />
        <DialogActions onCancel={onClose} submitLabel="Create candidate" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
