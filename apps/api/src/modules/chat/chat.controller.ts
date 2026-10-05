import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { parseIfMatch } from "../work-authorization/work-authorization.schemas.js";
import {
  AddMembers, ConversationListQuery, CreateGroup, EditMessage, MarkRead, MemberRole, MessagesQuery, OpenDirect, PeopleQuery,
  Preferences, Rename, SendMessage,
} from "./chat.schemas.js";
import { ChatService } from "./chat.service.js";

/**
 * Internal staff chat (docs/chat-api.md). Every route needs chat:use (every
 * role, own scope); the conversation rules live in the database (RLS and the
 * authz.chat_* functions of migration 0070). Clients poll (design A7).
 */
@Controller("api/v1/chat")
@RequirePermission("chat:use")
export class ChatController {
  constructor(private readonly svc: ChatService) {}

  @Get("conversations")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listConversations(user, ConversationListQuery.parse(q ?? {}));
  }

  @Get("unread")
  unread(@CurrentUser() user: AuthedUser) {
    return this.svc.unread(user);
  }

  @Get("people")
  people(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.people(user, PeopleQuery.parse(q ?? {}));
  }

  /** The direct chat with another user: 201 when created, 200 when it existed. */
  @Post("conversations/direct")
  async direct(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.svc.openDirect(user, OpenDirect.parse(body).userId);
    void reply.status(r.created ? 201 : 200);
    return r.conversation;
  }

  @Post("conversations/group")
  createGroup(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    const b = CreateGroup.parse(body);
    return this.svc.createGroup(user, b.name, b.memberIds);
  }

  @Get("conversations/:id")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** Rename a group (owners); `If-Match: "<rowVersion>"` (428 without, 412 `stale`). */
  @Patch("conversations/:id")
  rename(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.rename(user, id, Rename.parse(body).name, parseIfMatch(ifMatch));
  }

  /** "Delete chat": hides a direct chat for the caller; deletes a group for everyone (owners). */
  @Delete("conversations/:id")
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.remove(user, id);
  }

  @Post("conversations/:id/leave")
  @HttpCode(204)
  async leave(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.leave(user, id);
  }

  /** The caller's own flags (archived, favorite, muted); last write wins. */
  @Patch("conversations/:id/preferences")
  preferences(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setPreferences(user, id, Preferences.parse(body));
  }

  @Post("conversations/:id/members")
  @HttpCode(200)
  addMembers(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addMembers(user, id, AddMembers.parse(body).userIds);
  }

  @Delete("conversations/:id/members/:userId")
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string): Promise<void> {
    await this.svc.removeMember(user, id, userId);
  }

  @Patch("conversations/:id/members/:userId")
  setRole(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("userId", ParseUUIDPipe) userId: string, @Body() body: unknown) {
    return this.svc.setMemberRole(user, id, userId, MemberRole.parse(body).role);
  }

  @Get("conversations/:id/messages")
  messages(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.messages(user, id, MessagesQuery.parse(q ?? {}));
  }

  /** 201 with the message and upload tickets; 200 for a retry with the same clientId. */
  @Post("conversations/:id/messages")
  async send(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.svc.send(user, id, SendMessage.parse(body));
    void reply.status(r.created ? 201 : 200);
    return { message: r.message, uploads: r.uploads };
  }

  /** Marks the conversation read up to `messageId` (default: the newest) and records the view. */
  @Post("conversations/:id/read")
  @HttpCode(204)
  async read(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    await this.svc.markRead(user, id, MarkRead.parse(body ?? {}).messageId);
  }

  @Patch("messages/:messageId")
  edit(@CurrentUser() user: AuthedUser, @Param("messageId", ParseUUIDPipe) messageId: string, @Body() body: unknown) {
    return this.svc.editMessage(user, messageId, EditMessage.parse(body).body);
  }

  @Delete("messages/:messageId")
  @HttpCode(204)
  async deleteMessage(@CurrentUser() user: AuthedUser, @Param("messageId", ParseUUIDPipe) messageId: string): Promise<void> {
    await this.svc.deleteMessage(user, messageId);
  }

  /** Presigned GET (attachment, 60 s) for a clean file. POST so it carries the CSRF token. */
  @Post("attachments/:attachmentId/download")
  @HttpCode(200)
  download(@CurrentUser() user: AuthedUser, @Param("attachmentId", ParseUUIDPipe) attachmentId: string) {
    return this.svc.download(user, attachmentId);
  }
}
