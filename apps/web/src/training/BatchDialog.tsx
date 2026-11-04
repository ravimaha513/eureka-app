import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogActions } from "../ui/Dialog";
import { Field, useFocusAfterFailure } from "../sales/ui";
import { fieldErrors } from "../sales/errors";
import { trainingApi, trainingError, type BatchCard, type BatchPatch, type Cover } from "./trainingApi";
import { CoverPicker } from "./ui";

const FIELDS = ["name", "startDate", "endDate", "trainerId", "sizePlanned"] as const;

/** Edit a training batch; NewBatchDialog creates them. */
export function BatchDialog({ batch, onClose, onSaved }: {
  batch: BatchCard; onClose: () => void; onSaved: (id: string) => void;
}) {
  const trainers = useQuery({ queryKey: ["training", "trainers"], queryFn: trainingApi.trainers, staleTime: 5 * 60_000 });
  const [v, setV] = useState({
    name: batch.customName ?? "", startDate: batch.startDate ?? "", endDate: batch.endDate ?? "",
    trainerId: batch.trainer?.id ?? "", sizePlanned: batch.sizePlanned ? String(batch.sizePlanned) : "",
  });
  const [cover, setCover] = useState<Cover>(batch.cover);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(form);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!v.startDate) e.startDate = "Choose the first day of training.";
    if (v.endDate && v.startDate && v.endDate < v.startDate) e.endDate = "The end date must not be before the start date.";
    const size = v.sizePlanned.trim() ? Number(v.sizePlanned) : null;
    if (size !== null && !(Number.isInteger(size) && size >= 1 && size <= 500)) e.sizePlanned = "Use a whole number from 1 to 500.";
    if (v.name.trim().length > 80) e.name = "Use at most 80 characters.";
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { failed(); return; }
    setBusy(true);
    try {
      const patch: BatchPatch = {
        name: v.name.trim() || null, startDate: v.startDate, endDate: v.endDate || null, trainerId: v.trainerId || null,
        sizePlanned: size, coverColor: cover.color, coverIcon: cover.icon,
      };
      await trainingApi.updateBatch(batch.id, batch.rowVersion, patch);
      onSaved(batch.id);
    } catch (err) {
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      setErrors(perField);
      setFormError(_form ?? trainingError(err));
      failed();
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Edit ${batch.name}`} onClose={onClose}>
      <form ref={form} onSubmit={submit} noValidate>
        <Field label="Batch name (optional)" error={errors.name} hint="Leave empty to use the technology and start month, e.g. “Java Sep 2026”.">
          {(p) => <input {...p} data-autofocus value={v.name} maxLength={80} onChange={set("name")} />}
        </Field>
        <div className="grid2">
          <Field label="Start date" error={errors.startDate}>
            {(p) => <input {...p} type="date" value={v.startDate} onChange={set("startDate")} />}
          </Field>
          <Field label="End date (optional)" error={errors.endDate}>
            {(p) => <input {...p} type="date" value={v.endDate} min={v.startDate || undefined} onChange={set("endDate")} />}
          </Field>
        </div>
        <div className="grid2">
          <Field label="Trainer" error={errors.trainerId}>
            {(p) => (
              <select {...p} value={v.trainerId} onChange={set("trainerId")}>
                <option value="">No trainer yet</option>
                {v.trainerId && !trainers.data?.items.some((t) => t.id === v.trainerId) && <option value={v.trainerId}>{batch.trainer?.name ?? "Current trainer"}</option>}
                {(trainers.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Planned size (optional)" error={errors.sizePlanned}>
            {(p) => <input {...p} type="number" min={1} max={500} inputMode="numeric" value={v.sizePlanned} onChange={set("sizePlanned")} />}
          </Field>
        </div>
        <CoverPicker value={cover} onChange={setCover} />
        <DialogActions onCancel={onClose} submitLabel="Save" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
