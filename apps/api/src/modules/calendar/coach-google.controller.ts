import { Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser, SelfService, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { ApiQuery } from "../../platform/http/api-doc.js";
import { CalendarService } from "./calendar.service.js";
import { CoachCalendarQuery } from "./coach-calendar.schemas.js";
import { COACH_GOOGLE_PURPOSE, CoachGoogleService } from "./coach-google.service.js";

const COOKIE = "eureka_coach_google";
const COOKIE_PATH = "/api/v1/coach-calendar/google";
/** Google sends `error` instead of `code` when someone cancels; it also adds scope, authuser, prompt. */
const GoogleCallbackQuery = z.object({
  code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional(), state: z.string().min(1).max(200),
}).passthrough();

/**
 * A coach's own Google Calendar on the coach grid (docs/coach-calendar-api.md CC-6..CC-8). Self-service:
 * the database decides who may connect (coaches) and whose events a caller may read (the grants).
 */
@Controller("api/v1/coach-calendar/google")
export class CoachGoogleController {
  private readonly log = new Logger("CoachGoogle");
  constructor(
    private readonly svc: CoachGoogleService, private readonly calendar: CalendarService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private back(result: string): string {
    return `${new URL(this.config.PUBLIC_BASE_URL).origin}/coach-calendar?google=${result}`;
  }

  /** CC-6 */
  @ApiQuery(CoachCalendarQuery)
  @SelfService()
  @Get()
  events(@CurrentUser() user: AuthedUser, @Query() query: unknown) {
    return this.svc.events(user, query);
  }

  /** CC-7: top-level navigation, so the session cookie travels with it. */
  @SelfService()
  @Get("connect")
  async connect(@CurrentUser() user: AuthedUser, @Res() reply: FastifyReply): Promise<void> {
    if (this.config.CALENDAR_MODE === "disabled") throw new NotFoundException();
    const { cookie, url } = await this.svc.start(user);
    void reply
      .setCookie(COOKIE, cookie, { httpOnly: true, secure: this.config.NODE_ENV === "production", sameSite: "lax", path: COOKIE_PATH, maxAge: 600 })
      .redirect(url, 302);
  }

  /** CC-7 */
  @ApiQuery(GoogleCallbackQuery)
  @SelfService()
  @Get("callback")
  async callback(@CurrentUser() user: AuthedUser, @Query() query: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    if (this.config.CALENDAR_MODE === "disabled") throw new NotFoundException();
    const q = GoogleCallbackQuery.parse(query);
    const { calendarId: purpose } = this.calendar.readState(req.cookies?.[COOKIE], q.state, user.id);
    if (purpose !== COACH_GOOGLE_PURPOSE) throw new ForbiddenException("calendar_state_mismatch");
    let result = "cancelled";
    if (q.code) {
      try {
        await this.svc.complete(user, q.code);
        result = "connected";
      } catch (e) {
        const reason = (e as { message?: string }).message;
        result = reason === "wrong_account" || reason === "scope_missing" ? reason : "failed";
        // The error class and any HTTP status only: messages can name an account.
        if (result === "failed") this.log.warn(`connect failed: ${(e as Error)?.name ?? "Error"} ${/\((\d{3})\)/.exec(String(reason))?.[1] ?? ""}`.trim());
      }
    }
    void reply.clearCookie(COOKIE, { path: COOKIE_PATH }).redirect(this.back(result), 302);
  }

  /** CC-8 */
  @SelfService()
  @Delete("connection")
  @HttpCode(204)
  async disconnect(@CurrentUser() user: AuthedUser) {
    await this.svc.disconnect(user);
  }
}
