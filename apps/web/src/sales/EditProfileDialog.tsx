import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ELIGIBILITY_OPTIONS, MARKETING_LOCATIONS_MAX, VISA_CATEGORIES } from "@eureka/shared";
import { useLookups } from "../lookups";
import { Dialog, DialogActions } from "../admin/Dialog";
import { fieldErrors, salesError } from "./errors";
import { OPEN_BATCH_STATUSES, salesApi, salesKeys, type CandidateProfile, type Priority, type ProfileUpdate } from "./salesApi";
import { Field } from "./ui";

const FIELDS = ["priority", "marketingStartDate", "marketingEmail", "vitelNumber", "inPersonOk", "batchId",
  "ghLocation", "marketingLocations", "linkedinUrl", "resumeUrl", "eligibility", "visaCategory"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKEDIN = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/\S+$/;
const HTTPS = /^https:\/\/\S+$/;
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** "Dallas, TX; Austin, TX" -> ["Dallas, TX", "Austin, TX"] */
const splitLocations = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);

/**
 * Edits the profile fields a candidate:update holder may change (ProfileUpdate;
 * team, recruiter, status, visibility and rating have their own actions).
 * Only changed fields are sent. Marketing email and VITEL number start from
 * the current values when the API returns them (they cannot be removed, only
 * changed); otherwise empty means "keep as is". The in-person preference
 * starts from the current value when known.
 */
