import { useEffect, useRef, useState } from "react";
import { ApiError, can, type Me } from "../api";
import { LookupPicker, useLookups } from "../lookups";
import { fieldErrors } from "../sales/errors";
import { Field, useFocusAfterFailure } from "../sales/ui";
import { Dialog, DialogActions } from "../ui/Dialog";
import { BulkCandidatesDialog } from "./BulkCandidatesDialog";
import { trainingApi, trainingError } from "./trainingApi";

const FIELDS = ["name", "locationId", "technologyId", "startDate"] as const;

/**
 * The new batch workflow: name, location, technology and month (POST
 * /api/v1/training/batches, TR-1a), then for candidate:create holders an optional
 * bulk add of new candidates from the Excel template. The trainer, end date and
 * cover are set by editing the batch afterwards.
 */
export function NewBatchDialog({ me, onClose, onDone }: {
  me?: (Pick<Me, "capabilities"> & Partial<Pick<Me, "roles">>) | null; onClose: () => void; onDone: (id: string, name: string, candidates: number) => void;
}) {
  const lookups = useLookups();
  // training.batch:create is org-wide (TR-1a): a new batch may go to any location.
  const myLocations = new Set(can(me, "training.batch:create") ? [] : (me?.roles ?? []).map((r) => r.locationId).filter(Boolean));
  const locations = (lookups.data?.locations ?? []).filter((l) => myLocations.size === 0 || myLocations.has(l.id));
  const [v, setV] = useState({ name: "", locationId: "", technologyId: "", month: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  useEffect(() => {
    if (!v.locationId && locations.length === 1) setV((s) => ({ ...s, locationId: locations[0]!.id }));
  }, [locations, v.locationId]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const name = v.name.trim();
    const e: Record<string, string> = {};
    if (!name) e.name = "Enter a batch name.";
    else if (name.length > 80) e.name = "Use at most 80 characters.";
    if (!v.locationId) e.locationId = "Choose a location.";
    if (!v.technologyId) e.technologyId = "Choose a technology.";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.month)) e.month = "Choose the month training starts.";
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { failed(); return; }
    setBusy(true);
    try {
      const { id } = await trainingApi.createBatch({ name, locationId: v.locationId, technologyId: v.technologyId, startDate: `${v.month}-01` });
      if (can(me, "candidate:create")) setCreated({ id, name });
      else onDone(id, name, 0);
    } catch (err) {
      const { _form, startDate, ...perField } = fieldErrors(err, FIELDS);
      setErrors({ ...perField, ...(startDate ? { month: startDate } : {}) });
      setFormError(_form ?? (err instanceof ApiError && err.detail === "location_not_in_scope"
        ? "You can create batches only at locations you cover."
        : trainingError(err)));
      failed();
    } finally { setBusy(false); }
  };

  if (created) {
    return (
      <BulkCandidatesDialog batch={created} cancelLabel="Skip for now"
        onClose={() => onDone(created.id, created.name, 0)} onDone={(n) => onDone(created.id, created.name, n)} />
    );
  }
  return (
    <Dialog title="New batch" onClose={onClose}>
      <form ref={form} onSubmit={submit} noValidate>
        <Field label="Batch name" error={errors.name}>
          {(p) => <input {...p} data-autofocus value={v.name} maxLength={80} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}
        </Field>
        <Field label="Location" error={errors.locationId}>
          {(p) => (
            <select {...p} value={v.locationId} onChange={(e) => setV((s) => ({ ...s, locationId: e.target.value }))}>
              <option value="" disabled>Choose…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
        </Field>
        <LookupPicker kind="technologies" label="Technology" value={v.technologyId} error={errors.technologyId} canAdd={can(me, "technology:create")}
          onChange={(id) => setV((s) => ({ ...s, technologyId: id }))} />
        <Field label="Month" hint="The month training starts." error={errors.month}>
          {(p) => <input {...p} type="month" value={v.month} onChange={(e) => setV((s) => ({ ...s, month: e.target.value }))} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Create batch" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
