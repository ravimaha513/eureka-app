import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { CHAT_ONLINE_SECONDS, DOCUMENT_CONTENT_TYPES, isDocumentContentType } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { documentQuarantineKey, documentStoredKey } from "../../platform/storage/content.js";
import { DOCUMENT_STORAGE, type DocumentStorage, type UploadTicket } from "../../platform/storage/document-storage.js";
import {
  decodeListCursor, encodeListCursor,
  type ConversationListQuery, type MessagesQuery, type SendMessage,
} from "./chat.schemas.js";

/** Presigned POST lifetime (as documents; the database upload window is 5 minutes). */
export const CHAT_UPLOAD_TTL_SECONDS = 120;
export const CHAT_DOWNLOAD_TTL_SECONDS = 60;
export const CHAT_MESSAGES_PER_MINUTE = 60;
export const CHAT_UPLOADS_PER_MINUTE = 10;
export const CHAT_DOWNLOADS_PER_MINUTE = 30;
/** First line of defence per task; the database enforces the real limits across tasks (docs/chat-api.md CH-12). */
export const CHAT_WRITES_PER_MINUTE = 60;
export const CHAT_READS_PER_MINUTE = 240;

/** SQL: the user `alias` may still take part in chats (active, a valid role holding chat:use); mirrors authz.chat_user_ok. */
const chatUser = (alias: string) => `(${alias}.status = 'active' AND EXISTS (
  SELECT 1 FROM eureka.user_role ur JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'chat:use'
   WHERE ur.user_id = ${alias}.id AND ur.valid @> now()))`;
/** Unread messages counted at most per conversation and in total (the badge shows "99+" well before this). */
export const CHAT_UNREAD_CAP = 999;
/** Changes returned by one poll (`after`); `more: true` asks the client to poll again at once. */
export const CHAT_POLL_PAGE = 200;
const PREVIEW_CHARS = 120;

const DB_ERRORS: Record<string, () => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  invalid_member: () => new UnprocessableEntityException("invalid_member"),
  invalid_name: () => new UnprocessableEntityException("invalid_name"),
  invalid_message: () => new UnprocessableEntityException("invalid_message"),
  invalid_attachment: () => new UnprocessableEntityException("invalid_attachment"),
  invalid_role: () => new UnprocessableEntityException("invalid_role"),
  not_direct: () => new UnprocessableEntityException("not_direct"),
  not_group: () => new UnprocessableEntityException("not_group"),
  use_leave: () => new UnprocessableEntityException("use_leave"),
  too_many_pending: () => new ConflictException("too_many_pending"),
  too_many_members: () => new ConflictException("too_many_members"),
  idempotency_conflict: () => new ConflictException("idempotency_conflict"),
  message_deleted: () => new ConflictException("message_deleted"),
  last_owner: () => new ConflictException("last_owner"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  rate_limited: () => new HttpException("rate_limited", HttpStatus.TOO_MANY_REQUESTS),
};

function mapDbError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? DB_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}

interface MessageRow {
  id: string; conversation_id: string; seq: string; rev: string; sender_id: string; sender_name: string | null;
  body: string; created_at: Date; edited_at: Date | null; deleted_at: Date | null;
}
interface AttachmentRow {
  id: string; message_id: string; file_name: string; content_type: string; size_bytes: number; status: string;
  upload_expires_at: Date; file_id: string;
}

