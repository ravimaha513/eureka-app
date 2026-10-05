import { useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, JOB_CATEGORIES, JOB_STATUSES, PAY_CURRENCIES, PAY_FREQUENCIES, RICH_LIMITS, WORK_MODES,
  jobLabel, richTextLength, type JobKind, type RichDoc,
} from "@eureka/shared";
import { Dialog, DialogActions } from "../admin/Dialog";
import { Field, useFocusAfterFailure } from "../sales/ui";
import { RichTextEditor } from "./RichText";
import { jobError, jobKeys, jobsApi, type Job, type JobInput } from "./jobsApi";
import "./jobs.css";

const CURRENCY_LABELS: Record<string, string> = { USD: "US dollar", INR: "Indian rupee", EUR: "Euro", GBP: "Pound sterling", CAD: "Canadian dollar", AUD: "Australian dollar" };

function Radios({ legend, name, options, value, onChange }: {
  legend: string; name: string; options: readonly string[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <fieldset className="radios">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o}><input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} />{jobLabel(o)}</label>
      ))}
    </fieldset>
  );
}

/** Skills as removable chips; Enter or comma adds the typed skill. */
function SkillsInput({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const [text, setText] = useState("");
  const id = useId();
  const add = () => {
    const s = text.trim().replace(/,$/, "").trim();
    if (s && s.length <= 40 && value.length < 30 && !value.some((x) => x.toLowerCase() === s.toLowerCase())) onChange([...value, s]);
    setText("");
  };
  return (
    <div className="field">
      <label htmlFor={id}>Skills</label>
      <div className="taginput">
        {value.map((s) => (
          <span key={s} className="chip">{s}
            <button type="button" className="chipx" aria-label={`Remove skill ${s}`} onClick={() => onChange(value.filter((x) => x !== s))}>×</button>
          </span>
        ))}
        <input id={id} value={text} maxLength={41} placeholder={value.length ? "" : "Type a skill and press Enter"}
          aria-describedby={`${id}-h`} aria-invalid={error ? true : undefined}
          onChange={(e) => (e.target.value.endsWith(",") ? (setText(e.target.value), setTimeout(add)) : setText(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); }}
          onBlur={add} />
      </div>
      <small id={`${id}-h`} className="hint fieldhint">Up to 30 skills, 40 characters each.</small>
      {error && <small className="error fielderr">{error}</small>}
    </div>
  );
}

interface FormState {
  kind: JobKind; title: string; category: string; experienceLevel: string; employmentType: string; workMode: string; status: string;
  deadline: string; workHours: string; payAmount: string; payFrequency: string; payCurrency: string; clientId: string; companyId: string;
  location: string; skills: string[]; requirements: RichDoc | null; description: RichDoc | null; hiringManagerId: string; publishedToPortal: boolean;
}

const fromJob = (j: Job): FormState => ({
  kind: j.kind, title: j.title, category: j.category, experienceLevel: j.experienceLevel, employmentType: j.employmentType,
  workMode: j.workMode, status: j.status, deadline: j.deadline ?? "", workHours: j.workHours?.toString() ?? "",
  payAmount: j.pay ? String(j.pay.amount) : "", payFrequency: j.pay?.frequency ?? "hourly", payCurrency: j.pay?.currency ?? "USD",
  clientId: j.client?.id ?? "", companyId: j.company?.id ?? "", location: j.location ?? "", skills: j.skills,
  requirements: j.requirements, description: j.description, hiringManagerId: j.hiringManager?.id ?? "", publishedToPortal: j.publishedToPortal,
});

/** Create or edit a job (POST /api/v1/jobs, PATCH /api/v1/jobs/:id with If-Match). */
export function JobDialog({ job, onClose, onSaved }: { job?: Job; onClose: () => void; onSaved: (id: string, created: boolean) => void }) {
  const opts = useQuery({ queryKey: jobKeys.options, queryFn: jobsApi.options, staleTime: 5 * 60_000 });
  const kinds = opts.data?.kinds ?? [];
  const [v, setV] = useState<FormState>(() => job ? fromJob(job) : {
    kind: "client_requirement", title: "", category: "engineering", experienceLevel: "mid", employmentType: "full_time",
    workMode: "on_site", status: "open", deadline: "", workHours: "", payAmount: "", payFrequency: "hourly", payCurrency: "USD",
    clientId: "", companyId: "", location: "", skills: [], requirements: null, description: null, hiringManagerId: "", publishedToPortal: false,
  });
  const kind: JobKind = job ? job.kind : (kinds.includes(v.kind) ? v.kind : kinds[0] ?? v.kind);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const idemKey = useMemo(() => `job-${crypto.randomUUID()}`, []);
  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => setV((s) => ({ ...s, [k]: val }));
  const text = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => set(k, e.target.value as never);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.title.trim()) e.title = "Enter the job title.";
    else if (v.title.trim().length > 160) e.title = "Keep the title under 160 characters.";
    if (kind === "client_requirement" && !v.clientId) e.clientId = "Choose the client.";
    if (v.workHours && !(Number.isInteger(Number(v.workHours)) && Number(v.workHours) >= 1 && Number(v.workHours) <= 80)) e.workHours = "Enter hours per week between 1 and 80.";
    if (v.payAmount && !(Number(v.payAmount) >= 0 && Number(v.payAmount) < 100_000_000)) e.payAmount = "Enter a pay amount of 0 or more.";
    if (v.location.trim().length > 120) e.location = "Keep the location under 120 characters.";
    for (const k of ["requirements", "description"] as const) {
      const d = v[k];
      if (d && richTextLength(d) > RICH_LIMITS.totalText) e[k] = `Keep it under ${RICH_LIMITS.totalText} characters.`;
    }
    return e;
  };

  const body = (): JobInput => ({
    title: v.title.trim(), category: v.category, experienceLevel: v.experienceLevel, employmentType: v.employmentType,
    workMode: v.workMode, status: v.status, deadline: v.deadline || null, workHours: v.workHours ? Number(v.workHours) : null,
    pay: v.payAmount ? { amount: Number(v.payAmount), frequency: v.payFrequency, currency: v.payCurrency } : null,
    clientId: kind === "client_requirement" ? v.clientId || null : null,
    companyId: kind === "internal_opening" ? v.companyId || null : null,
    location: v.location.trim() || null, skills: v.skills, requirements: v.requirements, description: v.description,
    hiringManagerId: v.hiringManagerId || null, publishedToPortal: kind === "internal_opening" && v.publishedToPortal,
  });

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e); setFormError("");
    if (Object.keys(e).length) { failed(); return; }
    setBusy(true);
    try {
      if (job) { const r = await jobsApi.update(job.id, job.rowVersion, body()); onSaved(r.id, false); }
      else { const r = await jobsApi.create({ kind, ...body() }, idemKey); onSaved(r.id, true); }
    } catch (err) {
      setFormError(jobError(err));
      failed();
    } finally { setBusy(false); }
  };

  const staff = opts.data?.staff ?? [];
  const clients = opts.data?.clients ?? [];
  // Company picker: only for internal openings and only for who may create them (HR); the job's current company
  // stays selectable by name even when it is no longer offered (inactive).
  const companyOpts = useQuery({ queryKey: jobKeys.companyOptions, queryFn: jobsApi.companyOptions, staleTime: 5 * 60_000,
    enabled: kind === "internal_opening" && kinds.includes("internal_opening") });
  const companies = [...(companyOpts.data?.companies ?? [])];
  if (job?.company && !companies.some((c) => c.id === job.company!.id)) companies.unshift({ id: job.company.id, name: job.company.name ?? "Current company" });
  return (
    <Dialog title={job ? `Edit job · ${job.title}` : "Create job"} onClose={onClose} wide>
      <form ref={formRef} onSubmit={submit} noValidate>
        {!job && kinds.length > 1 && (
          <Radios legend="Job type" name="kind" options={kinds} value={kind} onChange={(k) => set("kind", k as JobKind)} />
        )}
        {!job && kinds.length === 1 && <p className="muted">Type: {jobLabel(kind)}</p>}
        {job && <p className="muted">Type: {jobLabel(kind)}</p>}
        <div className="grid2">
          <Field label="Job title" error={errors.title}>
            {(p) => <input {...p} value={v.title} onChange={text("title")} maxLength={200} data-autofocus placeholder="Enter job title" />}
          </Field>
          <Field label="Job category">
            {(p) => <select {...p} value={v.category} onChange={text("category")}>{JOB_CATEGORIES.map((c) => <option key={c} value={c}>{jobLabel(c)}</option>)}</select>}
          </Field>
          <Field label="Experience">
            {(p) => <select {...p} value={v.experienceLevel} onChange={text("experienceLevel")}>{EXPERIENCE_LEVELS.map((c) => <option key={c} value={c}>{jobLabel(c)}</option>)}</select>}
          </Field>
          <Field label="Status">
            {(p) => <select {...p} value={v.status} onChange={text("status")}>{JOB_STATUSES.map((c) => <option key={c} value={c}>{jobLabel(c)}</option>)}</select>}
          </Field>
        </div>
        <div className="grid2">
          <Radios legend="Employment type" name="employmentType" options={EMPLOYMENT_TYPES} value={v.employmentType} onChange={(x) => set("employmentType", x)} />
          <Radios legend="Work mode" name="workMode" options={WORK_MODES} value={v.workMode} onChange={(x) => set("workMode", x)} />
        </div>
        <div className="grid2">
          <Field label="Job deadline (optional)">
            {(p) => <input {...p} type="date" value={v.deadline} onChange={text("deadline")} />}
          </Field>
          <Field label="Work hours per week (optional)" error={errors.workHours}>
            {(p) => <input {...p} type="number" min={1} max={80} step={1} value={v.workHours} onChange={text("workHours")} />}
          </Field>
          <Field label="Pay (optional)" error={errors.payAmount}>
            {(p) => <input {...p} type="number" min={0} step="0.01" inputMode="decimal" value={v.payAmount} onChange={text("payAmount")} />}
          </Field>
          <Field label="Pay frequency">
            {(p) => <select {...p} value={v.payFrequency} onChange={text("payFrequency")}>{PAY_FREQUENCIES.map((c) => <option key={c} value={c}>{jobLabel(c)}</option>)}</select>}
          </Field>
          <Field label="Pay currency">
            {(p) => <select {...p} value={v.payCurrency} onChange={text("payCurrency")}>{PAY_CURRENCIES.map((c) => <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>)}</select>}
          </Field>
          {kind === "client_requirement" ? (
            <Field label="Client" error={errors.clientId}>
              {(p) => (
                <select {...p} value={v.clientId} onChange={text("clientId")} disabled={opts.isPending}>
                  <option value="" disabled>{opts.isPending ? "Loading…" : "Choose…"}</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Field>
          ) : kinds.includes("internal_opening") ? (
            <Field label="Company (optional)">
              {(p) => (
                <select {...p} value={v.companyId} onChange={text("companyId")} disabled={companyOpts.isPending && !job?.company}>
                  <option value="">{companyOpts.isPending && !job?.company ? "Loading…" : "None"}</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Location (optional)" error={errors.location}>
            {(p) => <input {...p} value={v.location} onChange={text("location")} maxLength={130} placeholder="City, State" />}
          </Field>
          <Field label="Hiring manager (optional)">
            {(p) => (
              <select {...p} value={v.hiringManagerId} onChange={text("hiringManagerId")}>
                <option value="">None</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <SkillsInput value={v.skills} onChange={(s) => set("skills", s)} />
        <RichTextEditor label="Requirements" value={v.requirements} onChange={(d) => set("requirements", d)} error={errors.requirements} placeholder="Enter requirements" />
        <RichTextEditor label="Description" value={v.description} onChange={(d) => set("description", d)} error={errors.description} placeholder="Enter description" />
        {kind === "internal_opening" && (
          <label className="check"><input type="checkbox" checked={v.publishedToPortal} onChange={(e) => set("publishedToPortal", e.target.checked)} />
            {" "}Publish on the careers portal (shown to applicants while the job is open)</label>
        )}
        <DialogActions onCancel={onClose} submitLabel={job ? "Save changes" : "Create job"} busy={busy} error={formError}
          disabled={!job && kinds.length === 0} />
      </form>
    </Dialog>
  );
}
