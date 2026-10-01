import { z } from "zod";
import { RESUME_CONTENT_TYPE_LIST, RESUME_MAX_BYTES, type ResumeContentType } from "@eureka/shared";

/**
 * Upload request: the declared type and exact size become presigned POST
 * conditions. No file name and no key: the server derives the key from the
 * row id (design A6.5).
 */
export const ResumeUpload = z
  .object({
    contentType: z.enum(RESUME_CONTENT_TYPE_LIST as [ResumeContentType, ...ResumeContentType[]]),
    size: z.number().int().min(1).max(RESUME_MAX_BYTES),
  })
  .strict();
export type ResumeUpload = z.infer<typeof ResumeUpload>;
