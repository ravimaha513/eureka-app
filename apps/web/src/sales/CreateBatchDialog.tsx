import { useState } from "react";
import { ApiError } from "../api";
import { Dialog, DialogActions } from "../admin/Dialog";
import { LookupPicker } from "../lookups";
import { UUID_RE, fieldErrors, salesError } from "./errors";
import { salesApi, type CreateBatch } from "./salesApi";
import { Field } from "./ui";

const FIELDS = ["locationId", "technologyId", "startMonth", "sizePlanned"] as const;

/**
 * New training batch (POST /api/v1/batches, FR-CAN-02). Offered to Sales
 * leadership (the list's `canCreate` hint); the server decides.
 */
export function CreateBatchDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [v, setV] = useState({ locationId: "", technologyId: "", startMonth: "", sizePlanned: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!UUID_RE.test(v.locationId)) e.locationId = "Choose a location.";
    if (!UUID_RE.test(v.technologyId)) e.technologyId = "Choose a technology.";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v.startMonth)) e.startMonth = "Choose the month training starts.";
    const size = v.sizePlanned.trim() ? Number(v.sizePlanned) : undefined;
    if (size !== undefined && !(Number.isInteger(size) && size >= 1 && size <= 500)) e.sizePlanned = "Use a whole number from 1 to 500.";
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { ev.currentTarget.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(); return; }

    const body: CreateBatch = { locationId: v.locationId, technologyId: v.technologyId, startMonth: v.startMonth, ...(size ? { sizePlanned: size } : {}) };
    setBusy(true);
    try {
      onCreated((await salesApi.createBatch(body)).id);
    } catch (err) {
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      setErrors(perField);
      setFormError(_form ?? (err instanceof ApiError && err.status === 409
        ? "A batch for this location, technology and month already exists."
        : err instanceof ApiError && err.status === 403
          ? (err.detail === "location_not_in_scope"
            ? "You can plan batches only for locations where your teams work."
            : "Only leads and managers can plan batches.")
          : salesError(err)));
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="New batch" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <LookupPicker kind="locations" label="Location" value={v.locationId} error={errors.locationId} autoFocus
          onChange={(id) => setV((s) => ({ ...s, locationId: id }))} />
        <LookupPicker kind="technologies" label="Technology" value={v.technologyId} error={errors.technologyId}
          onChange={(id) => setV((s) => ({ ...s, technologyId: id }))} />
        <Field label="Start month" hint="The month training starts." error={errors.startMonth}>
          {(p) => <input {...p} type="month" value={v.startMonth} onChange={(e) => setV((s) => ({ ...s, startMonth: e.target.value }))} />}
        </Field>
        <Field label="Planned size (optional)" error={errors.sizePlanned}>
          {(p) => <input {...p} type="number" min={1} max={500} inputMode="numeric" value={v.sizePlanned}
            onChange={(e) => setV((s) => ({ ...s, sizePlanned: e.target.value }))} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Create batch" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
