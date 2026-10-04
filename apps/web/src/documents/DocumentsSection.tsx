import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DOCUMENT_CONTENT_TYPES, DOCUMENT_TYPES, type DocumentType } from "@eureka/shared";
import { ApiError } from "../api";
import { Dialog } from "../admin/Dialog";
import { browser, fmtBytes, postToStorage, resumeStatusText } from "../sales/resumesApi";
import {
  documentFileProblem, documentKeys, documentTypeOf, documentsApi, isStepUpRequired, uploadableTypes,
  type DocumentItem, type DocumentOwner,
} from "./documentsApi";
import { StepUpDialog } from "./StepUpDialog";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const ACCEPT = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ...Object.keys(DOCUMENT_CONTENT_TYPES)].join(",");
export const DOCUMENT_POLL_MS = 3000;

function documentError(e: unknown, action: "upload" | "download" | "load"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "upload_failed") return "The file could not be sent to storage. Try again; the link is valid for 2 minutes.";
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return action === "upload" ? "You can't upload this type of document for this candidate." : "You can't open this document.";
    case 404: return "This document isn't available from your account.";
    case 409: return e.detail === "too_many_pending"
      ? "Five uploads are already being scanned for this candidate. Wait for them to finish."
      : "This document isn't available (it is still being scanned or did not pass).";
    case 422: return "The server refused this file. Choose a PDF, Word (.docx), PNG or JPEG file up to 15 MB.";
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? "Something went wrong.";
  }
}

