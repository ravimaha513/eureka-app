import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { CurrentUser, type AuthedUser } from "../../platform/auth.guard.js";
import { PreferenceType, PreferenceUpdate, ProfileUpdate, parseVersion } from "./settings.schemas.js";
import { SettingsService } from "./settings.service.js";

/**
 * Settings & Preferences of the signed-in user (docs/interviews-settings-api.md
 * ST-1). Every user has them, so no permission beyond a session; writes need
 * the CSRF token like every other write. Nothing here reads or changes
 * another user's data.
 */
@Controller("api/v1/settings")
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get("profile")
  profile(@CurrentUser() user: AuthedUser) {
    return this.svc.profile(user);
  }

  @Put("profile")
  updateProfile(@CurrentUser() user: AuthedUser, @Headers("if-match") ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.updateProfile(user, parseVersion(ifMatch), ProfileUpdate.parse(body));
  }

  @Get("notifications")
  preferences(@CurrentUser() user: AuthedUser) {
    return this.svc.preferences(user);
  }

  @Put("notifications/:type")
  setPreference(@CurrentUser() user: AuthedUser, @Param("type") type: string, @Body() body: unknown) {
    return this.svc.setPreference(user, PreferenceType.parse(type), PreferenceUpdate.parse(body).inApp);
  }

  @Get("sessions")
  sessions(@CurrentUser() user: AuthedUser) {
    return this.svc.sessions(user);
  }

  /** Body ignored: the session comes from the URL, the owner from the caller's session. */
  @Post("sessions/:id/revoke")
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.svc.revoke(user, id);
  }

  @Post("sessions/revoke-others")
  @HttpCode(200)
  revokeOthers(@CurrentUser() user: AuthedUser) {
    return this.svc.revokeOthers(user);
  }
}
