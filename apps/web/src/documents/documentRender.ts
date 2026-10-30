/**
 * In-app rendering of scanned documents (PDF, Word .docx, PNG, JPEG) without
 * downloading them. Works inside the app CSP (infra/modules/stack/edge.tf):
 * the bytes come through fetch (connect-src allows the documents bucket, whose
 * CORS allows GET), PDFs are drawn on canvases by pdf.js (worker from 'self',
 * eval off), images become data: URLs (img-src allows data:), and Word files
 * are converted to HTML by mammoth and sanitized. No blob: URLs or frames.
 * The heavy libraries load on first use.
 */
import type { DocumentContentType } from "@eureka/shared";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type Rendered =
  | { kind: "image"; src: string }
  | { kind: "html"; html: string }
  | { kind: "pdf"; pages: number; draw: (container: HTMLElement, isCancelled: () => boolean) => Promise<void>; close: () => void };

/** Fetches the signed link (the response is `attachment`, which fetch ignores). */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 403 ? "The link expired. Close and open the document again." : "Couldn't load the document.");
  return res.arrayBuffer();
}

function dataUrl(bytes: ArrayBuffer, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the image."));
    r.readAsDataURL(new Blob([bytes], { type }));
  });
}

async function docxHtml(bytes: ArrayBuffer): Promise<string> {
  const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([import("mammoth"), import("dompurify")]);
  const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes });
  const purify = DOMPurify(window);
  // Links open outside the app; embedded images stay as data: URIs (mammoth's default).
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
  });
  return purify.sanitize(value, {
    FORBID_TAGS: ["style", "form", "input", "button"], FORBID_ATTR: ["style", "class", "id"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpeg|gif|bmp|webp);)/i,
  });
}

async function pdf(bytes: ArrayBuffer): Promise<Rendered> {
  const [pdfjs, { default: workerSrc }] = await Promise.all([
    import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, enableXfa: false }).promise;
  return {
    kind: "pdf",
    pages: doc.numPages,
    close: () => void doc.destroy(),
    // One canvas per page, sized to the container width and sharp on high-DPI screens.
    async draw(container, isCancelled) {
      const width = Math.max(container.clientWidth, 320);
      const ratio = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages && !isCancelled(); n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = "docpage";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      }
    },
  };
}

export async function renderDocument(url: string, contentType: DocumentContentType): Promise<Rendered> {
  const bytes = await fetchBytes(url);
  switch (contentType) {
    case "image/png":
    case "image/jpeg": return { kind: "image", src: await dataUrl(bytes, contentType) };
    case DOCX: return { kind: "html", html: await docxHtml(bytes) };
    case "application/pdf": return pdf(bytes);
    default: throw new Error("This file type can't be previewed. Download it instead.");
  }
}