const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.seq::text AS seq, m.rev::text AS rev, m.sender_id, u.display_name AS sender_name,
  m.body, m.created_at, m.edited_at, m.deleted_at`;

/** pending: waiting for the upload or the scan; clean: downloadable; anything else: blocked or failed. */
const presentAttachment = (a: AttachmentRow) => ({
  id: a.id, fileName: a.file_name, contentType: a.content_type, sizeBytes: a.size_bytes, status: a.status,
});

function presentMessage(me: string, m: MessageRow, atts: AttachmentRow[]) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    seq: Number(m.seq),
    rev: Number(m.rev),
    sender: { id: m.sender_id, name: m.sender_name },
    mine: m.sender_id === me,
    body: m.deleted_at ? "" : m.body,
    deleted: m.deleted_at !== null,
    createdAt: m.created_at.toISOString(),
    editedAt: m.edited_at?.toISOString() ?? null,
    attachments: m.deleted_at ? [] : atts.filter((a) => a.message_id === m.id).map(presentAttachment),
  };
}

/** One line of the newest message for the conversation list. */
function preview(r: { last_body: string | null; last_deleted: boolean | null; last_attachments: number | null; last_id: string | null }) {
  if (!r.last_id) return null;
  if (r.last_deleted) return "Message deleted";
  const text = (r.last_body ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return (r.last_attachments ?? 0) > 1 ? `${r.last_attachments} attachments` : "Attachment";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/** Download name: a short id and the type's extension, never the uploaded file name. */
const downloadName = (attachmentId: string, contentType: string) =>
  `chat-attachment-${attachmentId.slice(0, 8)}.${isDocumentContentType(contentType) ? DOCUMENT_CONTENT_TYPES[contentType].ext : "bin"}`;

/**
 * Internal staff chat (docs/chat-api.md, migration 0070). Reads run under RLS
 * as the caller (current members only, CH-2); every write goes through an
 * authz.chat_* definer function that re-checks chat:use, membership and the
 * owner rules and writes the audit rows (ids and counts only, CH-10).
 */
@Injectable()
export class ChatService {
  private readonly sendLimiter = new RateLimiter(CHAT_MESSAGES_PER_MINUTE, 60_000);
  private readonly uploadLimiter = new RateLimiter(CHAT_UPLOADS_PER_MINUTE, 60_000);
  private readonly downloadLimiter = new RateLimiter(CHAT_DOWNLOADS_PER_MINUTE, 60_000);
  private readonly writeLimiter = new RateLimiter(CHAT_WRITES_PER_MINUTE, 60_000);
  private readonly readLimiter = new RateLimiter(CHAT_READS_PER_MINUTE, 60_000);

  private write(user: AuthedUser) {
    if (!this.writeLimiter.take(user.id)) throw new HttpException("rate_limited", HttpStatus.TOO_MANY_REQUESTS);
  }
  private read(user: AuthedUser) {
    if (!this.readLimiter.take(user.id)) throw new HttpException("rate_limited", HttpStatus.TOO_MANY_REQUESTS);
  }

  constructor(
    private readonly db: DbService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  /**
   * Which of `ids` are online (a live session seen within CHAT_ONLINE_SECONDS). Decided in the database
   * (authz.chat_online) and only for the caller and people they share a current conversation with (CH-7).
   */
  private async online(c: pg.PoolClient, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const r = (await c.query<{ ids: string[] }>(`SELECT authz.chat_online($1::uuid[]) AS ids`, [ids])).rows[0]!;
    return new Set(r.ids);
  }

  async listConversations(user: AuthedUser, q: ConversationListQuery) {
    this.read(user);
    const cursor = q.cursor === undefined ? null : decodeListCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) throw new UnprocessableEntityException("Invalid cursor");
    return this.db.withUser(user.id, async (c) => {
      const filter = {
        all: `NOT x.archived`,
        unread: `NOT x.archived AND x.unread > 0`,
        group: `NOT x.archived AND x.kind = 'group'`,
        favorite: `NOT x.archived AND x.favorite`,
        archived: `x.archived`,
      }[q.filter];
      const params: unknown[] = [user.id, CHAT_UNREAD_CAP];
      const where = [filter];
      if (q.q) {
        params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
        where.push(`coalesce(x.name, x.other_name) ILIKE $${params.length}`);
      }
      if (cursor) {
        params.push(cursor.at, cursor.id);
        where.push(`(x.activity, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(q.limit + 1);
      const { rows } = await c.query<{
        id: string; kind: "direct" | "group"; name: string | null; activity: Date; at: string; archived: boolean; favorite: boolean;
        muted: boolean; unread: number; other_id: string | null; other_name: string | null; other_designation: string | null;
        member_count: number; last_id: string | null; last_body: string | null; last_deleted: boolean | null;
        last_attachments: number | null; last_sender_id: string | null; last_sender_name: string | null; last_at: Date | null;
      }>(
        `WITH x AS (
           SELECT c.id, c.kind, c.name, coalesce(c.last_message_at, c.created_at) AS activity,
                  s.archived, s.favorite, s.muted,
                  (SELECT count(*)::int FROM (SELECT 1 FROM eureka.chat_message m
                     WHERE m.conversation_id = c.id AND m.seq > s.last_read_seq AND m.sender_id <> $1 AND m.deleted_at IS NULL
                     LIMIT $2) n) AS unread,
                  o.user_id AS other_id, ou.display_name AS other_name, ou.designation AS other_designation,
                  (SELECT count(*)::int FROM eureka.chat_member mm JOIN eureka.app_user mu ON mu.id = mm.user_id
                    WHERE mm.conversation_id = c.id AND mm.left_at IS NULL AND ${chatUser("mu")}) AS member_count
             FROM eureka.chat_conversation c
             JOIN eureka.chat_member_state s ON s.conversation_id = c.id AND s.user_id = $1
             LEFT JOIN LATERAL (SELECT m.user_id FROM eureka.chat_member m
                                 WHERE c.kind = 'direct' AND m.conversation_id = c.id AND m.user_id <> $1 LIMIT 1) o ON true
             LEFT JOIN eureka.app_user ou ON ou.id = o.user_id
            WHERE NOT s.hidden)
         SELECT x.*, to_char(x.activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
                lm.id AS last_id, lm.body AS last_body, lm.deleted_at IS NOT NULL AS last_deleted, lm.n_att AS last_attachments,
                lm.sender_id AS last_sender_id, lu.display_name AS last_sender_name, lm.created_at AS last_at
           FROM x
           LEFT JOIN LATERAL (SELECT m.id, m.body, m.deleted_at, m.sender_id, m.created_at,
                                     (SELECT count(*)::int FROM eureka.chat_attachment a WHERE a.message_id = m.id) AS n_att
                                FROM eureka.chat_message m WHERE m.conversation_id = x.id ORDER BY m.seq DESC LIMIT 1) lm ON true
           LEFT JOIN eureka.app_user lu ON lu.id = lm.sender_id
          WHERE ${where.join(" AND ")}
          ORDER BY x.activity DESC, x.id DESC
          LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      const online = await this.online(c, page.map((r) => r.other_id).filter((x): x is string => x !== null));
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.kind === "group" ? r.name : r.other_name,
          counterpart: r.other_id ? { id: r.other_id, name: r.other_name, designation: r.other_designation, online: online.has(r.other_id) } : null,
          memberCount: r.member_count,
          archived: r.archived, favorite: r.favorite, muted: r.muted,
          unread: r.unread, unreadCapped: r.unread >= CHAT_UNREAD_CAP,
          lastMessage: r.last_id ? {
            id: r.last_id, preview: preview(r), mine: r.last_sender_id === user.id,
            sender: { id: r.last_sender_id, name: r.last_sender_name }, createdAt: r.last_at!.toISOString(),
          } : null,
          activityAt: r.activity.toISOString(),
        })),
        nextCursor: rows.length > q.limit && last ? encodeListCursor({ at: last.at, id: last.id }) : null,
      };
    });
  }

  /** Total unread messages in the caller's visible, unmuted conversations (the nav badge). */
  async unread(user: AuthedUser) {
    this.read(user);
    return this.db.withUser(user.id, async (c) => {
      const r = (await c.query<{ unread: number; conversations: number }>(
        `SELECT coalesce(sum(n), 0)::int AS unread, count(*) FILTER (WHERE n > 0)::int AS conversations FROM (
           SELECT (SELECT count(*) FROM (SELECT 1 FROM eureka.chat_message m
                     WHERE m.conversation_id = s.conversation_id AND m.seq > s.last_read_seq AND m.sender_id <> $1
                       AND m.deleted_at IS NULL LIMIT $2) y) AS n
             FROM eureka.chat_member_state s JOIN eureka.chat_conversation c ON c.id = s.conversation_id
            WHERE s.user_id = $1 AND NOT s.muted AND NOT s.hidden) z`, [user.id, CHAT_UNREAD_CAP])).rows[0]!;
      const unread = Math.min(r.unread, CHAT_UNREAD_CAP);
      return { unread, capped: r.unread >= CHAT_UNREAD_CAP, conversations: r.conversations };
    });
  }

  /** One conversation with its current members; 404 unless the caller is a current member (RLS). */
  async get(user: AuthedUser, id: string) {
    this.read(user);
    return this.db.withUser(user.id, (c) => this.detail(c, user, id));
  }

  private async detail(c: pg.PoolClient, user: AuthedUser, id: string) {
    const conv = (await c.query<{ id: string; kind: "direct" | "group"; name: string | null; created_at: Date; row_version: number;
      archived: boolean; favorite: boolean; muted: boolean; last_rev: string }>(
      `SELECT c.id, c.kind, c.name, c.created_at, c.row_version, c.last_rev::text AS last_rev, s.archived, s.favorite, s.muted
         FROM eureka.chat_conversation c JOIN eureka.chat_member_state s ON s.conversation_id = c.id AND s.user_id = $2
        WHERE c.id = $1`, [id, user.id])).rows[0];
    if (!conv) throw new NotFoundException();
    const members = (await c.query<{ user_id: string; role: "owner" | "member"; joined_at: Date; name: string | null; designation: string | null }>(
      `SELECT m.user_id, m.role, m.joined_at, u.display_name AS name, u.designation
         FROM eureka.chat_member m JOIN eureka.app_user u ON u.id = m.user_id
        WHERE m.conversation_id = $1 AND m.left_at IS NULL AND ${chatUser("u")}
        ORDER BY (m.role = 'owner') DESC, u.display_name, m.user_id`, [id])).rows;
    const online = await this.online(c, members.map((m) => m.user_id));
    const mine = members.find((m) => m.user_id === user.id);
    const counterpart = conv.kind === "direct" ? members.find((m) => m.user_id !== user.id) : undefined;
    return {
      id: conv.id,
      kind: conv.kind,
      title: conv.kind === "group" ? conv.name : counterpart?.name ?? null,
      name: conv.name,
      rowVersion: conv.row_version,
      createdAt: conv.created_at.toISOString(),
      archived: conv.archived, favorite: conv.favorite, muted: conv.muted,
      myRole: mine?.role ?? "member",
      canManage: conv.kind === "group" && mine?.role === "owner",
      /** A group whose owners are all deactivated: any member may take ownership (PATCH members/:me). */
      ownerless: conv.kind === "group" && !members.some((m) => m.role === "owner"),
      members: members.map((m) => ({
        id: m.user_id, name: m.name, designation: m.designation, role: m.role, online: online.has(m.user_id), me: m.user_id === user.id,
      })),
    };
  }

  async openDirect(user: AuthedUser, otherId: string) {
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      const r = (await c.query<{ conversation_id: string; created: boolean }>(
        `SELECT * FROM authz.chat_open_direct($1)`, [otherId]).catch(mapDbError)).rows[0]!;
      return { created: r.created, conversation: await this.detail(c, user, r.conversation_id) };
    });
  }

  async createGroup(user: AuthedUser, name: string, memberIds: string[]) {
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      const id = (await c.query<{ id: string }>(`SELECT authz.chat_create_group($1, $2::uuid[]) AS id`, [name, memberIds])
        .catch(mapDbError)).rows[0]!.id;
      return this.detail(c, user, id);
    });
  }

  /** 428 without If-Match, 412 `stale` when the group changed since the client read it. */
  async rename(user: AuthedUser, id: string, name: string, expectedVersion: number | null) {
    if (expectedVersion === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      await c.query(`SELECT authz.chat_rename($1, $2, $3)`, [id, name, expectedVersion]).catch(mapDbError);
      return this.detail(c, user, id);
    });
  }

  async setPreferences(user: AuthedUser, id: string, p: { archived?: boolean; favorite?: boolean; muted?: boolean }) {
    this.write(user);
    return this.db.withUser(user.id, async (c) => (await c.query<{ archived: boolean; favorite: boolean; muted: boolean }>(
      `SELECT * FROM authz.chat_set_prefs($1, $2, $3, $4)`, [id, p.archived ?? null, p.favorite ?? null, p.muted ?? null])
      .catch(mapDbError)).rows[0]!);
  }

  /** "Delete chat": a direct chat is hidden for the caller; a group is deleted for everyone (owners only). */
  async remove(user: AuthedUser, id: string) {
    this.write(user);
    await this.db.withUser(user.id, async (c) => {
      const kind = (await c.query<{ kind: string }>(`SELECT kind FROM eureka.chat_conversation WHERE id = $1`, [id])).rows[0]?.kind;
      if (!kind) throw new NotFoundException();
      await c.query(kind === "direct" ? `SELECT authz.chat_hide($1)` : `SELECT authz.chat_delete_group($1)`, [id]).catch(mapDbError);
    });
  }

  async leave(user: AuthedUser, id: string) {
    this.write(user);
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.chat_leave($1)`, [id]).catch(mapDbError));
  }

  async addMembers(user: AuthedUser, id: string, userIds: string[]) {
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      const added = (await c.query<{ n: number }>(`SELECT authz.chat_add_members($1, $2::uuid[]) AS n`, [id, userIds])
        .catch(mapDbError)).rows[0]!.n;
      return { added, conversation: await this.detail(c, user, id) };
    });
  }

  async removeMember(user: AuthedUser, id: string, userId: string) {
    this.write(user);
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.chat_remove_member($1, $2)`, [id, userId]).catch(mapDbError));
  }

  async setMemberRole(user: AuthedUser, id: string, userId: string, role: "owner" | "member") {
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      await c.query(`SELECT authz.chat_set_member_role($1, $2, $3)`, [id, userId, role]).catch(mapDbError);
      return this.detail(c, user, id);
    });
  }

  private async attachmentsOf(c: pg.PoolClient, messageIds: string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) return [];
    return (await c.query<AttachmentRow>(
      `SELECT a.id, a.message_id, a.file_name, a.file_id, f.content_type, f.size_bytes, f.status, f.upload_expires_at
         FROM eureka.chat_attachment a JOIN eureka.file_object f ON f.id = a.file_id
        WHERE a.message_id = ANY ($1::uuid[]) ORDER BY a.message_id, a.position`, [messageIds])).rows;
  }

  /**
   * Messages, oldest first. No cursor: the newest page plus the poll cursor
   * (the conversation's newest revision, read first so nothing committed
   * later is missed). `before`: an older page. `after`: what changed since a
   * poll cursor (new, edited and deleted messages), with the next cursor.
   */
  async messages(user: AuthedUser, id: string, q: MessagesQuery) {
    this.read(user);
    return this.db.withUser(user.id, async (c) => {
      const conv = (await c.query<{ last_rev: string }>(
        `SELECT last_rev::text AS last_rev FROM eureka.chat_conversation WHERE id = $1`, [id])).rows[0];
      if (!conv) throw new NotFoundException();
      if (q.after !== undefined) {
        const rows = (await c.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM eureka.chat_message m LEFT JOIN eureka.app_user u ON u.id = m.sender_id
            WHERE m.conversation_id = $1 AND m.rev > $2 ORDER BY m.rev LIMIT $3`, [id, q.after, CHAT_POLL_PAGE + 1])).rows;
        const page = rows.slice(0, CHAT_POLL_PAGE);
        const atts = await this.attachmentsOf(c, page.map((m) => m.id));
        const more = rows.length > CHAT_POLL_PAGE;
        // Revisions of one conversation commit in order (the writers lock it), so the newest one
        // returned, or the newest one committed when this poll began, is a safe next cursor.
        const newest = page.length ? Number(page[page.length - 1]!.rev) : 0;
        const cursor = more ? newest : Math.max(q.after, Number(conv.last_rev), newest);
        return { items: page.map((m) => presentMessage(user.id, m, atts)).sort((a, b) => a.seq - b.seq), cursor, more };
      }
      const rows = (await c.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM eureka.chat_message m LEFT JOIN eureka.app_user u ON u.id = m.sender_id
          WHERE m.conversation_id = $1 AND ($2::bigint IS NULL OR m.seq < $2) ORDER BY m.seq DESC LIMIT $3`,
        [id, q.before ?? null, q.limit + 1])).rows;
      const page = rows.slice(0, q.limit).reverse();
      const atts = await this.attachmentsOf(c, page.map((m) => m.id));
      return {
        items: page.map((m) => presentMessage(user.id, m, atts)),
        nextCursor: rows.length > q.limit && page[0] ? String(page[0].seq) : null,
        cursor: Number(conv.last_rev),
      };
    });
  }

  private async presignPending(atts: AttachmentRow[]): Promise<{ attachmentId: string; upload: UploadTicket }[]> {
    const now = Date.now();
    const out: { attachmentId: string; upload: UploadTicket }[] = [];
    for (const a of atts) {
      if (a.status !== "pending" || a.upload_expires_at.getTime() <= now) continue;
      const ttl = Math.min(CHAT_UPLOAD_TTL_SECONDS, Math.floor((a.upload_expires_at.getTime() - now) / 1000));
      if (ttl < 5) continue;
      out.push({ attachmentId: a.id, upload: await this.storage.presignUpload({
        key: documentQuarantineKey(a.file_id), contentType: a.content_type, size: a.size_bytes, expiresSeconds: ttl,
      }) });
    }
    return out;
  }

  /**
   * Sends a message (idempotent per clientId: a retry returns the first
   * message, `created: false`, with fresh upload tickets for files still in
   * their upload window). Attachments come back as presigned POSTs into
   * quarantine/; they open once the scan finds them clean.
   */
  async send(user: AuthedUser, conversationId: string, body: SendMessage) {
    if (!this.sendLimiter.take(user.id)) throw new HttpException("Too many messages; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    if (body.attachments.length > 0 && !this.uploadLimiter.take(user.id)) {
      throw new HttpException("Too many uploads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.db.withUser(user.id, async (c) => {
      const files = body.attachments.map((a) => ({ name: a.fileName, contentType: a.contentType, size: a.size }));
      const r = (await c.query<{ message_id: string; created: boolean }>(
        `SELECT * FROM authz.chat_send($1, $2, $3, $4::jsonb)`, [conversationId, body.clientId, body.body, JSON.stringify(files)])
        .catch(mapDbError)).rows[0]!;
      const m = (await c.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM eureka.chat_message m LEFT JOIN eureka.app_user u ON u.id = m.sender_id WHERE m.id = $1`,
        [r.message_id])).rows[0];
      if (!m) throw new NotFoundException();
      const atts = await this.attachmentsOf(c, [m.id]);
      return { created: r.created, message: presentMessage(user.id, m, atts), uploads: await this.presignPending(atts) };
    });
  }

  async editMessage(user: AuthedUser, messageId: string, body: string) {
    this.write(user);
    return this.db.withUser(user.id, async (c) => {
      await c.query(`SELECT authz.chat_edit_message($1, $2)`, [messageId, body]).catch(mapDbError);
      const m = (await c.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM eureka.chat_message m LEFT JOIN eureka.app_user u ON u.id = m.sender_id WHERE m.id = $1`,
        [messageId])).rows[0];
      if (!m) throw new NotFoundException();
      return presentMessage(user.id, m, await this.attachmentsOf(c, [m.id]));
    });
  }

  async deleteMessage(user: AuthedUser, messageId: string) {
    this.write(user);
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.chat_delete_message($1)`, [messageId]).catch(mapDbError));
  }

  async markRead(user: AuthedUser, conversationId: string, messageId: string | undefined) {
    this.read(user);
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.chat_mark_read($1, $2)`, [conversationId, messageId ?? null]).catch(mapDbError));
  }

  /** A 60-second attachment link for a clean file (409 `not_available` while pending or when blocked). */
  async download(user: AuthedUser, attachmentId: string) {
    if (!this.downloadLimiter.take(user.id)) throw new HttpException("Too many downloads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    const r = await this.db.withUser(user.id, async (c) => (await c.query<{ outcome: string; file_id: string | null; content_type: string | null }>(
      `SELECT * FROM authz.chat_attachment_download($1)`, [attachmentId]).catch(mapDbError)).rows[0]!);
    if (r.outcome !== "ok" || !r.file_id || !r.content_type) throw new ConflictException("not_available");
    const url = await this.storage.presignDownload({
      key: documentStoredKey(r.file_id, "internal"), contentType: r.content_type,
      fileName: downloadName(attachmentId, r.content_type), expiresSeconds: CHAT_DOWNLOAD_TTL_SECONDS,
    });
    return { url, expiresAt: new Date(Date.now() + CHAT_DOWNLOAD_TTL_SECONDS * 1000).toISOString() };
  }

  /**
   * Active staff who may chat (name and designation only), for the pickers. No presence here: "online" is shown only
   * for people the caller shares a conversation with (CH-7).
   */
  async people(user: AuthedUser, q: { q?: string; limit: number }) {
    this.read(user);
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [user.id, q.limit];
      let match = "";
      if (q.q) {
        params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
        match = `AND (u.display_name ILIKE $3 OR u.designation ILIKE $3)`;
      }
      const { rows } = await c.query<{ id: string; display_name: string; designation: string | null }>(
        `SELECT u.id, u.display_name, u.designation FROM eureka.app_user u
          WHERE u.id <> $1 AND ${chatUser("u")} ${match}
          ORDER BY u.display_name, u.id LIMIT $2`, params);
      return { items: rows.map((r) => ({ id: r.id, name: r.display_name, designation: r.designation })) };
    });
  }
}