/** Who opened a restricted document and when (HR, Accounts, Immigration; org admins see the full log in the API). */
function AccessLogDialog({ doc, onClose }: { doc: DocumentItem; onClose: () => void }) {
  const q = useQuery({ queryKey: documentKeys.accessLog(doc.id), queryFn: () => documentsApi.accessLog(doc.id) });
  return (
    <Dialog title={`Access log: ${doc.docTypeLabel}`} onClose={onClose}>
      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error" role="alert">{documentError(q.error, "load")}</p>
        : !q.data?.items.length ? <p className="muted">Nobody has opened this document yet.</p>
        : (
          <div className="tablewrap"><table className="mini" aria-label="Access log, newest first">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Confirmed</th></tr></thead>
            <tbody>
              {q.data.items.map((a) => (
                <tr key={a.id}>
                  <td><time dateTime={a.at}>{fmt(a.at)}</time></td>
                  <td>{a.user.name ?? a.user.id}</td>
                  <td>{a.steppedUp ? "Signed in again" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      <div className="actions"><button type="button" className="btn" onClick={onClose} data-autofocus>Close</button></div>
    </Dialog>
  );
}

/**
 * Paperwork and compliance documents of a candidate or placement (FR-PPR-01
 * to 03). Uploads go straight to storage through a short-lived signed form and
 * are usable after the malware scan. Restricted documents (I-9, driving
 * license, work authorization) are listed only for HR, Accounts and
 * Immigration and open after "Confirm it's you" (step-up); each opening is in
 * the access log. Shown to document:read holders; 403/404 hides the section.
 */
export function DocumentsSection({ owner, title = "Documents", pollMs = DOCUMENT_POLL_MS }: {
  owner: DocumentOwner; title?: string; pollMs?: number;
}) {
  const qc = useQueryClient();
  const hid = useId();
  const inputId = useId();
  const typeId = useId();
  const hintId = useId();
  const errId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<DocumentType | "">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [stepUpFor, setStepUpFor] = useState<DocumentItem | null>(null);
  const [logFor, setLogFor] = useState<DocumentItem | null>(null);
  const watching = useRef(new Set<string>());

  const q = useQuery({
    queryKey: documentKeys.list(owner),
    queryFn: () => documentsApi.list(owner),
    refetchInterval: (query) => (query.state.data?.items.some((d) => d.status === "pending") ? pollMs : false),
  });

  useEffect(() => {
    for (const d of q.data?.items ?? []) {
      if (!watching.current.has(d.id) || d.status === "pending") continue;
      watching.current.delete(d.id);
      setMessage(d.status === "clean" ? `${d.docTypeLabel} is ready.` : `Upload not accepted. ${resumeStatusText(d)}.`);
    }
  }, [q.data]);

  // Back from Google: say so if the step-up did not go through.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("stepUp") === "failed") {
      setError("Could not confirm it's you, so restricted documents stay closed. Try again.");
    }
  }, []);

  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;

  const items = q.data?.items ?? [];
  const types = q.data ? uploadableTypes(q.data) : [];

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(""); setError("");
    const problem = !docType ? "Choose the document type." : file ? documentFileProblem(file) : "Choose a file to upload.";
    if (problem || !file || !docType) { setError(problem ?? ""); (docType ? inputRef.current : document.getElementById(typeId))?.focus(); return; }
    setBusy("upload");
    try {
      const r = await documentsApi.requestUpload(owner, docType, documentTypeOf(file)!, file.size);
      setMessage("Uploading…");
      await postToStorage(r.upload, file);
      watching.current.add(r.id);
      setMessage("Uploaded. Scanning for malware; the document is available once the scan passes.");
      setFile(null); setDocType("");
      if (inputRef.current) inputRef.current.value = "";
      await qc.invalidateQueries({ queryKey: documentKeys.list(owner) });
    } catch (err) {
      setMessage("");
      setError(documentError(err, "upload"));
      inputRef.current?.focus();
    } finally {
      setBusy(null);
    }
  };

  const download = async (d: DocumentItem) => {
    setMessage(""); setError(""); setBusy(d.id);
    try {
      const { url } = await documentsApi.downloadLink(d.id);
      browser.download(url);
      setMessage(`Opening ${d.docTypeLabel}.`);
      if (d.classification === "restricted") void qc.invalidateQueries({ queryKey: documentKeys.accessLog(d.id) });
    } catch (err) {
      if (isStepUpRequired(err)) setStepUpFor(d);
      else setError(documentError(err, "download"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card pad" aria-labelledby={hid}>
      <h2 id={hid}>{title}</h2>
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {error && <p id={errId} className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}

      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error">{documentError(q.error, "load")}</p>
        : items.length === 0 ? <p className="muted">No documents yet.</p>
        : (
          <div className="tablewrap"><table aria-label={`${title}, newest first`}>
            <thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.docTypeLabel}
                    {d.classification === "restricted" && <> <span className="badge restricted">Restricted</span></>}
                    {owner.kind === "candidate" && d.placementId && <span className="muted"> · placement</span>}
                  </td>
                  <td><span className={`badge resume-${d.status}`}>{resumeStatusText(d)}</span></td>
                  <td><time dateTime={d.createdAt}>{fmt(d.createdAt)}</time>{d.uploadedBy.name ? ` · ${d.uploadedBy.name}` : ""}</td>
                  <td>{fmtBytes(d.sizeBytes)}</td>
                  <td className="rowactions">
                    {d.status === "clean" && (
                      <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === d.id || undefined} onClick={() => void download(d)}>
                        Open<span className="sr-only"> {d.docTypeLabel}</span>
                      </button>
                    )}
                    {d.classification === "restricted" && (
                      <button type="button" className="btn sm" onClick={() => setLogFor(d)}>
                        Access log<span className="sr-only"> for {d.docTypeLabel}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

      {q.data?.canUpload && (
        <form className="manageblock" onSubmit={(e) => void upload(e)} noValidate>
          <h3>Upload a document</h3>
          <div className="field">
            <label>Document type
              <select id={typeId} value={docType} onChange={(e) => { setDocType(e.target.value as DocumentType | ""); setError(""); }}>
                <option value="">Choose…</option>
                {types.map((t) => (
                  <option key={t} value={t}>{DOCUMENT_TYPES[t].label}{DOCUMENT_TYPES[t].classification === "restricted" ? " (restricted)" : ""}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="field">
            <label htmlFor={inputId}>Document file</label>
            <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`}
              aria-invalid={error ? true : undefined}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
            <small id={hintId} className="hint">PDF, Word (.docx), PNG or JPEG, up to 15 MB. Files are scanned for malware before anyone can open them.</small>
          </div>
          <button type="submit" className="btn primary" disabled={busy !== null} aria-busy={busy === "upload" || undefined}>Upload document</button>
        </form>
      )}

      {stepUpFor && (
        <StepUpDialog onClose={() => setStepUpFor(null)}
          onConfirmed={() => { const d = stepUpFor; setStepUpFor(null); void qc.invalidateQueries({ queryKey: documentKeys.stepUp }); void download(d); }} />
      )}
      {logFor && <AccessLogDialog doc={logFor} onClose={() => setLogFor(null)} />}
    </section>
  );
}
