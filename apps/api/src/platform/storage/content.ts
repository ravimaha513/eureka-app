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

// Content checks after the scan (type, magic bytes, active content): content-inspect.ts.
