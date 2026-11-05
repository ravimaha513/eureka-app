import { Controller, Get, Inject } from "@nestjs/common";
import { capabilities } from "@eureka/shared";
import { AllowPasswordChange, CurrentUser, SelfService, type AuthedUser } from "../../platform/auth.guard.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { SessionService } from "../../platform/session.service.js";

@SelfService()
@Controller("api/v1/me")
export class MeController {
  constructor(
    private readonly db: DbService, private readonly sessions: SessionService, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Identity, roles and capabilities for the web app's navigation (presentation only). */
  @Get()
  @AllowPasswordChange()
  async me(@CurrentUser() user: AuthedUser) {
    const profile = await this.db.withUser(user.id, async (c) =>
      (await c.query<{ email: string; display_name: string }>(
        `SELECT email, display_name FROM eureka.app_user WHERE id = $1`, [user.id])).rows[0]);
    // Read with the session by the AuthGuard (authz.request_context, audit F-03); no second transaction.
    const mustChangePassword = this.config.PASSWORD_LOGIN === "on" && user.mustChangePassword === true;
    return {
      id: user.id,
      email: profile?.email,
      displayName: profile?.display_name,
      roles: user.access.roles.map((r) => ({ key: r.role, label: r.label ?? r.role, locationId: r.locationId ?? null })),
      capabilities: capabilities(user.access),
      mustChangePassword,
      csrfToken: this.sessions.csrfToken(user.sessionHash),
    };
  }
}
