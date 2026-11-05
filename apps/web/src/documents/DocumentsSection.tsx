import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DOCUMENT_CONTENT_TYPES, DOCUMENT_TYPES, type DocumentType } from "@eureka/shared";
import { ApiError } from "../api";
import { Dialog } from "../ui/Dialog";
import { browser, fmtBytes, postToStorage, resumeStatusText } from "../sales/resumesApi";
import {
  documentFileProblem, documentKeys, documentName, documentStorage, documentTypeOf, documentsApi, isStepUpRequired, uploadableTypes,
  type DocumentItem, type DocumentList, type DocumentOwner,
} from "./documentsApi";
import { StepUpDialog } from "../ui/StepUpDialog";
import { DocumentViewer } from "./DocumentViewer";
import { UPLOAD_FAILED_MESSAGE } from "../lib/uploadErrors";
import { fmtDateTime } from "../lib/format";
import "./documents.css";

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
 * Upload form for one document (type, file, Upload) with upload progress. Exported so other screens
 * (e.g. the paperwork checklist item dialog) can upload and link in one step: `onUploaded` gets the new
 * document id while it is still being scanned (status "pending"); the server gates opening on the scan.
 */
export function DocumentUploader({ owner, list, onUploaded, onStart, heading = "Upload a document", submitLabel = "Upload document", defaultType = "" }: {
  owner: DocumentOwner;
  /** The section's listing: decides which types are offered (restricted only with canUploadRestricted). */
  list: Pick<DocumentList, "canUploadRestricted">;
  onUploaded: (doc: { id: string; docType: DocumentType; fileName: string }) => void;
  /** Called when an upload starts (to clear older messages). */
  onStart?: () => void;
  heading?: string | null; submitLabel?: string; defaultType?: DocumentType | "";
}) {
  const qc = useQueryClient();
  const inputId = useId(), typeId = useId(), hintId = useId(), errId = useId(), headId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<DocumentType | "">(defaultType);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const types = uploadableTypes(list);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(""); onStart?.();
    const problem = !docType ? "Choose the document type." : file ? documentFileProblem(file) : "Choose a file to upload.";
    if (problem || !file || !docType) { setError(problem ?? ""); (docType ? inputRef.current : document.getElementById(typeId))?.focus(); return; }
    setBusy(true); setProgress(0);
    try {
      const r = await documentsApi.requestUpload(owner, docType, documentTypeOf(file)!, file.size);
      await documentStorage.post(r.upload, file, (f) => setProgress(Math.round(f * 100)));
      const name = file.name;
      setFile(null); setDocType(defaultType);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded({ id: r.id, docType, fileName: name });
      await qc.invalidateQueries({ queryKey: documentKeys.list(owner) });
    } catch (err) {
      setError(documentError(err, "upload"));
      inputRef.current?.focus();
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  return (
    <form className="docupload" onSubmit={(e) => void upload(e)} noValidate aria-labelledby={heading ? headId : undefined} aria-label={heading ? undefined : submitLabel}>
      {heading && <h3 id={headId}>{heading}</h3>}
      <div className="du-row">
        <div className="field du-type">
          <label htmlFor={typeId}>Document type</label>
          <select id={typeId} value={docType} disabled={busy} onChange={(e) => { setDocType(e.target.value as DocumentType | ""); setError(""); }}>
            <option value="">Choose…</option>
            {types.map((t) => (
              <option key={t} value={t}>{DOCUMENT_TYPES[t].label}{DOCUMENT_TYPES[t].classification === "restricted" ? " (restricted)" : ""}</option>
            ))}
          </select>
        </div>
        <div className="field du-file">
          <label htmlFor={inputId}>Document file</label>
          <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} disabled={busy} aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`}
            aria-invalid={error ? true : undefined}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
        </div>
        <button type="submit" className="btn du-submit" disabled={busy} aria-busy={busy || undefined}>{submitLabel}</button>
      </div>
      <small id={hintId} className="hint">
        PDF, Word (.docx), PNG or JPEG, up to 15 MB{file ? `. Chosen: ${file.name}, ${fmtBytes(file.size)}` : ""}. Files are scanned for malware before anyone can open them.
      </small>
      {progress !== null && (
        <div className="du-progress" role="status">
          <progress max={100} value={progress} aria-label="Upload progress" />
          <span>Uploading… {progress}%</span>
        </div>
      )}
      {error && <p id={errId} className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}
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
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Live message tone: info while scanning or working, ok when ready, error when refused.
  const [tone, setTone] = useState<"ok" | "info" | "error">("ok");
  const say = (m: string, t: "ok" | "info" | "error" = "ok") => { setMessage(m); setTone(t); };
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
      if (d.replacement) say(`New file for ${documentName(d)} not accepted. ${resumeStatusText(d.replacement)}. The earlier file is still in use.`, "error");
      else if (d.status === "clean") say(`${documentName(d)} is ready.`);
      else say(`Upload not accepted. ${resumeStatusText(d)}.`, "error");
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

  /** View in the app or download; both take a fresh signed link (one access-log row each). */
  const open = async (d: DocumentItem, mode: OpenMode) => {
    say(""); setError(""); setBusy(d.id);
    try {
      const { url } = await documentsApi.downloadLink(d.id);
      if (mode === "view") setViewing({ doc: d, url });
      else { browser.download(url); say(`Downloading ${documentName(d)}.`, "info"); }
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
      <p aria-live="polite" aria-atomic="true" className={`livemsg${tone === "ok" ? "" : ` ${tone}`}`}>{message}</p>
      {error && <p className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}

      {q.isLoading ? <p className="muted">Loading…</p>
        // Announced politely: a load failure is not the result of something the user just did.
        : q.error ? <p className="error" aria-live="polite">{documentError(q.error, "load")}</p>
        : items.length === 0 ? (
          <p className="muted">
            No documents yet.{!q.data?.canUpload && " HR, Accounts and Immigration upload paperwork here."}
          </p>
        ) : (
          <div className="tablewrap docs-tablewrap"><table className="dtable docs-table" aria-label={`${title}, newest first`}>
            <thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col">Uploaded</th><th scope="col" className="num">Size</th><th scope="col" className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((d) => editing === d.id && q.data ? (
                <tr key={d.id} className="editing"><td colSpan={5} className="docs-editcell">
                  <DocumentEditor doc={d} list={q.data} onCancel={() => setEditing(null)}
                    onDone={(m, watch) => {
                      setEditing(null); setError(""); say(m, watch ? "info" : "ok");
                      if (watch) watching.current.add(d.id);
                      void qc.invalidateQueries({ queryKey: documentKeys.list(owner) });
                      void qc.invalidateQueries({ queryKey: ["documents"] });
                    }} />
                </td></tr>
              ) : (
                <tr key={d.id}>
                  <td className="wrap c-primary">
                    <b>{documentName(d)}</b>
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
                  <td className="c-badge"><span className={`badge resume-${d.status}`}>{resumeStatusText(d)}</span></td>
                  <td data-label="Uploaded"><span><time dateTime={d.createdAt}>{fmtDateTime(d.createdAt)}</time>{d.uploadedBy.name ? ` · ${d.uploadedBy.name}` : ""}</span></td>
                  <td data-label="Size" className="num">{fmtBytes(d.sizeBytes)}</td>
                  <td className="c-act">
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
                      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => { setEditing(d.id); say(""); }}>
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
        <DocumentUploader owner={owner} list={q.data} onStart={() => { say(""); setError(""); }}
          onUploaded={({ id }) => {
            watching.current.add(id);
            say("Uploaded. Scanning for malware; the document is available once the scan passes.", "info");
          }} />
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