export function EditProfileDialog({ candidate, onClose, onSaved }: {
  candidate: CandidateProfile; onClose: () => void; onSaved: () => void;
}) {
  const initial = {
    marketingEmail: candidate.marketingEmail ?? "",
    vitelNumber: candidate.vitelNumber ?? "",
    inPersonOk: (candidate.inPersonOk === true ? "yes" : candidate.inPersonOk === false ? "no" : "") as "" | "yes" | "no",
  };
  const initialStay = candidate.stay === "remote" ? "remote" : candidate.ghLocation?.id ?? "";
  const initialLocations = candidate.marketingLocations ?? [];
  const initialEligibility = candidate.eligibility ?? [];
  const [v, setV] = useState({
    priority: candidate.priority as Priority,
    marketingStartDate: candidate.marketingStartDate?.slice(0, 10) ?? "",
    ...initial,
    batchId: candidate.batch?.id ?? "",
    stay: initialStay,
    marketingLocations: initialLocations.join("; "),
    linkedinUrl: candidate.linkedinUrl ?? "",
    resumeUrl: candidate.resumeUrl ?? "",
    eligibility: initialEligibility,
    visaCategory: candidate.visaCategory ?? "",
  });
  const locations = useLookups().data?.locations ?? [];
  const keepHint = (known: boolean) => known ? "Can be changed but not removed." : "Leave empty to keep the current value.";
  // Batches the candidate can join: at its location, planned or in training (FR-CAN-02).
  const batches = useQuery({
    queryKey: [...salesKeys.batches, candidate.location.id],
    queryFn: () => salesApi.batches(candidate.location.id),
    enabled: candidate.batch !== undefined,
    staleTime: 60_000,
  });
  const openBatches = (batches.data?.items ?? []).filter((b) => OPEN_BATCH_STATUSES.includes(b.status) || b.id === candidate.batch?.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (v.marketingEmail.trim() && !EMAIL.test(v.marketingEmail.trim())) e.marketingEmail = "Enter a valid email address.";
    if (v.vitelNumber.trim().length > 20) e.vitelNumber = "Use at most 20 characters.";
    if (v.linkedinUrl.trim() && !LINKEDIN.test(v.linkedinUrl.trim())) e.linkedinUrl = "Use an https://linkedin.com/… link.";
    if (v.resumeUrl.trim() && !HTTPS.test(v.resumeUrl.trim())) e.resumeUrl = "Use an https:// link.";
    const locs = splitLocations(v.marketingLocations);
    if (locs.length > MARKETING_LOCATIONS_MAX) e.marketingLocations = `Enter at most ${MARKETING_LOCATIONS_MAX} locations.`;
    else if (locs.some((l) => l.length > 60)) e.marketingLocations = "Each location can have at most 60 characters.";
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { ev.currentTarget.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(); return; }

    const body: ProfileUpdate = {};
    if (v.priority !== candidate.priority) body.priority = v.priority;
    if (v.marketingStartDate && v.marketingStartDate !== (candidate.marketingStartDate?.slice(0, 10) ?? "")) body.marketingStartDate = v.marketingStartDate;
    if (v.marketingEmail.trim() && v.marketingEmail.trim() !== initial.marketingEmail) body.marketingEmail = v.marketingEmail.trim();
    if (v.vitelNumber.trim() && v.vitelNumber.trim() !== initial.vitelNumber) body.vitelNumber = v.vitelNumber.trim();
    if (v.inPersonOk && v.inPersonOk !== initial.inPersonOk) body.inPersonOk = v.inPersonOk === "yes";
    if (candidate.batch !== undefined && v.batchId !== (candidate.batch?.id ?? "")) body.batchId = v.batchId || null;
    if (candidate.stay !== undefined && v.stay !== initialStay) body.ghLocation = v.stay || null;
    if (candidate.marketingLocations !== undefined && !sameList(locs, initialLocations)) body.marketingLocations = locs;
    // The links are returned to owners only; editors are owners (candidate:update), so the current value is known.
    if (candidate.linkedinUrl !== undefined && v.linkedinUrl.trim() !== (candidate.linkedinUrl ?? "")) body.linkedinUrl = v.linkedinUrl.trim() || null;
    if (candidate.resumeUrl !== undefined && v.resumeUrl.trim() !== (candidate.resumeUrl ?? "")) body.resumeUrl = v.resumeUrl.trim() || null;
    if (candidate.eligibility !== undefined && !sameList(v.eligibility, initialEligibility)) body.eligibility = v.eligibility;
    if (candidate.visaCategory !== undefined && v.visaCategory !== (candidate.visaCategory ?? "")) body.visaCategory = v.visaCategory || null;
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
        <Field label="Marketing email" hint={keepHint(candidate.marketingEmail != null)} error={errors.marketingEmail}>
          {(p) => <input {...p} type="email" value={v.marketingEmail} onChange={(e) => setV((s) => ({ ...s, marketingEmail: e.target.value }))} />}
        </Field>
        <Field label="VITEL number" hint={keepHint(candidate.vitelNumber != null)} error={errors.vitelNumber}>
          {(p) => <input {...p} value={v.vitelNumber} onChange={(e) => setV((s) => ({ ...s, vitelNumber: e.target.value }))} />}
        </Field>
        <Field label="In-person interviews" error={errors.inPersonOk}>
          {(p) => (
            <select {...p} value={v.inPersonOk} onChange={(e) => setV((s) => ({ ...s, inPersonOk: e.target.value as typeof v.inPersonOk }))}>
              {initial.inPersonOk === "" && <option value="">Keep as is</option>}<option value="yes">Open to in-person</option><option value="no">Remote only</option>
            </select>
          )}
        </Field>
        {candidate.batch !== undefined && (
          <Field label="Batch" hint={`Batches at ${candidate.location.name} that are planned or in training.`} error={errors.batchId}>
            {(p) => (
              <select {...p} value={v.batchId} onChange={(e) => setV((s) => ({ ...s, batchId: e.target.value }))}>
                <option value="">No batch</option>
                {v.batchId && !openBatches.some((b) => b.id === v.batchId) && <option value={v.batchId}>{candidate.batch?.label ?? "Current batch"}</option>}
                {openBatches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            )}
          </Field>
        )}
        {candidate.stay !== undefined && (
          <Field label="Stay" hint="The guest house the candidate stays at, or Remote." error={errors.ghLocation}>
            {(p) => (
              <select {...p} value={v.stay} onChange={(e) => setV((s) => ({ ...s, stay: e.target.value }))}>
                <option value="">Not recorded</option>
                <option value="remote">Remote</option>
                {v.stay && v.stay !== "remote" && !locations.some((l) => l.id === v.stay) && <option value={v.stay}>{candidate.ghLocation?.name ?? "Current guest house"}</option>}
                {locations.map((l) => <option key={l.id} value={l.id}>Guest house: {l.name}</option>)}
              </select>
            )}
          </Field>
        )}
        {candidate.visaCategory !== undefined && (
          <Field label="Visa (marketed)" error={errors.visaCategory}>
            {(p) => (
              <select {...p} value={v.visaCategory} onChange={(e) => setV((s) => ({ ...s, visaCategory: e.target.value }))}>
                <option value="">Not recorded</option>
                {Object.entries(VISA_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            )}
          </Field>
        )}
        {candidate.eligibility !== undefined && (
          <fieldset className="radios">
            <legend>Eligibility</legend>
            {Object.entries(ELIGIBILITY_OPTIONS).map(([k, l]) => (
              <label key={k}>
                <input type="checkbox" checked={v.eligibility.includes(k)}
                  onChange={(e) => setV((s) => ({
                    ...s,
                    eligibility: e.target.checked
                      ? Object.keys(ELIGIBILITY_OPTIONS).filter((x) => x === k || s.eligibility.includes(x))
                      : s.eligibility.filter((x) => x !== k),
                  }))} />
                {l}
              </label>
            ))}
            {errors.eligibility && <small className="error fielderr" role="alert">{errors.eligibility}</small>}
          </fieldset>
        )}
        {candidate.marketingLocations !== undefined && (
          <Field label="Marketing locations" hint={`Up to ${MARKETING_LOCATIONS_MAX}, separated by semicolons (e.g. Dallas, TX; Austin, TX).`} error={errors.marketingLocations}>
            {(p) => <input {...p} value={v.marketingLocations} onChange={(e) => setV((s) => ({ ...s, marketingLocations: e.target.value }))} />}
          </Field>
        )}
        {candidate.linkedinUrl !== undefined && (
          <Field label="LinkedIn" hint="Leave empty to remove." error={errors.linkedinUrl}>
            {(p) => <input {...p} type="url" placeholder="https://www.linkedin.com/in/…" value={v.linkedinUrl} onChange={(e) => setV((s) => ({ ...s, linkedinUrl: e.target.value }))} />}
          </Field>
        )}
        {candidate.resumeUrl !== undefined && (
          <Field label="Resume link" hint="A shared link to the marketing resume. Leave empty to remove." error={errors.resumeUrl}>
            {(p) => <input {...p} type="url" placeholder="https://…" value={v.resumeUrl} onChange={(e) => setV((s) => ({ ...s, resumeUrl: e.target.value }))} />}
          </Field>
        )}
        <DialogActions onCancel={onClose} submitLabel="Save changes" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
