import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PHONE_PROBLEM_MESSAGES, normalizePhoneE164, phoneProblem } from "@eureka/shared";
import { ApiError } from "../api";
import { Dialog, DialogActions } from "../ui/Dialog";
import { LookupPicker } from "../lookups";
import { UUID_RE, fieldErrors, salesError } from "./errors";
import { OPEN_BATCH_STATUSES, salesApi, salesKeys, type CreateCandidate, type Duplicate } from "./salesApi";
import { Field, useFocusAfterFailure } from "./ui";

const FIELDS = ["firstName", "lastName", "phone", "email", "technologyId", "locationId", "batchId"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * New candidate (POST /api/v1/candidates). The team defaults server-side to the
 * creator's team and a recruiter becomes the candidate's recruiter.
 * Technology and location come from the lookups pickers; `locations` (the ones
 * the user has already seen) are the fallback when the lookup list is unavailable.
 *
 * Email and phone are required and unique across candidates (CA-6): the
 * server answers 409 `duplicate_contact` when another candidate has either.
 * The dialog then asks the duplicate check for the minimal details it may show
 * (owning team and contact; a link only when the user can open that profile).
 * There is no "Create anyway": the email or phone has to change.
 */
export function CreateCandidateDialog({ locations, onClose, onCreated, onOpenProfile, canAddTechnology = false }: {
  locations: { id: string; name: string }[]; onClose: () => void; onCreated: (id: string) => void;
  /** technology:create: the Technology picker offers "Add a new technology…". */
  canAddTechnology?: boolean;
  onOpenProfile?: (id: string) => void;
}) {
  const [v, setV] = useState({ firstName: "", lastName: "", phone: "", email: "", technologyId: "", locationId: "", batchId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setV((s) => ({ ...s, [k]: e.target.value }));
    if (k === "phone" || k === "email" || k === "firstName" || k === "lastName") setDuplicates(null);
  };

  const batches = useQuery({
    queryKey: [...salesKeys.batches, v.locationId],
    queryFn: () => salesApi.batches(v.locationId),
    enabled: UUID_RE.test(v.locationId),
    staleTime: 60_000,
  });
  const openBatches = (batches.data?.items ?? []).filter((b) => OPEN_BATCH_STATUSES.includes(b.status));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.firstName.trim()) e.firstName = "Enter a first name.";
    if (!v.lastName.trim()) e.lastName = "Enter a last name.";
    if (!v.phone.trim()) e.phone = "Enter a phone number.";
    else {
      const pp = phoneProblem(v.phone);
      if (pp) e.phone = PHONE_PROBLEM_MESSAGES[pp];
    }
    if (!v.email.trim()) e.email = "Enter a personal email.";
    else if (!EMAIL.test(v.email.trim())) e.email = "Enter a valid email address.";
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
      phone: normalizePhoneE164(v.phone)!, email: v.email.trim(),
      ...(v.batchId && openBatches.some((b) => b.id === v.batchId) ? { batchId: v.batchId } : {}),
    };
    setBusy(true);
    try {
      const { id } = await salesApi.create(body);
      onCreated(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.detail === "duplicate_contact") {
        try {
          const r = await salesApi.duplicateCheck({ firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email });
          setDuplicates(r.duplicates.length ? r.duplicates : [{ candidateId: null, team: "another team", contact: null, matchedOn: [] }]);
        } catch (e2) {
          setFormError(salesError(e2));
          failed();
        }
        return;
      }
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
        <Field label="Phone" hint="With the country code, e.g. +1 469 555 0142. One candidate per phone." error={errors.phone}>
          {(p) => <input {...p} type="tel" required value={v.phone} onChange={set("phone")} />}
        </Field>
        <Field label="Personal email" hint="One candidate per email." error={errors.email}>
          {(p) => <input {...p} type="email" required autoComplete="off" value={v.email} onChange={set("email")} />}
        </Field>
        <LookupPicker kind="technologies" label="Technology" value={v.technologyId} error={errors.technologyId} canAdd={canAddTechnology}
          onChange={(id) => setV((s) => ({ ...s, technologyId: id }))} />
        <LookupPicker kind="locations" label="Location" value={v.locationId} error={errors.locationId} fallback={locations}
          onChange={(id) => setV((s) => ({ ...s, locationId: id, batchId: "" }))} />
        {openBatches.length > 0 && (
          <Field label="Batch (optional)" error={errors.batchId}>
            {(p) => (
              <select {...p} value={v.batchId} onChange={(e) => setV((s) => ({ ...s, batchId: e.target.value }))}>
                <option value="">No batch</option>
                {openBatches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            )}
          </Field>
        )}
        {duplicates && <DuplicateWarning duplicates={duplicates} onOpenProfile={onOpenProfile} />}
        <DialogActions onCancel={onClose} submitLabel="Create candidate" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}

function DuplicateWarning({ duplicates, onOpenProfile }: { duplicates: Duplicate[]; onOpenProfile?: (id: string) => void }) {
  const on = (d: Duplicate) => d.matchedOn.length === 2 ? "email and phone" : d.matchedOn[0] ?? "details";
  return (
    <div className="note warn" role="alert">
      <p><b>Already a candidate.</b> A candidate with the same {on(duplicates[0]!)} already exists. Use a different email and phone, or open the existing profile.</p>
      <ul>
        {duplicates.map((d, i) => (
          <li key={d.candidateId ?? i}>
            Same {on(d)}: {d.team}{d.contact ? `, contact ${d.contact}` : ""}
            {d.candidateId && onOpenProfile && (
              <> {" "}<button type="button" className="btn sm" onClick={() => onOpenProfile(d.candidateId!)}>Open existing profile</button></>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
