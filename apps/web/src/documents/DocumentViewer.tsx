import { useEffect, useRef, useState } from "react";
import type { DocumentContentType } from "@eureka/shared";
import { Dialog } from "../ui/Dialog";
import { renderDocument, type Rendered } from "./documentRender";

/**
 * Views a scanned document in the app instead of downloading it. `url` is a
 * short-lived signed link from the documents or resumes API; Download asks
 * the caller for a fresh one (each link is audited).
 */
export function DocumentViewer({ title, url, contentType, onDownload, onClose }: {
  title: string; url: string; contentType: DocumentContentType; onDownload: () => void; onClose: () => void;
}) {
  const [doc, setDoc] = useState<Rendered | null>(null);
  const [error, setError] = useState("");
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: Rendered | null = null;
    renderDocument(url, contentType).then(
      (r) => { loaded = r; if (cancelled) { if (r.kind === "pdf") r.close(); } else setDoc(r); },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the document."); },
    );
    return () => { cancelled = true; if (loaded?.kind === "pdf") loaded.close(); };
  }, [url, contentType]);

  useEffect(() => {
    const node = pagesRef.current;
    if (doc?.kind !== "pdf" || !node) return;
    let cancelled = false;
    node.replaceChildren();
    doc.draw(node, () => cancelled).catch(() => { if (!cancelled) setError("Couldn't draw this PDF. Download it instead."); });
    return () => { cancelled = true; };
  }, [doc]);

  return (
    <Dialog title={title} onClose={onClose} className="xwide docviewer">
      <div className="docview" aria-busy={!doc && !error ? true : undefined}>
        {error ? <p className="error" role="alert">{error}</p>
          : !doc ? <p className="muted">Loading…</p>
          : doc.kind === "image" ? <img src={doc.src} alt={title} />
          : doc.kind === "html" ? <div className="docx" dangerouslySetInnerHTML={{ __html: doc.html }} />
          : <div ref={pagesRef} className="docpages" aria-label={`${doc.pages} page${doc.pages === 1 ? "" : "s"}`} />}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={onDownload}>Download</button>
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>Close</button>
      </div>
    </Dialog>
  );
}
