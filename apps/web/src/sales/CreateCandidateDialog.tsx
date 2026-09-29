import { useState } from "react";
import { Dialog, DialogActions } from "../admin/Dialog";
import { UUID_RE, fieldErrors, salesError } from "./errors";
import { salesApi, type CreateCandidate } from "./salesApi";
import { Field } from "./ui";

const FIELDS = ["firstName", "lastName", "phone", "technologyId", "locationId"] as const;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const OTHER = "__other__";

/**
 * New candidate (POST /api/v1/candidates). The team defaults server-side to the
 * creator's team and a recruiter becomes the candidate's recruiter.
 * `locations` are the locations the user has already seen; an ID can be typed otherwise.
 */
export function CreateCandidateDialog({ locations, onClose, onCreated }: {
  locations: { id: string; name: string }[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [v, setV] = useState({ firstName: "", lastName: "", phone: "", technologyId: "", locationId: locations[0]?.id ?? "" });
  const [locChoice, setLocChoice] = useState(locations[0]?.id ?? OTHER);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.firstName.trim()) e.firstName = "Enter a first name.";
    if (!v.lastName.trim()) e.lastName = "Enter a last name.";
    if (v.phone.trim() && !E164.test(v.phone.trim())) e.phone = "Use international format, e.g. +14695550142.";
    if (!UUID_RE.test(v.technologyId.trim())) e.technologyId = "Enter the technology's ID.";
    if (!UUID_RE.test(v.locationId.trim())) e.locationId = "Pick a location or enter its ID.";
    return e;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError("");
    if (Object.keys(e).length) {
      (ev.currentTarget.querySelector<HTMLElement>("[aria-invalid='true']"))?.focus();
      return;
    }
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
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="New candidate" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="First name" error={errors.firstName}>
          {(p) => <input {...p} autoComplete="off" value={v.firstName} onChange={set("firstName")} data-autofocus />}
        </Field>
        <Field label="Last name" error={errors.lastName}>
          {(p) => <input {...p} autoComplete="off" value={v.lastName} onChange={set("lastName")} />}
        </Field>
        <Field label="Phone (optional)" hint="International format, e.g. +14695550142" error={errors.phone}>
          {(p) => <input {...p} type="tel" value={v.phone} onChange={set("phone")} />}
        </Field>
        <Field label="Technology ID" hint="The API has no technology list yet; paste the technology's ID." error={errors.technologyId}>
          {(p) => <input {...p} value={v.technologyId} onChange={set("technologyId")} spellCheck={false} />}
        </Field>
        {locations.length > 0 && (
          <Field label="Location">
            {(p) => (
              <select {...p} value={locChoice} onChange={(e) => {
                setLocChoice(e.target.value);
                setV((s) => ({ ...s, locationId: e.target.value === OTHER ? "" : e.target.value }));
              }}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                <option value={OTHER}>Other (enter an ID)…</option>
              </select>
            )}
          </Field>
        )}
        {(locChoice === OTHER || locations.length === 0) ? (
          <Field label="Location ID" error={errors.locationId}>
            {(p) => <input {...p} value={v.locationId} onChange={set("locationId")} spellCheck={false} />}
          </Field>
        ) : errors.locationId ? <p className="error fielderr">{errors.locationId}</p> : null}
        <DialogActions onCancel={onClose} submitLabel="Create candidate" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
