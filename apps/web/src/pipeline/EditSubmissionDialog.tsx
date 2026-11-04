import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jobsApi } from "../jobs/jobsApi";
import { Dialog, DialogActions } from "../ui/Dialog";
import { LookupPicker } from "../lookups";
import { fieldErrors } from "../sales/errors";
import { Field, useFocusAfterFailure } from "../sales/ui";
import { pipelineError } from "./errors";
import { pipelineApi, type EditSubmission, type Submission } from "./pipelineApi";

const FIELDS = ["jobTitle", "clientId", "vendorId", "rate", "jobId", "submittedAt"] as const;
/** Placement statuses that no longer hold the submission's details (docs/submissions-api.md). */
const RELEASED = new Set(["backout", "bgc_failed"]);

/** A `datetime-local` value (local wall time, minutes) for an ISO instant. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Whether the submission is frozen by a placement in progress (edit the placement instead). */
export const submissionPlaced = (s: Pick<Submission, "placementStatus">) =>
  Boolean(s.placementStatus && !RELEASED.has(s.placementStatus));

/**
 * Correct a submission's details (PATCH /api/v1/submissions/:id; lead and above).
 * Kept apart from the status workflow in the drawer: this fixes what was logged,
 * Next steps moves it forward. Only changed fields are sent.
 */
