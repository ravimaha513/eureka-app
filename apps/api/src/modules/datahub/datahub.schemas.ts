import { z } from "zod";
import {
  DATAHUB_DESCRIPTION_MAX, DATAHUB_LEVELS, DATAHUB_MAX_BYTES, DATAHUB_MAX_MEMBERS, DATAHUB_MAX_ROLES,
  DOCUMENT_CONTENT_TYPE_LIST, ROLES, datahubFileNameProblem, datahubFolderNameProblem,
  type DocumentContentType, type Role,
} from "@eureka/shared";

/**
 * Request shapes (docs/datahub-api.md). Names and descriptions are trimmed;
 * an empty description is "none". No owner, status, version, classification
 * or storage key: the server derives them.
 */
const folderName = z.string().transform((s) => s.trim()).superRefine((s, ctx) => {
  const p = datahubFolderNameProblem(s);
  if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p });
});
const description = z.string().max(DATAHUB_DESCRIPTION_MAX * 2)
  .transform((s) => s.trim())
  .refine((s) => s.length <= DATAHUB_DESCRIPTION_MAX, `Use at most ${DATAHUB_DESCRIPTION_MAX} characters.`)
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Remove control characters.")
  .transform((s) => (s === "" ? null : s));
const level = z.enum(DATAHUB_LEVELS);
const roleKeys = z.array(z.enum(ROLES as unknown as [Role, ...Role[]])).max(DATAHUB_MAX_ROLES)
  .refine((a) => new Set(a).size === a.length, "Each role once.");
const memberIds = z.array(z.string().uuid()).max(DATAHUB_MAX_MEMBERS)
  .refine((a) => new Set(a).size === a.length, "Each person once.");

function levelRules(v: { level?: string; roleKeys?: string[]; memberIds?: string[] }, ctx: z.RefinementCtx, levelKnown: boolean) {
  if (!levelKnown) return;
  if (v.level === "confidential" && !(v.roleKeys && v.roleKeys.length >= 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roleKeys"], message: "Choose at least one role for a confidential folder." });
  }
  if (v.level !== "confidential" && v.roleKeys && v.roleKeys.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roleKeys"], message: "Roles apply to confidential folders only." });
  }
  if (v.level !== "restricted" && v.memberIds && v.memberIds.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["memberIds"], message: "People apply to restricted folders only." });
  }
}

export const FolderCreate = z
  .object({
    name: folderName,
    description: description.nullable().optional(),
    level,
    roleKeys: roleKeys.optional(),
    memberIds: memberIds.optional(),
    membersCanUpload: z.boolean().optional(),
    parentId: z.string().uuid().nullable().optional(),
    locationId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => levelRules(v, ctx, true));
export type FolderCreate = z.infer<typeof FolderCreate>;

/**
 * Partial settings change. The row version travels in If-Match. `memberIds`
 * names people to add when the folder is (or becomes) restricted.
 */
export const FolderUpdate = z
  .object({
    name: folderName.optional(),
    description: description.nullable().optional(),
    level: level.optional(),
    roleKeys: roleKeys.optional(),
    memberIds: memberIds.optional(),
    membersCanUpload: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.")
  .superRefine((v, ctx) => levelRules(v, ctx, v.level !== undefined));
export type FolderUpdate = z.infer<typeof FolderUpdate>;

export const UploadRequest = z
  .object({
    name: z.string().max(400).transform((s) => s.trim()),
    contentType: z.enum(DOCUMENT_CONTENT_TYPE_LIST as [DocumentContentType, ...DocumentContentType[]]),
    size: z.number().int().min(1).max(DATAHUB_MAX_BYTES),
  })
  .strict()
  .superRefine((v, ctx) => {
    const p = datahubFileNameProblem(v.name, v.contentType);
    if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: p });
  });
export type UploadRequest = z.infer<typeof UploadRequest>;

/** Keyset cursor: opaque base64url JSON. */
export const Cursor = z.string().max(400).regex(/^[A-Za-z0-9_-]+$/);

export const FileListQuery = z
  .object({ cursor: Cursor.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export const SearchQuery = z
  .object({ q: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(100)), limit: z.coerce.number().int().min(1).max(50).default(25) })
  .strict();

export const PeopleQuery = z
  .object({ q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export const AccessLogQuery = z
  .object({ cursor: Cursor.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

/** Idempotency-Key header: printable ASCII, as the idempotency_key CHECK (0022). */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** `If-Match: "3"` (or 3, or W/"3") -> 3; anything else -> null. */
export function parseIfMatch(v: string | undefined): number | null {
  const m = v === undefined ? null : /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

export function decodeCursor<T>(c: string | undefined, schema: z.ZodType<T>): T | null {
  if (!c) return null;
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(c, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** LIKE pattern for a literal substring (backslash escapes). */
export const likeEscape = (s: string) => s.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
