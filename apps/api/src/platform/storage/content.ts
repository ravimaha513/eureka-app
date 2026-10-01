import { RESUME_CONTENT_TYPES, type ResumeContentType } from "@eureka/shared";

/**
 * Object keys of the documents bucket (infra/modules/stack/storage.tf). The
 * client never chooses a key: it is derived from the server-generated row id.
 *   quarantine/resumes/<id>  presigned POST target; scanned by GuardDuty
 *   clean/resumes/<id>       written by the worker after a clean scan; the only
 *                            prefix downloads are signed for
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkId(id: string): string {
  if (!UUID.test(id)) throw new Error("invalid document id");
  return id;
}

export const resumeQuarantineKey = (id: string) => `quarantine/resumes/${checkId(id)}`;
export const resumeCleanKey = (id: string) => `clean/resumes/${checkId(id)}`;

/** Download name: ids and version only, never the uploaded file name. */
export const resumeDownloadName = (version: number, contentType: ResumeContentType) =>
  `resume-v${version}.${RESUME_CONTENT_TYPES[contentType].ext}`;

const ascii = (s: string) => Buffer.from(s, "latin1");
const PDF = ascii("%PDF-");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Magic-byte check after the malware scan (design A6.5): the bytes must match
 * the declared type. PDF: starts with "%PDF-". DOCX: a ZIP (local file header
 * first) whose entry names include "[Content_Types].xml" and the "word/" part
 * (ZIP entry names are stored uncompressed), so an arbitrary ZIP, a .xlsx or a
 * renamed executable is refused.
 */
export function contentMatches(body: Buffer, contentType: ResumeContentType): boolean {
  if (contentType === "application/pdf") return body.length > PDF.length && body.subarray(0, PDF.length).equals(PDF);
  return body.length > ZIP.length
    && body.subarray(0, ZIP.length).equals(ZIP)
    && body.includes(ascii("[Content_Types].xml"))
    && body.includes(ascii("word/"));
}
