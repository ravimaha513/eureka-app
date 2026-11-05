import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DOCUMENT_CONTENT_TYPES, DOCUMENT_TYPES, type DocumentType } from "@eureka/shared";
import { ApiError } from "../api";
import { Dialog } from "../ui/Dialog";
import { browser, fmtBytes, postToStorage, resumeStatusText } from "../sales/resumesApi";
import {
  documentFileProblem, documentKeys, documentName, documentTypeOf, documentsApi, isStepUpRequired, uploadableTypes,
  type DocumentItem, type DocumentList, type DocumentOwner,
} from "./documentsApi";
import { StepUpDialog } from "../ui/StepUpDialog";
import { DocumentViewer } from "./DocumentViewer";
import { UPLOAD_FAILED_MESSAGE } from "../lib/uploadErrors";
import { fmtDateTime } from "../lib/format";

const ACCEPT = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ...Object.keys(DOCUMENT_CONTENT_TYPES)].join(",");
export const DOCUMENT_POLL_MS = 3000;
type OpenMode = "view" | "download";

function documentError(e: unknown, action: "upload" | "download" | "load" | "edit"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "upload_failed") return UPLOAD_FAILED_MESSAGE;
  if (e.detail === "classification_change") return "That type has a different access level. Upload the file again as that type instead.";
  if (e.detail === "version_mismatch") return "Someone else changed this document in the meantime. Reload and try again.";
  if (action === "edit" && e.status === 422) return "Check the title (up to 120 characters) and the type, then try again.";
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return action === "upload" || action === "edit" ? "You can't change this type of document for this candidate." : "You can't open this document.";
    case 404: return "This document isn't available from your account.";
    case 409: return e.detail === "too_many_pending"
      ? "Five uploads are already being scanned for this candidate. Wait for them to finish."
      : "This document isn't available (it is still being scanned or did not pass).";
    case 422: return "The server refused this file. Choose a PDF, Word (.docx), PNG or JPEG file up to 15 MB.";
    case 429: return e.message;
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
                  <td><time dateTime={a.at}>{fmtDateTime(a.at)}</time></td>
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

/** Editing needs upload rights for the document's classification (the server checks again). */
const canEdit = (list: DocumentList, d: DocumentItem) => list.canUpload && (d.classification === "internal" || list.canUploadRestricted);

/**
 * Inline editor of one document: a display title, another type of the same access level (internal or
 * restricted; changing that needs a new upload) and, optionally, a new file. A new file is scanned like any
 * upload and replaces the current one only once it passes; the document keeps its id and checklist links.
 */
