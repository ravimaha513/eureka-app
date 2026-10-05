/** Typed client for the internal chat (apps/api/src/modules/chat; docs/chat-api.md). */
import { CHAT_ATTACHMENTS_MAX, type ChatFilter, type DocumentContentType } from "@eureka/shared";
import { ApiError, api } from "../api";
import type { UploadTicket } from "../sales/resumesApi";

export interface Counterpart { id: string; name: string | null; designation: string | null; online: boolean }

export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  counterpart: Counterpart | null;
  memberCount: number;
  archived: boolean;
  favorite: boolean;
  muted: boolean;
  unread: number;
  unreadCapped: boolean;
  lastMessage: { id: string; preview: string | null; mine: boolean; sender: { id: string | null; name: string | null }; createdAt: string } | null;
  activityAt: string;
}

export interface Member { id: string; name: string | null; designation: string | null; role: "owner" | "member"; online: boolean; me: boolean }

export interface ConversationDetail {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  name: string | null;
  rowVersion: number;
  createdAt: string;
  archived: boolean;
  favorite: boolean;
  muted: boolean;
  myRole: "owner" | "member";
  canManage: boolean;
  members: Member[];
}

/** pending: uploading or being scanned; clean: can be downloaded; infected/rejected: blocked; failed/expired: upload failed. */
export interface Attachment { id: string; fileName: string; contentType: string; sizeBytes: number; status: string }

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  rev: number;
  sender: { id: string; name: string | null };
  mine: boolean;
  body: string;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
}

export interface Person { id: string; name: string; designation: string | null; online: boolean }

export interface MessagePage { items: Message[]; nextCursor: string | null; cursor: number }
export interface MessageChanges { items: Message[]; cursor: number; more: boolean }
export interface SentMessage { message: Message; uploads: { attachmentId: string; upload: UploadTicket }[] }

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const C = "/api/v1/chat";

export const chatApi = {
  list: (filter: ChatFilter, q: string) =>
    api<{ items: ConversationSummary[]; nextCursor: string | null }>(`${C}/conversations?filter=${filter}${q ? `&q=${enc(q)}` : ""}`),
  unread: () => api<{ unread: number; capped: boolean; conversations: number }>(`${C}/unread`),
  people: (q: string) => api<{ items: Person[] }>(`${C}/people?limit=20${q ? `&q=${enc(q)}` : ""}`),
  get: (id: string) => api<ConversationDetail>(`${C}/conversations/${enc(id)}`),
  openDirect: (userId: string) => api<ConversationDetail>(`${C}/conversations/direct`, { method: "POST", ...json({ userId }) }),
  createGroup: (name: string, memberIds: string[]) =>
    api<ConversationDetail>(`${C}/conversations/group`, { method: "POST", ...json({ name, memberIds }) }),
  rename: (id: string, name: string, rowVersion: number) =>
    api<ConversationDetail>(`${C}/conversations/${enc(id)}`, { method: "PATCH", headers: { "if-match": `"${rowVersion}"` }, ...json({ name }) }),
  remove: (id: string) => api<void>(`${C}/conversations/${enc(id)}`, { method: "DELETE" }),
  leave: (id: string) => api<void>(`${C}/conversations/${enc(id)}/leave`, { method: "POST" }),
  preferences: (id: string, p: Partial<Pick<ConversationDetail, "archived" | "favorite" | "muted">>) =>
    api<Pick<ConversationDetail, "archived" | "favorite" | "muted">>(`${C}/conversations/${enc(id)}/preferences`, { method: "PATCH", ...json(p) }),
  addMembers: (id: string, userIds: string[]) =>
    api<{ added: number; conversation: ConversationDetail }>(`${C}/conversations/${enc(id)}/members`, { method: "POST", ...json({ userIds }) }),
  removeMember: (id: string, userId: string) => api<void>(`${C}/conversations/${enc(id)}/members/${enc(userId)}`, { method: "DELETE" }),
  setRole: (id: string, userId: string, role: "owner" | "member") =>
    api<ConversationDetail>(`${C}/conversations/${enc(id)}/members/${enc(userId)}`, { method: "PATCH", ...json({ role }) }),
  latest: (id: string, limit = 50) => api<MessagePage>(`${C}/conversations/${enc(id)}/messages?limit=${limit}`),
  older: (id: string, before: string, limit = 50) => api<MessagePage>(`${C}/conversations/${enc(id)}/messages?limit=${limit}&before=${enc(before)}`),
  changes: (id: string, after: number) => api<MessageChanges>(`${C}/conversations/${enc(id)}/messages?after=${after}`),
  send: (id: string, clientId: string, body: string, attachments: { fileName: string; contentType: DocumentContentType; size: number }[]) =>
    api<SentMessage>(`${C}/conversations/${enc(id)}/messages`, { method: "POST", ...json({ clientId, body, attachments }) }),
  markRead: (id: string, messageId?: string) =>
    api<void>(`${C}/conversations/${enc(id)}/read`, { method: "POST", ...json(messageId ? { messageId } : {}) }),
  edit: (messageId: string, body: string) => api<Message>(`${C}/messages/${enc(messageId)}`, { method: "PATCH", ...json({ body }) }),
  deleteMessage: (messageId: string) => api<void>(`${C}/messages/${enc(messageId)}`, { method: "DELETE" }),
  downloadLink: (attachmentId: string) => api<{ url: string; expiresAt: string }>(`${C}/attachments/${enc(attachmentId)}/download`, { method: "POST" }),
};

export const chatKeys = {
  all: ["chat"] as const,
  unread: ["chat", "unread"] as const,
  list: (filter: ChatFilter, q: string) => ["chat", "list", filter, q] as const,
  lists: ["chat", "list"] as const,
  detail: (id: string) => ["chat", "detail", id] as const,
  people: (q: string) => ["chat", "people", q] as const,
};

export const MAX_ATTACHMENTS = CHAT_ATTACHMENTS_MAX;

/** Merges messages by id (the newer revision wins) and keeps them in send order. */
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (!old || m.rev >= old.rev) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** A readable reason for a failed chat call. */
export function chatError(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (!(e instanceof ApiError)) return fallback;
  switch (e.detail) {
    case "invalid_member": return "One of the people chosen cannot chat right now.";
    case "invalid_name": return "Enter a group name (at most 80 characters).";
    case "too_many_pending": return "Too many files are still uploading. Wait for them to finish.";
    case "too_many_members": return "A group can have at most 100 members.";
    case "last_owner": return "A group needs at least one owner. Make someone else an owner first.";
    case "stale": return "This group changed meanwhile. Reopen it and try again.";
    case "not_available": return "This file is not available.";
    case "message_deleted": return "That message was deleted.";
    default: break;
  }
  if (e.status === 404) return "This conversation is no longer available to you.";
  if (e.status === 429) return "You are going too fast. Wait a minute and try again.";
  if (e.status === 422) return "Check what you entered and try again.";
  return fallback;
}

/** Bytes as "12 KB" / "1.4 MB". */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What an attachment chip says about its state. */
export function attachmentState(a: Attachment): { label: string; ready: boolean } {
  if (a.status === "clean") return { label: fileSize(a.sizeBytes), ready: true };
  if (a.status === "pending") return { label: "Scanning…", ready: false };
  if (a.status === "infected" || a.status === "rejected") return { label: "Blocked", ready: false };
  return { label: "Upload failed", ready: false };
}
