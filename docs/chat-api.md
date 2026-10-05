# Internal chat (Phase 3c)

Migration 0070. Reference screens: Chat (conversation list with filters, conversation header, member drawer,
"Create Group Chat" side panel, conversation menu, message box with attachments, "Online" indicator).
Design references: A6.5 (uploads), A7 (no websockets: polling), B4.5 (RLS), B6 (`document-scan`).
Code: `db/migrations/0070_chat.sql`, `apps/api/src/modules/chat`, `packages/shared/src/chat.ts`,
`apps/web/src/chat`. JSON, RFC 9457 problems with the code in `detail`, CSRF header on writes.

## Rules

| ID | Rule |
|---|---|
| CH-1 | Who chats: staff only (`eureka.app_user` with a valid role; applicants and candidates never). Permission `chat:use`, granted to every role at `own` scope (org_admin included: they take part in their own conversations only, see CH-9). Every route requires it; the database re-checks it in every `authz.chat_*` function (`authz.chat_me`) and in the RLS conversation set. A user can be added to a chat only while active and holding `chat:use` (`authz.chat_user_ok`). |
| CH-2 | Visibility: a user reads a conversation, its members, messages and attachments only while a **current member** (`left_at IS NULL`) of a conversation that is not deleted. Left members and members of a deleted group keep **no** access, history included (simplest safe default; see open questions). A member sees only messages after their `visible_after_seq`: a member added to a group later sees messages from then on; deleting a direct chat hides its history up to that point for that side. Their own state row (read position, flags) is readable by them only. RLS: `authz.chat_conversation_ids()` as an InitPlan feeding a hashed SubPlan, the caller's state row by primary key (rule 3); 404 for everything outside. |
| CH-3 | Conversations: `direct` (exactly one per user pair, `direct_key` = the two ids sorted; opening it again from either side returns it, 200; first time 201) or `group` (name 1-80 characters, trimmed, no control characters; the creator is owner; 1-99 other members; at most 100 current members). Owners add members (a former member rejoins as member), remove other members, change roles and rename (`If-Match: "<rowVersion>"`: 428 without, 412 `stale`). A group always has an owner: demoting the last owner is 409 `last_owner`; when the last owner leaves, the longest-standing member becomes owner; when the last member leaves, the group is deleted. Direct chats have no owners and no member management (422 `not_group`). |
| CH-4 | Messages: plain text up to 4000 characters (CRLF/CR folded to LF, trailing whitespace dropped; tab and newline allowed, other control characters 422). A message needs text or an attachment. Sends are idempotent per sender and `clientId` (a retry returns the first message, 200; the same `clientId` in another conversation is 409 `idempotency_conflict`). Only the sender edits (`editedAt` set) or deletes; delete is soft: the body is cleared in the database, the bubble shows "Message deleted", attachments are no longer listed or downloadable; a deleted message is final (409 `message_deleted`). 60 messages per user per minute (429). |
| CH-5 | Attachments: up to 5 per message, the documents allowlist and cap (PDF, DOCX, PNG, JPEG; 15 MB). Each is an internal `eureka.file_object` (0043) on the documents pipeline: presigned POST into `quarantine/documents/<file id>` (120 s; the database window is 5 minutes), the worker's `document-scan` job (GuardDuty or the local fake scanner, content inspection), promotion to `clean/documents/<file id>`, and a 60-second attachment link only once clean (409 `not_available` before, or when blocked). At most 10 pending chat uploads per user (409 `too_many_pending`). The uploaded file name (base name only, control characters and path separators removed, at most 200 characters) is shown to members only; downloads are named `chat-attachment-<id8>.<ext>`. The client never chooses a key, owner or status. |
| CH-6 | Ordering and polling: every function that assigns a message `seq` or `rev` locks the conversation row first, so within a conversation revisions become visible in commit order. `GET .../messages` returns the newest page and `cursor` (the conversation's newest revision, read first); `?after=<cursor>` returns everything created, edited or deleted since (by `rev`, at most 200, `more: true` to poll again at once) and the next cursor; `?before=<seq>` pages back. The web app polls the open conversation every 4 s (30 s in a hidden tab), the list every 15 s (60 s hidden) and the nav badge every 30 s (2 min hidden). After errors (429, 5xx, network) each poll backs off exponentially (x2 per consecutive failure, at most 5 minutes, +-25% jitter); a 401 or 403 stops polling. |
| CH-7 | Unread and presence: unread = messages of others after the member's read position, not deleted (capped at 999). Marking read (`POST .../read`, never backwards) also records `last_viewed_at`; the web app marks read when it shows new messages and at least once a minute while the conversation is open and visible. The nav badge counts unmuted conversations. "Online" = a live session (not revoked, not expired) seen in the last 2 minutes (`session.last_seen_at`, which every authenticated request, polling included, refreshes); no typing indicators. Presence is computed in the database (`authz.chat_online`) and returned only for the caller and people sharing a current conversation with them (list counterparts, member lists); the people picker (`GET /people`) carries no presence, so presence is no directory-wide oracle. |
| CH-8 | Notification: a direct message creates `chat.direct_message` (in-app only; payload `conversationId`, `recipientId`) when the recipient had not viewed the conversation for 10 minutes at the time the message is sent, and has not been notified since their last view (one notification per unseen stretch), never when they muted it, never for groups. The registry (`authz.notification_recipients`) resolves the recipient only while a current member of that direct chat; the inbox row names nobody and opens the conversation. |
| CH-9 | Privacy: no admin, auditor or worker read access to chats (no policy for them; the worker has no grant). Nothing in the API lets anyone read a conversation they are not in. |
| CH-10 | Audit (ids, kinds, roles and counts only; never message text, group names, file names or display names): `chat.conversation_created` (`kind`, `memberCount`), `chat.conversation_renamed` (`rowVersion`), `chat.conversation_deleted` (`memberCount`), `chat.member_added` / `chat.member_removed` (`userId`), `chat.member_left` (`remainingMembers`, `ownerPromoted`), `chat.member_role_changed` (`userId`, `role`), `chat.message_deleted` (`messageId`, `attachmentCount`). Sends, edits, reads and preference changes are not audited. Entity: `chat_conversation`. |
| CH-11 | Writes only through the `authz.chat_*` SECURITY DEFINER functions (pinned search_path, no PUBLIC execute, re-check `chat:use`, membership and owner rules); the guard trigger refuses any other writer (owner and superuser included), every DELETE and TRUNCATE, and changes to identity columns; a deleted message or conversation is final. Retention: kept indefinitely for now (open question). |

| CH-12 | Limits enforced in the database (across all API tasks; error `rate_limited`, 429), with a per-task in-memory limiter in the API as first line (60 writes and 240 reads per user per minute): 20 groups created per user per hour; 50 new direct chats per user per hour; 200 members added per user per hour (`eureka.chat_add_event`, also counts rejoins); 120 messages per user per minute; 30 edited and 60 deleted messages per user per minute. Mark-read, list and people are bounded by the API limiter only (idempotent, cheap). |
| CH-13 | Deactivated users: a user who is deactivated (or lacks `chat:use` through a valid role) is not shown as a member, is not counted in member counts and cannot be added or chatted with; their membership rows remain. When every owner of a group is deactivated the group is `ownerless` and any current member may take ownership (`PATCH members/:me` `{role: owner}`), after which the new owner can remove or add members. On reactivation their `visible_after_seq` moves to each conversation's newest message and the read position with it (trigger `chat_user_reactivated`), so they see nothing sent while they were deactivated. Regranting a role to a user with no valid role does not move it (not a deactivation). |

## Endpoints (all under `/api/v1/chat`, `chat:use`)

- `GET /conversations?filter=all|unread|group|favorite|archived&q=&cursor=&limit=` returns `{ items, nextCursor }`, newest
  activity first. `all`, `unread`, `group`, `favorite` exclude archived chats; `archived` shows only them; hidden (deleted)
  direct chats never show. Item: `{ id, kind, title, counterpart: { id, name, designation, online } | null, memberCount,
  archived, favorite, muted, unread, unreadCapped, lastMessage: { id, preview, mine, sender, createdAt } | null, activityAt }`.
  `q` matches the group name or the other person's name.
- `GET /unread` returns `{ unread, capped, conversations }` (unmuted conversations).
- `GET /people?q=&limit=` returns `{ items: [{ id, name, designation }] }`: active staff who may chat, not the caller.
- `POST /conversations/direct` `{ userId }` returns the conversation (201 created, 200 existing; 422 `invalid_member`).
- `POST /conversations/group` `{ name, memberIds }` returns 201 with the conversation.
- `GET /conversations/:id` returns `{ id, kind, title, name, rowVersion, createdAt, archived, favorite, muted, myRole,
  canManage, members: [{ id, name, designation, role, online, me }] }` (current members).
- `PATCH /conversations/:id` `{ name }` with `If-Match` (owners): returns the conversation.
- `DELETE /conversations/:id` "Delete chat": a direct chat is hidden for the caller with its history so far (CH-2); a group
  is deleted for everyone (owners, 403 otherwise). 204.
- `POST /conversations/:id/leave` (groups) 204. `PATCH /conversations/:id/preferences` `{ archived?, favorite?, muted? }`
  returns the three flags (the caller's own; last write wins).
- `POST /conversations/:id/members` `{ userIds }` (owners) returns `{ added, conversation }`;
  `DELETE /conversations/:id/members/:userId` 204; `PATCH /conversations/:id/members/:userId` `{ role }` returns the conversation.
- `GET /conversations/:id/messages?limit=` / `?before=<seq>` returns `{ items, nextCursor, cursor }` (oldest first);
  `?after=<cursor>` returns `{ items, cursor, more }`. Message: `{ id, conversationId, seq, rev, sender: { id, name }, mine,
  body, deleted, createdAt, editedAt, attachments: [{ id, fileName, contentType, sizeBytes, status }] }`.
- `POST /conversations/:id/messages` `{ clientId, body?, attachments?: [{ fileName, contentType, size }] }` returns
  `{ message, uploads: [{ attachmentId, upload: { url, fields, expiresAt } }] }` (201; 200 for a retry, with fresh tickets
  for files still in their upload window).
- `POST /conversations/:id/read` `{ messageId? }` 204. `PATCH /messages/:id` `{ body }` returns the message.
  `DELETE /messages/:id` 204. `POST /attachments/:id/download` returns `{ url, expiresAt }`.

Errors: 404 for anything outside the caller's conversations; 403 owner-only actions and editing others' messages;
422 validation (`invalid_member`, `invalid_name`, `invalid_message`, `invalid_attachment`, `not_group`, `not_direct`,
`use_leave`); 409 `last_owner`, `too_many_members`, `too_many_pending`, `idempotency_conflict`, `message_deleted`,
`not_available`; 412 `stale`; 428 `if_match_required`; 429 rate limits (CH-12 `rate_limited`; 10 uploading sends and 30 downloads per minute per task). `before`/`after` above 2^53-1 are 422. Conversation detail also carries `ownerless`.

## Web

Chat screen (nav section "Other", badge with the unread count): two panes on desktop; on phones the list and the
conversation are separate views with a back button. Filters All Messages / Unread / Group / Favorite / Archived, search
that also finds people to start a direct chat, "+" opens the Create Group Chat side panel (name and member search).
Header with presence or member count, Members drawer (owners rename, add, remove, change roles), menu with favorite,
archive, mute, Leave group (groups) and Delete chat (direct chats; groups for owners). Bubbles: mine right, theirs left,
times, day separators, "edited", "Message deleted", attachments as chips (download when clean, "Scanning…",
"Blocked", "Upload failed"); plain text with https links only (new tab, `noopener noreferrer nofollow`, never HTML).
Enter sends, Shift+Enter adds a line; a failed send keeps the text and its client id. New messages from others are
announced in a polite live region; every icon button has an accessible name.

## Open questions

- Retention of messages and attachments (kept indefinitely today; legal hold or export needs?).
- Should members who left a group keep read access to its history up to when they left (built: no)?
- Should a member added to a group see its earlier history (built: no, only messages from when they joined)?
- Should org admins, HR or compliance be able to read chats (built: nobody but members, CH-9)?
- Presence is visible only to people sharing a chat; is a per-user "appear offline" setting wanted?
- Polling keeps the session's idle timer alive while a tab is open (true already for the notification bell);
  should background polls stop counting as activity for the 60-minute idle timeout?
- Email for direct messages, or notifications for group mentions?