function DocumentEditor({ doc, list, onCancel, onDone }: {
  doc: DocumentItem; list: DocumentList; onCancel: () => void; onDone: (message: string, watch: boolean) => void;
}) {
  const [title, setTitle] = useState(doc.title ?? "");
  const [docType, setDocType] = useState<DocumentType>(doc.docType);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleId = useId(), typeId = useId(), fileId = useId(), hintId = useId(), errId = useId();
  const types = uploadableTypes(list).filter((t) => DOCUMENT_TYPES[t].classification === doc.classification);
  if (!types.includes(doc.docType)) types.unshift(doc.docType);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const t = title.trim();
    const changes: { title?: string | null; docType?: DocumentType } = {};
    if (t !== (doc.title ?? "")) changes.title = t || null;
    if (docType !== doc.docType) changes.docType = docType;
    const problem = file ? documentFileProblem(file) : null;
    if (problem) { setError(problem); fileRef.current?.focus(); return; }
    if (!file && Object.keys(changes).length === 0) { setError("Change the title, the type or choose a new file."); return; }
    setBusy(true);
    try {
      let version = doc.version;
      if (Object.keys(changes).length > 0) version = (await documentsApi.update(doc.id, { ...changes, expectedVersion: version })).version;
      if (file) {
        const r = await documentsApi.requestReplace(doc.id, documentTypeOf(file)!, file.size, version);
        await postToStorage(r.upload, file);
        onDone("New file uploaded. It replaces the current one once the malware scan passes.", true);
      } else {
        onDone(`${t || DOCUMENT_TYPES[docType].label} saved.`, false);
      }
    } catch (err) {
      setError(documentError(err, "edit"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="doceditor" noValidate aria-label={`Edit ${documentName(doc)}`} onSubmit={(e) => void save(e)}>
      <div className="doceditgrid">
        <div className="field">
          <label htmlFor={titleId}>Title (optional)</label>
          <input id={titleId} maxLength={120} placeholder={doc.docTypeLabel} value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </div>
        <div className="field">
          <label htmlFor={typeId}>Document type</label>
          <select id={typeId} value={docType} onChange={(e) => setDocType(e.target.value as DocumentType)}>
            {types.map((t) => <option key={t} value={t}>{DOCUMENT_TYPES[t].label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={fileId}>Replace file (optional)</label>
          <input ref={fileRef} id={fileId} type="file" accept={ACCEPT} aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
        </div>
      </div>
      <small id={hintId} className="hint">
        {doc.classification === "restricted" ? "Restricted types only; " : "Internal types only; "}
        to change the access level, upload the file again as the other type. A new file is scanned first; the current one stays in use until it passes.
      </small>
      {error && <p id={errId} className="error" role="alert">{error}</p>}
      <div className="pwactions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>Save</button>
      </div>
    </form>
  );
}

/**
 * Paperwork and compliance documents of a candidate or placement (FR-PPR-01
 * to 03). Uploads go straight to storage through a short-lived signed form and
 * are usable after the malware scan. Restricted documents (I-9, driving
 * license, work authorization) are listed only for HR, Accounts and
 * Immigration (role and scope decide, no step-up since migration 0350); each
 * opening is in the access log. Shown to document:read holders; 403/404 hides the section.
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
  const [stepUpFor, setStepUpFor] = useState<{ doc: DocumentItem; mode: OpenMode } | null>(null);
  const [viewing, setViewing] = useState<{ doc: DocumentItem; url: string } | null>(null);
  const [logFor, setLogFor] = useState<DocumentItem | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const watching = useRef(new Set<string>());

  const q = useQuery({
    queryKey: documentKeys.list(owner),
    queryFn: () => documentsApi.list(owner),
    refetchInterval: (query) => (query.state.data?.items.some((d) => d.status === "pending" || d.replacement?.status === "pending") ? pollMs : false),
  });

  useEffect(() => {
    for (const d of q.data?.items ?? []) {
      if (!watching.current.has(d.id) || d.status === "pending" || d.replacement?.status === "pending") continue;
      watching.current.delete(d.id);
      if (d.replacement) setMessage(`New file for ${documentName(d)} not accepted. ${resumeStatusText(d.replacement)}. The earlier file is still in use.`);
      else setMessage(d.status === "clean" ? `${documentName(d)} is ready.` : `Upload not accepted. ${resumeStatusText(d)}.`);
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

  /** View in the app or download; both take a fresh signed link (one access-log row each). */
  const open = async (d: DocumentItem, mode: OpenMode) => {
    setMessage(""); setError(""); setBusy(d.id);
    try {
      const { url } = await documentsApi.downloadLink(d.id);
      if (mode === "view") setViewing({ doc: d, url });
      else { browser.download(url); setMessage(`Downloading ${documentName(d)}.`); }
      if (d.classification === "restricted") void qc.invalidateQueries({ queryKey: documentKeys.accessLog(d.id) });
    } catch (err) {
      if (isStepUpRequired(err)) setStepUpFor({ doc: d, mode });
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
              {items.map((d) => editing === d.id && q.data ? (
                <tr key={d.id} className="editing"><td colSpan={5}>
                  <DocumentEditor doc={d} list={q.data} onCancel={() => setEditing(null)}
                    onDone={(m, watch) => {
                      setEditing(null); setError(""); setMessage(m);
                      if (watch) watching.current.add(d.id);
                      void qc.invalidateQueries({ queryKey: documentKeys.list(owner) });
                      void qc.invalidateQueries({ queryKey: ["documents"] });
                    }} />
                </td></tr>
              ) : (
                <tr key={d.id}>
                  <td className="wrap">
                    {documentName(d)}
                    {d.classification === "restricted" && <> <span className="badge restricted">Restricted</span></>}
                    {owner.kind === "candidate" && d.placementId && <span className="muted"> · placement</span>}
                    {d.title && <span className="block">{d.docTypeLabel}</span>}
                    {d.replacement && (
                      <span className={`block${d.replacement.status === "pending" ? "" : " error"}`}>
                        {d.replacement.status === "pending" ? "New file scanning; the current file is used until it passes."
                          : `New file not accepted: ${resumeStatusText(d.replacement)}.`}
                      </span>
                    )}
                  </td>
                  <td><span className={`badge resume-${d.status}`}>{resumeStatusText(d)}</span></td>
                  <td><time dateTime={d.createdAt}>{fmtDateTime(d.createdAt)}</time>{d.uploadedBy.name ? ` · ${d.uploadedBy.name}` : ""}</td>
                  <td>{fmtBytes(d.sizeBytes)}</td>
                  <td className="rowactions">
                    {d.status === "clean" && (<>
                      <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === d.id || undefined} onClick={() => void open(d, "view")}>
                        View<span className="sr-only"> {documentName(d)}</span>
                      </button>
                      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void open(d, "download")}>
                        Download<span className="sr-only"> {documentName(d)}</span>
                      </button>
                    </>)}
                    {d.classification === "restricted" && (
                      <button type="button" className="btn sm" onClick={() => setLogFor(d)}>
                        Access log<span className="sr-only"> for {d.docTypeLabel}</span>
                      </button>
                    )}
                    {q.data && canEdit(q.data, d) && (
                      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => { setEditing(d.id); setMessage(""); }}>
                        Edit<span className="sr-only"> {documentName(d)}</span>
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
          onConfirmed={() => { const { doc, mode } = stepUpFor; setStepUpFor(null); void qc.invalidateQueries({ queryKey: documentKeys.stepUp }); void open(doc, mode); }} />
      )}
      {viewing && (
        <DocumentViewer title={documentName(viewing.doc)} url={viewing.url} contentType={viewing.doc.contentType}
          onClose={() => setViewing(null)} onDownload={() => { const d = viewing.doc; setViewing(null); void open(d, "download"); }} />
      )}
      {logFor && <AccessLogDialog doc={logFor} onClose={() => setLogFor(null)} />}
    </section>
  );
}
