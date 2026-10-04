import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RESUME_CONTENT_TYPES } from "@eureka/shared";
import { ApiError } from "../api";
import {
  browser, fmtBytes, postToStorage, resumeFileProblem, resumeKeys, resumeStatusText, resumeTypeOf, resumesApi, type Resume,
} from "./resumesApi";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const ACCEPT = [".pdf", ".docx", ...Object.keys(RESUME_CONTENT_TYPES)].join(",");
/** While an upload is scanning, the list is refreshed this often. */
export const RESUME_POLL_MS = 3000;

function resumeError(e: unknown, action: "upload" | "download" | "load"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "upload_failed") return "The file could not be sent to storage. Try again; the link is valid for 5 minutes.";
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return action === "upload" ? "You can't upload resumes for this candidate." : "You can't open resumes for this candidate.";
    case 404: return "This resume or candidate isn't available from your account.";
    case 409: return e.detail === "too_many_pending"
      ? "Three uploads are already being scanned for this candidate. Wait for them to finish."
      : "This resume isn't available for download (it is still being scanned or did not pass).";
    case 422: return "The server refused this file. Choose a PDF or Word (.docx) file up to 15 MB.";
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? "Something went wrong.";
  }
}

/**
 * Resumes on the candidate profile (FR-CAN-07). Uploads go straight to
 * storage through a short-lived signed form; the file is usable only after the
 * malware scan passes ("Scanning" until then). Shown to document:read holders;
 * the server decides per candidate (403 hides the section).
 */
export function CandidateResumes({ candidateId, pollMs = RESUME_POLL_MS }: { candidateId: string; pollMs?: number }) {
  const qc = useQueryClient();
  const inputId = useId();
  const hintId = useId();
  const errId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** Upload ids this page started, to announce their scan result once. */
  const watching = useRef(new Set<string>());

  const q = useQuery({
    queryKey: resumeKeys.list(candidateId),
    queryFn: () => resumesApi.list(candidateId),
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === "pending") ? pollMs : false),
  });

  useEffect(() => {
    for (const r of q.data?.items ?? []) {
      if (!watching.current.has(r.id) || r.status === "pending") continue;
      watching.current.delete(r.id);
      setMessage(r.status === "clean" ? `Resume version ${r.version} is ready.` : `Upload not accepted. ${resumeStatusText(r)}.`);
    }
  }, [q.data]);

  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;

  const items = q.data?.items ?? [];
  const current = items.find((r) => r.isCurrent);
  const failed = () => { inputRef.current?.focus(); };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(""); setError("");
    const problem = file ? resumeFileProblem(file) : "Choose a file to upload.";
    if (problem || !file) { setError(problem ?? ""); failed(); return; }
    setBusy("upload");
    try {
      const { id, upload: ticket } = await resumesApi.requestUpload(candidateId, resumeTypeOf(file)!, file.size);
      setMessage("Uploading…");
      await postToStorage(ticket, file);
      watching.current.add(id);
      setMessage("Uploaded. Scanning for malware; the resume is available once the scan passes.");
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await qc.invalidateQueries({ queryKey: resumeKeys.list(candidateId) });
    } catch (err) {
      setMessage("");
      setError(resumeError(err, "upload"));
      failed();
    } finally {
      setBusy(null);
    }
  };

  const download = async (r: Resume) => {
    setMessage(""); setError(""); setBusy(r.id);
    try {
      const { url } = await resumesApi.downloadLink(candidateId, r.id);
      browser.download(url);
      setMessage(`Downloading resume version ${r.version}.`);
    } catch (err) {
      setError(resumeError(err, "download"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card pad" aria-labelledby="resumes-h">
      <h2 id="resumes-h">Resume</h2>
      {/* aria-live without role="status": the profile page owns the page-level status region. */}
      <p aria-live="polite" aria-atomic="true" className="livemsg">{message}</p>
      {error && <p id={errId} className="banner error formerr" role="alert" tabIndex={-1}>{error}</p>}

      {q.isLoading ? <p className="muted">Loading…</p>
        : q.error ? <p className="error">{resumeError(q.error, "load")}</p>
        : current ? (
          <div className="resumecurrent">
            <p>
              <strong>Current: version {current.version}</strong>{" "}
              <span className="muted">· {RESUME_CONTENT_TYPES[current.contentType].label} · {fmtBytes(current.sizeBytes)} · uploaded {fmt(current.createdAt)}
                {current.uploadedBy.name ? ` by ${current.uploadedBy.name}` : ""}</span>
            </p>
            <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === current.id || undefined}
              onClick={() => void download(current)}>
              Download current version
            </button>
          </div>
        ) : <p className="muted">No resume yet.</p>}

      {q.data?.canUpload && (
        <form className="manageblock" onSubmit={(e) => void upload(e)} noValidate>
          <h3>Upload a new version</h3>
          <div className="field">
            <label htmlFor={inputId}>Resume file</label>
            <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} aria-describedby={`${hintId}${error ? ` ${errId}` : ""}`}
              aria-invalid={error ? true : undefined}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
            <small id={hintId} className="hint">PDF or Word (.docx), up to 15 MB. Files are scanned for malware before anyone can open them.</small>
          </div>
          <button type="submit" className="btn primary" disabled={busy !== null} aria-busy={busy === "upload" || undefined}>Upload resume</button>
        </form>
      )}

      {items.length > 0 && (
        <div className="tablewrap"><table aria-label="Resume uploads, newest first">
          <thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Uploaded</th><th scope="col">Size</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{r.version ? `v${r.version}${r.isCurrent ? " (current)" : ""}` : "—"}</td>
                <td><span className={`badge resume-${r.status}`}>{resumeStatusText(r)}</span></td>
                <td><time dateTime={r.createdAt}>{fmt(r.createdAt)}</time>{r.uploadedBy.name ? ` · ${r.uploadedBy.name}` : ""}</td>
                <td>{fmtBytes(r.sizeBytes)}</td>
                <td>
                  {r.status === "clean" && (
                    <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === r.id || undefined}
                      onClick={() => void download(r)}>
                      Download<span className="sr-only"> version {r.version}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
