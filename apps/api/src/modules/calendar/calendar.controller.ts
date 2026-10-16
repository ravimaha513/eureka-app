import { Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { can } from "@eureka/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { CALENDAR_PROVIDER, DevCalendarProvider, type CalendarProvider } from "./calendar.provider.js";
import { BusyQuery, CallbackQuery, ConnectQuery } from "./calendar.schemas.js";
import { CALENDAR_STATE_COOKIE, CalendarService } from "./calendar.service.js";

/**
 * The support calendar connection (docs/alerts-calendar-birthdays.md CA-1..CA-3):
 * status, the OAuth round trip (top-level navigation, so the session cookie
 * travels with it) and disconnect. calendar:block holders only, except the
 * free/busy read (CA-7), open to interview:create holders too.
 */
@Controller("api/v1/calendar/support")
export class CalendarController {
  constructor(private readonly svc: CalendarService, @Inject(CONFIG) private readonly config: AppConfig, @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider) {}

  @Get()
  @RequirePermission("calendar:block")
  status(@CurrentUser() user: AuthedUser) {
    return this.svc.status(user);
  }

  /** Starts the authorisation: a signed state cookie, then the provider's consent page. */
  @Get("connect")
  @RequirePermission("calendar:block")
  connect(@CurrentUser() user: AuthedUser, @Query() query: unknown, @Res() reply: FastifyReply): void {
    if (this.config.CALENDAR_MODE === "disabled") throw new NotFoundException();
    const { calendarId } = ConnectQuery.parse(query);
    const { cookie, state } = this.svc.signState(calendarId, user.id);
    void reply
      .setCookie(CALENDAR_STATE_COOKIE, cookie, {
        httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "lax", path: "/api/v1/calendar/support", maxAge: 600,
      })
      .redirect(this.svc.authUrl(state), 302);
  }

  @Get("callback")
  @RequirePermission("calendar:block")
  async callback(@CurrentUser() user: AuthedUser, @Query() query: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (this.config.CALENDAR_MODE === "disabled") throw new NotFoundException();
    const q = CallbackQuery.parse(query);
    const { calendarId } = this.svc.readState(req.cookies?.[CALENDAR_STATE_COOKIE], q.state, user.id);
    await this.svc.complete(user, q.code, calendarId);
    void reply.clearCookie(CALENDAR_STATE_COOKIE, { path: "/api/v1/calendar/support" })
      .redirect(`${new URL(this.config.PUBLIC_BASE_URL).origin}/?calendar=connected`, 302);
  }

  @Post("disconnect")
  @HttpCode(200)
  @RequirePermission("calendar:block")
  disconnect(@CurrentUser() user: AuthedUser) {
    return this.svc.disconnect(user);
  }

  /**
   * CA-7: busy periods of the support calendar in a window of up to 31 days, for
   * calendar:block or interview:create holders (a scheduling aid; it never blocks
   * a save). Intervals only; nothing cached, nothing audited. The permission is
   * checked here because RequirePermission takes one permission.
   */
  @Get("busy")
  busy(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    if (!can(user.access, "calendar:block") && !can(user.access, "interview:create")) throw new ForbiddenException("Not permitted");
    if (this.config.CALENDAR_MODE === "disabled") return { connected: false, available: false, busy: [] };
    const { from, to } = BusyQuery.parse(query);
    return this.svc.busy(user, from, to);
  }

  /** Development only (dev provider): the events the fake calendar holds, for checking a block by hand. */
  @Get("dev/events")
  @RequirePermission("calendar:block")
  devEvents() {
    if (this.config.NODE_ENV === "production" || !(this.provider instanceof DevCalendarProvider)) throw new NotFoundException();
    return { items: [...this.provider.events.values()].map((e) => ({ ...e, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString() })) };
  }
}

/** Blocking and releasing the support calendar for one interview (CA-4..CA-6). */
@Controller("api/v1/interviews/:id/calendar-block")
export class InterviewCalendarController {
  constructor(private readonly svc: CalendarService) {}

  @Get()
  @RequirePermission("interview:read")
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.blockStatus(user, id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("calendar:block")
  block(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.block(user, id);
  }

  @Post("release")
  @HttpCode(200)
  @RequirePermission("calendar:block")
  release(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.release(user, id);
  }
}
