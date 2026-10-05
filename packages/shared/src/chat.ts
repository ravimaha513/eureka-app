/**
 * Internal staff chat (docs/chat-api.md; migration 0070). Limits shared by the
 * API (validation), the database (the same limits in CHECKs and definer
 * functions) and the web app (early feedback, polling).
 */

/** Message body: plain text, newlines and tabs allowed (CH-4). */
export const CHAT_BODY_MAX = 4000;
/** Group name length (CH-3). */
export const CHAT_NAME_MAX = 80;
/** Attachments per message (CH-5); types and size as documents (PDF, DOCX, PNG, JPEG; 15 MB). */
export const CHAT_ATTACHMENTS_MAX = 5;
export const CHAT_FILE_NAME_MAX = 200;
/** Current members of a group, the owner included (CH-3). */
export const CHAT_GROUP_MAX_MEMBERS = 100;
/** "Online": a live session seen within this window (CH-7). */
export const CHAT_ONLINE_SECONDS = 120;
/** A direct message notifies its recipient only when they have not viewed the chat for this long (CH-8). */
export const CHAT_NOTIFY_AFTER_MINUTES = 10;

/** Polling (design A7: no websockets). Hidden tabs back off. */
export const CHAT_POLL = {
  listMs: 15_000,
  listHiddenMs: 60_000,
  conversationMs: 4_000,
  conversationHiddenMs: 30_000,
  badgeMs: 30_000,
  badgeHiddenMs: 120_000,
} as const;

export const CHAT_FILTERS = ["all", "unread", "group", "favorite", "archived"] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

// Control characters other than tab and newline (carriage returns are folded first).
// eslint-disable-next-line no-control-regex
const BAD_BODY_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * The stored form of a message body: CRLF and CR become LF, trailing
 * whitespace at the very end is dropped. Null when it contains other control
 * characters or is longer than CHAT_BODY_MAX (the caller answers 422).
 */
export function normalizeChatBody(body: string): string | null {
  const s = body.replace(/\r\n?/g, "\n").replace(/[ \t\n]+$/, "");
  if (s.length > CHAT_BODY_MAX || BAD_BODY_CHARS.test(s)) return null;
  return s;
}

/** True when the body has something to show (not only whitespace). */
export const chatBodyHasText = (body: string) => body.trim().length > 0;

/**
 * A file name safe to store and show: the base name only (no path), control
 * characters and path separators removed, trimmed, at most CHAT_FILE_NAME_MAX
 * characters (the extension kept). Null when nothing usable remains.
 */
export function chatFileName(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base === "" || base === "." || base === "..") return null;
  if (base.length <= CHAT_FILE_NAME_MAX) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
  return base.slice(0, CHAT_FILE_NAME_MAX - ext.length) + ext;
}
