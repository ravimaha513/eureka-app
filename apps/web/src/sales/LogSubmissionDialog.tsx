import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jobsApi } from "../jobs/jobsApi";
import { ApiError } from "../api";
import { Dialog, DialogActions } from "../admin/Dialog";
import { LookupPicker } from "../lookups";
import { UUID_RE, fieldErrors, salesError } from "./errors";
import { salesApi, type CreateSubmission } from "./salesApi";
import { Field, useFocusAfterFailure } from "./ui";

const FIELDS = ["jobTitle", "clientId", "vendorId", "rate", "jobId"] as const;

export const DUPLICATE_WARNING =
  "Possible duplicate: this candidate was already submitted to this client in the last 90 days. Check with your lead before submitting again.";

/**
 * Log a submission for a candidate (POST /api/v1/submissions). The server
 * records it and answers `duplicateWarning: true` when the same candidate went
 * to the same client within 90 days; that warning is shown before closing.
 */
export function LogSubmissionDialog({ candidate, onClose, onLogged }: {
  candidate: { id: string; name: string }; onClose: () => void; onLogged: (r: { id: string; duplicateWarning: boolean }) => void;
}) {
  const [v, setV] = useState({ jobTitle: "", clientId: "", vendorId: "", rate: "", jobId: "" });
  // jobs-portal: open client requirements the user can read (job:read); no picker without them.
  const jobs = useQuery({
    queryKey: ["jobs", "list", { kind: "client_requirement", status: "open", picker: true }],
    queryFn: () => jobsApi.list({ kind: "client_requirement", status: "open", limit: 200 }),
    staleTime: 60_000, retry: false,
  });
  const openJobs = jobs.data?.items ?? [];
  const pickJob = (id: string) => {
    const j = openJobs.find((x) => x.id === id);
    setV((s) => ({ ...s, jobId: id, ...(j ? { jobTitle: j.title, clientId: j.client?.id ?? s.clientId } : {}) }));
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const [done, setDone] = useState<{ id: string; duplicateWarning: boolean } | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  // Changing the client away from the chosen job's client drops the job.
  const pick = (k: "clientId" | "vendorId") => (id: string) => setV((s) => ({
    ...s, [k]: id, ...(k === "clientId" && s.jobId && openJobs.find((j) => j.id === s.jobId)?.client?.id !== id ? { jobId: "" } : {}),
  }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.jobTitle.trim()) e.jobTitle = "Enter the job title.";
    else if (v.jobTitle.trim().length > 160) e.jobTitle = "Keep the job title under 160 characters.";
    if (!UUID_RE.test(v.clientId.trim())) e.clientId = "Choose a client.";
    if (v.vendorId.trim() && !UUID_RE.test(v.vendorId.trim())) e.vendorId = "Choose a vendor or leave it empty.";
    if (v.rate.trim()) {
      const r = Number(v.rate);
      if (!Number.isFinite(r) || r <= 0 || r > 1000) e.rate = "Enter an hourly rate between 0 and 1000.";
    }
    return e;
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError(""); setConflict(false);
    if (Object.keys(e).length) { failed(); return; }
    const body: CreateSubmission = {
      candidateId: candidate.id, jobTitle: v.jobTitle.trim(), clientId: v.clientId.trim(),
      ...(v.vendorId.trim() ? { vendorId: v.vendorId.trim() } : {}),
      ...(v.rate.trim() ? { rate: Number(v.rate) } : {}),
      ...(v.jobId ? { jobId: v.jobId } : {}),
    };
    setBusy(true);
    try {
      const r = await salesApi.submit(body);
      onLogged(r);
      if (r.duplicateWarning) setDone(r); else onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      const { _form, ...perField } = fieldErrors(err, FIELDS);
      setErrors(perField);
      setFormError(_form ?? salesError(err, "submission"));
      failed();
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      // Keyed so the dialog remounts: focus moves to "Done" and still returns to the opener afterwards.
      <Dialog key="done" title="Submission logged" onClose={onClose}>
        <p className="note warn" role="alert">{DUPLICATE_WARNING}</p>
        <div className="actions"><button type="button" className="btn primary" onClick={onClose} data-autofocus>Done</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog key="form" title={`Log submission for ${candidate.name}`} onClose={onClose}>
      <form ref={formRef} onSubmit={submit} noValidate>
        {openJobs.length > 0 && (
          <Field label="Job (optional)" error={errors.jobId} hint="Pick the client requirement this submission answers; it fills in the title and client.">
            {(p) => (
              <select {...p} value={v.jobId} onChange={(e) => pickJob(e.target.value)} data-autofocus>
                <option value="">No job</option>
                {openJobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.client?.name ? ` · ${j.client.name}` : ""}</option>)}
              </select>
            )}
          </Field>
        )}
        <Field label="Job title" error={errors.jobTitle}>
          {(p) => <input {...p} value={v.jobTitle} onChange={set("jobTitle")} maxLength={200} {...(openJobs.length ? {} : { "data-autofocus": true })} />}
        </Field>
        <LookupPicker kind="clients" label="Client" value={v.clientId} onChange={pick("clientId")} error={errors.clientId} />
        <LookupPicker kind="vendors" label="Vendor (optional)" optional placeholder="No vendor" value={v.vendorId} onChange={pick("vendorId")} error={errors.vendorId} />
        <Field label="Rate per hour (optional)" error={errors.rate}>
          {(p) => <input {...p} type="number" inputMode="decimal" min="0" max="1000" step="0.01" value={v.rate} onChange={set("rate")} />}
        </Field>
        {conflict && <p className="note warn">{DUPLICATE_WARNING}</p>}
        <DialogActions onCancel={onClose} submitLabel="Log submission" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
