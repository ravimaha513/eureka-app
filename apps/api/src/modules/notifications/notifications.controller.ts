import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { ListQuery, ReadAll } from "./notifications.schemas.js";
import { NotificationsService } from "./notifications.service.js";

/**
 * The signed-in user's own inbox (every user has one, so no permission beyond
 * a session; writes need the CSRF token like every other write).
 */
@Controller("api/v1/notifications")
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, ListQuery.parse(q ?? {}));
  }

  @Get("unread-count")
  unreadCount(@CurrentUser() user: AuthedUser) {
    return this.svc.unreadCount(user);
  }

  /** Body ignored: the row comes from the URL, the recipient from the session. */
  @Post(":id/read")
  @HttpCode(204)
  async read(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.mark(user, id, true);
  }

  /** Body ignored, as for :id/read. */
  @Post(":id/unread")
  @HttpCode(204)
  async unread(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.mark(user, id, false);
  }

  @Post("read-all")
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.readAll(user, ReadAll.parse(body ?? {}));
  }
}