export function EditSubmissionDialog({ submission: s, canEditRate, onClose, onSaved }: {
  submission: Submission; canEditRate: boolean; onClose: () => void; onSaved: (changed: string[]) => void;
}) {
  const initial = {
    jobTitle: s.jobTitle, clientId: s.clientId, vendorId: s.vendorId ?? "", jobId: s.jobId ?? "",
    rate: s.rate === null || s.rate === undefined ? "" : String(s.rate),
    submittedAt: toLocalInput(s.submittedAt),
  };
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  // An interview carries the client it was booked with, so the client is fixed once one exists.
  const clientLocked = (s.interviews?.length ?? 0) > 0;
  const placed = submissionPlaced(s);
  const jobs = useQuery({
    queryKey: ["jobs", "list", { kind: "client_requirement", status: "open", picker: true }],
    queryFn: () => jobsApi.list({ kind: "client_requirement", status: "open", limit: 200 }),
    staleTime: 60_000, retry: false, enabled: !placed,
  });
  const openJobs = jobs.data?.items ?? [];
  // Once the client is locked, only that client's jobs fit.
  const jobChoices = openJobs.filter((j) => clientLocked ? j.client?.id === s.clientId : true);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const pickJob = (id: string) => {
    const j = openJobs.find((x) => x.id === id);
    setV((x) => ({ ...x, jobId: id, ...(j && !clientLocked ? { clientId: j.client?.id ?? x.clientId } : {}) }));
  };
  const pickClient = (id: string) => setV((x) => ({
    ...x, clientId: id,
    // A job belongs to one client: picking another client drops it.
    ...(x.jobId && id !== initial.clientId && openJobs.find((j) => j.id === x.jobId)?.client?.id !== id ? { jobId: "" } : {}),
  }));

  if (placed) {
    return (
      <Dialog title="Edit submission details" onClose={onClose}>
        <p className="dialogbody">
          {s.candidateName ?? "This candidate"} has a placement in progress from this submission. The placement now holds the
          client, vendor and rate, so correct them on the placement in Placements.
        </p>
        <div className="actions"><button type="button" className="btn primary" onClick={onClose} data-autofocus>Close</button></div>
      </Dialog>
    );
  }

  const changes = (): EditSubmission => {
    const b: EditSubmission = {};
    if (v.jobTitle.trim() !== initial.jobTitle) b.jobTitle = v.jobTitle.trim();
    if (v.clientId !== initial.clientId) b.clientId = v.clientId;
    if (v.vendorId !== initial.vendorId) b.vendorId = v.vendorId || null;
    if (v.jobId !== initial.jobId) b.jobId = v.jobId || null;
    if (canEditRate && v.rate.trim() !== initial.rate) b.rate = v.rate.trim() ? Number(v.rate) : null;
    if (v.submittedAt !== initial.submittedAt) b.submittedAt = new Date(v.submittedAt).toISOString();
    return b;
  };

  const validate = () => {
    const e: Record<string, string> = {};
    const t = v.jobTitle.trim();
    if (!t) e.jobTitle = "Enter the job title.";
    else if (t.length > 160) e.jobTitle = "Keep the job title under 160 characters.";
    if (!v.clientId) e.clientId = "Choose a client.";
    if (canEditRate && v.rate.trim()) {
      const r = Number(v.rate);
      if (!Number.isFinite(r) || r <= 0 || r > 1000) e.rate = "Enter an hourly rate between 0 and 1000.";
    }
    const at = Date.parse(v.submittedAt);
    if (!v.submittedAt || Number.isNaN(at)) e.submittedAt = "Enter when it was submitted.";
    else if (at > Date.now() + 5 * 60_000) e.submittedAt = "The submitted time can't be in the future.";
    return e;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { failed(); return; }
    const body = changes();
    if (Object.keys(body).length === 0) { setFormError("Nothing has changed yet. Edit a field, or cancel."); failed(); return; }
    setBusy(true);
    try {
      const r = await pipelineApi.editSubmission(s.id, body);
      onSaved(r.changed);
    } catch (err) {
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      setErrors(perField);
      setFormError(_form ?? pipelineError(err, "submission"));
      failed();
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Edit submission details" onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <p className="dialogbody">
          Correct what was logged for {s.candidateName ?? "the candidate"}. The submission shows it was edited and by whom.
          To move it forward, use Next steps instead.
        </p>
        {(jobChoices.length > 0 || v.jobId) && (
          <Field label="Job (optional)" error={errors.jobId}>
            {(p) => (
              <select {...p} value={v.jobId} onChange={(e) => pickJob(e.target.value)}>
                <option value="">No job</option>
                {/* The current job may be closed by now; keep it selectable so it isn't dropped silently. */}
                {v.jobId && !jobChoices.some((j) => j.id === v.jobId) && <option value={v.jobId}>Current job</option>}
                {jobChoices.map((j) => <option key={j.id} value={j.id}>{j.title}{j.client?.name ? ` · ${j.client.name}` : ""}</option>)}
              </select>
            )}
          </Field>
        )}
        <Field label="Job title" error={errors.jobTitle}>
          {(p) => <input {...p} value={v.jobTitle} onChange={set("jobTitle")} maxLength={200} data-autofocus />}
        </Field>
        {clientLocked ? (
          <Field label="Client" hint="Locked: interviews were booked with this client. Log a new submission for a different client.">
            {(p) => <input {...p} value={s.client} readOnly aria-readonly="true" />}
          </Field>
        ) : (
          <LookupPicker kind="clients" label="Client" value={v.clientId} onChange={pickClient} error={errors.clientId}
            fallback={[{ id: s.clientId, name: s.client }]} />
        )}
        <LookupPicker kind="vendors" label="Vendor" value={v.vendorId} onChange={(id) => setV((x) => ({ ...x, vendorId: id }))}
          error={errors.vendorId} optional />
        {canEditRate && (
          <Field label="Rate per hour" error={errors.rate} hint="Leave empty to clear the rate.">
            {(p) => <input {...p} type="number" inputMode="decimal" min="0" max="1000" step="0.01" value={v.rate} onChange={set("rate")} />}
          </Field>
        )}
        <Field label="Submitted" error={errors.submittedAt} hint="Your local time.">
          {(p) => <input {...p} type="datetime-local" value={v.submittedAt} onChange={set("submittedAt")} />}
        </Field>
        <DialogActions onCancel={onClose} submitLabel="Save changes" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
