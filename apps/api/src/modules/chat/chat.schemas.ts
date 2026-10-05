import { z } from "zod";
import {
  CHAT_ATTACHMENTS_MAX, CHAT_BODY_MAX, CHAT_FILTERS, CHAT_NAME_MAX, DOCUMENT_CONTENT_TYPE_LIST, DOCUMENT_MAX_BYTES,
  chatFileName, normalizeChatBody, type DocumentContentType,
} from "@eureka/shared";

/** Names are trimmed; control characters are refused (the database checks the same). */
const groupName = z.string().trim().min(1).max(CHAT_NAME_MAX).refine((s) => !/[\p{Cc}]/u.test(s), "Control characters are not allowed");

/** A message body in its stored form (normalizeChatBody); length and characters checked there. */
const body = z.string().max(CHAT_BODY_MAX * 2).transform((s, ctx) => {
  const n = normalizeChatBody(s);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${CHAT_BODY_MAX} characters, no control characters` });
    return z.NEVER;
  }
  return n;
});

const userIds = z.array(z.string().uuid()).min(1).max(99);

export const ConversationListQuery = z
  .object({
    filter: z.enum(CHAT_FILTERS).default("all"),
    q: z.string().trim().max(80).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const OpenDirect = z.object({ userId: z.string().uuid() }).strict();

export const CreateGroup = z.object({ name: groupName, memberIds: userIds }).strict();

export const Rename = z.object({ name: groupName }).strict();

export const Preferences = z
  .object({ archived: z.boolean().optional(), favorite: z.boolean().optional(), muted: z.boolean().optional() })
  .strict()
  .refine((p) => p.archived !== undefined || p.favorite !== undefined || p.muted !== undefined, "Nothing to change");

export const AddMembers = z.object({ userIds }).strict();

export const MemberRole = z.object({ role: z.enum(["owner", "member"]) }).strict();

/** No key, owner, status or classification: the server derives them (design A6.5). */
const attachment = z
  .object({
    fileName: z.string().min(1).max(1000).transform((s, ctx) => {
      const n = chatFileName(s);
      if (n === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid file name" });
        return z.NEVER;
      }
      return n;
    }),
    contentType: z.enum(DOCUMENT_CONTENT_TYPE_LIST as [DocumentContentType, ...DocumentContentType[]]),
    size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
  })
  .strict();

/**
 * POST .../messages. `clientId` makes the send idempotent (a retry with the
 * same id returns the first message). A body or at least one attachment.
 */
export const SendMessage = z
  .object({
    clientId: z.string().uuid(),
    body: body.default(""),
    attachments: z.array(attachment).max(CHAT_ATTACHMENTS_MAX).default([]),
  })
  .strict()
  .refine((m) => (typeof m.body === "string" && m.body.trim() !== "") || (Array.isArray(m.attachments) && m.attachments.length > 0),
    { message: "Write a message or attach a file", path: ["body"] });
export type SendMessage = z.infer<typeof SendMessage>;

export const EditMessage = z.object({ body }).strict();

export const MarkRead = z.object({ messageId: z.string().uuid().optional() }).strict();

/**
 * GET .../messages: the newest page (no cursor), an older page (`before` =
 * a message seq), or changes since a poll cursor (`after` = a revision).
 */
export const MessagesQuery = z
  .object({
    before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((q) => q.before === undefined || q.after === undefined, "Use either before or after");
export type MessagesQuery = z.infer<typeof MessagesQuery>;

export const PeopleQuery = z
  .object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export interface ListCursor { at: string; id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const encodeListCursor = (c: ListCursor) => Buffer.from(JSON.stringify([c.at, c.id])).toString("base64url");
export function decodeListCursor(s: string): ListCursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [at, id] = v as unknown[];
    if (typeof at !== "string" || typeof id !== "string" || !UUID.test(id) || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}
