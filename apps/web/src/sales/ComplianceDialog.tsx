import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DOCUMENTS_STATUSES } from "@eureka/shared";
import { Dialog, DialogActions } from "../ui/Dialog";
import { ApiError } from "../api";
import { fieldErrors, salesError } from "./errors";
import { salesApi, type CandidateProfile, type ComplianceUpdate } from "./salesApi";
import { Field } from "./ui";

const FIELDS = ["everifyCompanyId", "offerLetterCompanyId", "form1099CompanyId", "documentsStatus"] as const;
const LINKS = [
  ["everifyCompanyId", "everify", "E-Verify company"],
  ["offerLetterCompanyId", "offerLetter", "Offer letter company"],
  ["form1099CompanyId", "form1099", "1099 company"],
] as const;

/**
 * E-Verify, offer letter and 1099 companies and the documents status
 * (PUT /candidates/:id/compliance; HR, Accounts, Immigration, Documents team).
 * Only changed fields are sent; the server re-checks scope and that a newly
 * linked company is active.
 */
export function ComplianceDialog({ candidate, onClose, onSaved }: {
  candidate: CandidateProfile; onClose: () => void; onSaved: () => void;
}) {
  const companies = useQuery({ queryKey: ["candidate-companies"], queryFn: salesApi.complianceCompanies, staleTime: 60_000 });
  const current = {
    everifyCompanyId: candidate.companies?.everify?.id ?? "",
    offerLetterCompanyId: candidate.companies?.offerLetter?.id ?? "",
    form1099CompanyId: candidate.companies?.form1099?.id ?? "",
    documentsStatus: candidate.documentsStatus ?? "",
  };
  const [v, setV] = useState(current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const options = companies.data?.items ?? [];

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const body: ComplianceUpdate = {};
    for (const k of FIELDS) if (v[k] !== current[k]) body[k] = v[k] || null;
    if (Object.keys(body).length === 0) { setFormError("Nothing changed."); return; }
    setBusy(true); setErrors({}); setFormError("");
    try {
      await salesApi.setCompliance(candidate.id, body);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.detail === "invalid_company") {
        setFormError("A chosen company is no longer active. Choose another one.");
      } else {
        const { _form, ...perField } = fieldErrors(err, FIELDS);
        setErrors(perField);
        setFormError(_form ?? salesError(err, "profile"));
      }
    } finally { setBusy(false); }
  };

  return (
    <Dialog title={`Companies and documents: ${candidate.name}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {LINKS.map(([key, link, label], i) => (
          <Field key={key} label={label} error={errors[key]}>
            {(p) => (
              <select {...p} value={v[key]} onChange={(e) => setV((s) => ({ ...s, [key]: e.target.value }))} {...(i === 0 ? { "data-autofocus": true } : {})}>
                <option value="">None</option>
                {v[key] && !options.some((o) => o.id === v[key]) && <option value={v[key]}>{candidate.companies?.[link]?.name ?? "Current company"}</option>}
                {options.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.location})</option>)}
              </select>
            )}
          </Field>
        ))}
        <Field label="Documents status" error={errors.documentsStatus}>
          {(p) => (
            <select {...p} value={v.documentsStatus} onChange={(e) => setV((s) => ({ ...s, documentsStatus: e.target.value }))}>
              <option value="">Not recorded</option>
              {Object.entries(DOCUMENTS_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
        </Field>
        {companies.error && <p className="note warn" role="alert">{salesError(companies.error)}</p>}
        <DialogActions onCancel={onClose} submitLabel="Save" busy={busy} error={formError} />
      </form>
    </Dialog>
  );
}
