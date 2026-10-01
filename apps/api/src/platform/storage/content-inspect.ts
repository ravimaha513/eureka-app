import { inflateRawSync, inflateSync } from "node:zlib";
import type { ResumeContentType } from "@eureka/shared";

/**
 * Content checks after the malware scan (design A6.5): the bytes must be the
 * declared type, and the document must not carry active content. Returns null
 * when the file may be promoted, else the reason code recorded on the resume:
 *   BAD_CONTENT     not a well-formed file of the declared type
 *   ACTIVE_CONTENT  macros, ActiveX, external templates/OLE links (DOCX);
 *                   JavaScript, launch actions, embedded files, open actions (PDF)
 * Fails closed: anything the parser cannot read is BAD_CONTENT.
 */
export type ContentProblem = "BAD_CONTENT" | "ACTIVE_CONTENT";

export function inspectResume(body: Buffer, contentType: ResumeContentType): ContentProblem | null {
  try {
    return contentType === "application/pdf" ? inspectPdf(body) : inspectDocx(body);
  } catch {
    return "BAD_CONTENT";
  }
}

// ---------------------------------------------------------------- DOCX (ZIP)

interface ZipEntry { name: string; method: number; flags: number; compressedSize: number; size: number; localOffset: number }

/** Uncompressed size cap for one inspected XML part (zip-bomb guard). */
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** Central directory of a ZIP (no ZIP64, no encryption, no multi-disk): throws on anything malformed. */
export function readZipDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
  // End of central directory: last 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error("multi-disk zip");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || count > MAX_ENTRIES || cdOffset + cdSize > eocd) throw new Error("unsupported zip");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const e: ZipEntry = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    };
    if (e.flags & 0x1) throw new Error("encrypted entry");
    if (e.localOffset + 30 > cdOffset || e.compressedSize === 0xffffffff) throw new Error("bad entry");
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Bytes of one entry (stored or deflated), capped at MAX_PART_BYTES. */
export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const h = e.localOffset;
  if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error("bad local header");
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new Error("truncated entry");
  if (e.method === 0) {
    if (data.length > MAX_PART_BYTES) throw new Error("part too large");
    return data;
  }
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
  throw new Error("unsupported compression");
}

const lower = (s: string) => s.toLowerCase();

function inspectDocx(buf: Buffer): ContentProblem | null {
  const entries = readZipDirectory(buf);
  const names = new Set(entries.map((e) => e.name));
  if (names.size !== entries.length) return "BAD_CONTENT"; // duplicate names: readers disagree on which wins
  if (entries.some((e) => e.name.startsWith("/") || e.name.includes("\\") || e.name.split("/").includes(".."))) return "BAD_CONTENT";
  const types = entries.find((e) => e.name === "[Content_Types].xml");
  if (!types || !names.has("word/document.xml")) return "BAD_CONTENT";

  // Macros and ActiveX controls, whatever the part is called in [Content_Types].xml.
  if (entries.some((e) => /(^|\/)vbaproject\.bin$/.test(lower(e.name)) || /(^|\/)activex/.test(lower(e.name))
    || /(^|\/)vbadata\.xml$/.test(lower(e.name)))) return "ACTIVE_CONTENT";
  const ct = lower(readZipEntry(buf, types).toString("utf8"));
  if (ct.includes("macroenabled") || ct.includes("vbaproject") || ct.includes("activex")) return "ACTIVE_CONTENT";

  // External template (remote template injection) or OLE object links in any relationship part.
  for (const e of entries.filter((x) => lower(x.name).endsWith(".rels"))) {
    const xml = readZipEntry(buf, e).toString("utf8");
    for (const rel of xml.match(/<Relationship\b[^>]*>/gi) ?? []) {
      const type = /\bType\s*=\s*"([^"]*)"/i.exec(rel)?.[1] ?? "";
      const external = /\bTargetMode\s*=\s*"External"/i.test(rel);
      if (/\/(attachedTemplate|oleObject|subDocument|frame)$/i.test(type) && external) return "ACTIVE_CONTENT";
      if (/\/(vbaProject|control|activeXControl)$/i.test(type)) return "ACTIVE_CONTENT";
    }
  }
  return null;
}

// ---------------------------------------------------------------- PDF

const PDF_DANGEROUS = new Set(["JavaScript", "JS", "Launch", "EmbeddedFile", "EmbeddedFiles", "RichMedia", "XFA"]);
/** Decompressed bytes inspected across all streams; beyond this the file is refused (fail closed). */
const MAX_PDF_INFLATED = 64 * 1024 * 1024;

/**
 * PDF names as the syntax sees them: literal strings, hex strings and comments
 * are skipped (so resume text such as "React/JS" is not a name), and #xx
 * escapes are decoded (/J#61vaScript is /JavaScript). Calls visit(name, rest)
 * with the text that follows the name.
 */
function scanPdfNames(s: string, visit: (name: string, after: number) => boolean): boolean {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === "(") {
      let depth = 1;
      for (i++; i < n && depth > 0; i++) {
        const d = s[i];
        if (d === "\\") i++;
        else if (d === "(") depth++;
        else if (d === ")") depth--;
      }
      i--;
    } else if (c === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (c === "<") {
      if (s[i + 1] === "<") { i++; continue; } // dictionary start
      while (i < n && s[i] !== ">") i++;      // hex string
    } else if (c === "/") {
      let j = i + 1;
      while (j < n && !/[\s/<>[\]()%{}]/.test(s[j]!)) j++;
      const raw = s.slice(i + 1, j);
      const name = raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      if (visit(name, j)) return true;
      i = j - 1;
    }
  }
  return false;
}

function pdfActive(s: string): boolean {
  return scanPdfNames(s, (name, after) => {
    if (PDF_DANGEROUS.has(name)) return true;
    // An open action that is an explicit destination ([page /Fit], common in
    // exported PDFs) is harmless; an action dictionary or reference is refused.
    if (name === "OpenAction" || name === "AA") {
      const next = s.slice(after).trimStart()[0];
      return name === "AA" || next !== "[";
    }
    return false;
  });
}

function inspectPdf(buf: Buffer): ContentProblem | null {
  if (buf.length < 8 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") return "BAD_CONTENT";
  const text = buf.toString("latin1");
  if (pdfActive(text)) return "ACTIVE_CONTENT";
  // Object streams (PDF 1.5+) hide dictionaries inside Flate streams: inflate every zlib stream and look again.
  let budget = MAX_PDF_INFLATED;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end;
    if (buf[start] !== 0x78) continue; // not a zlib stream (images, other filters)
    let out: Buffer;
    try {
      out = inflateSync(buf.subarray(start, end), { maxOutputLength: budget, finishFlush: 2 /* Z_SYNC_FLUSH: tolerate trailing EOL */ });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return "BAD_CONTENT";
      continue; // corrupt or not Flate: readers will not decode it either
    }
    budget -= out.length;
    if (budget <= 0) return "BAD_CONTENT";
    if (pdfActive(out.toString("latin1"))) return "ACTIVE_CONTENT";
  }
  return null;
}
