import { Controller, Get } from "@nestjs/common";
import { ROLE_LABELS, capabilities } from "@eureka/shared";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { SessionService } from "../../platform/session.service.js";

@Controller("api/v1/me")
export class MeController {
  constructor(private readonly db: DbService, private readonly sessions: SessionService) {}

  /** Identity, roles and capabilities for the web app's navigation (presentation only). */
  @Get()
  async me(@CurrentUser() user: AuthedUser) {
    const profile = await this.db.withUser(user.id, async (c) =>
      (await c.query<{ email: string; display_name: string }>(
        `SELECT email, display_name FROM eureka.app_user WHERE id = $1`, [user.id])).rows[0]);
    return {
      id: user.id,
      email: profile?.email,
      displayName: profile?.display_name,
      roles: user.access.roles.map((r) => ({ key: r.role, label: ROLE_LABELS[r.role], locationId: r.locationId ?? null })),
      capabilities: capabilities(user.access),
      csrfToken: this.sessions.csrfToken(user.sessionHash),
    };
  }
}
