import { Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Put, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit.service.js";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { BirthdayUpdate } from "./birthdays.schemas.js";

interface StaffRow {
  id: string; display_name: string; email: string; designation: string | null; location: string | null;
  roles: string[] | null; birth_month: number | null; birth_day: number | null;
}

/**
 * Staff birthdays for HR (interview-alerts package, migration 0087;
 * docs/alerts-calendar-birthdays.md BD-2): the active staff directory with
 * each person's birthday (month and day), written through
 * authz.set_staff_birthday (staff.birthday:manage at org scope). Birthdays
 * are read under the staff_profile policy (own row or staff.contact:read).
 */
@Injectable()
export class StaffBirthdaysService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async list(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<StaffRow>(
        `SELECT u.id, u.display_name, u.email::text AS email, u.designation, l.name AS location,
                ARRAY(SELECT r.label FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
                       WHERE ur.user_id = u.id AND ur.valid @> now() ORDER BY r.label) AS roles,
                p.birth_month, p.birth_day
           FROM eureka.app_user u
           LEFT JOIN eureka.location l ON l.id = u.primary_location_id
           LEFT JOIN eureka.staff_profile p ON p.user_id = u.id
          WHERE u.status = 'active' ORDER BY u.display_name, u.id LIMIT 2000`);
      return {
        items: rows.map((r) => ({
          id: r.id, name: r.display_name, email: r.email, designation: r.designation, location: r.location,
          roles: r.roles ?? [],
          birthday: r.birth_month !== null && r.birth_day !== null ? { month: r.birth_month, day: r.birth_day } : null,
        })),
      };
    });
  }

  async set(user: AuthedUser, userId: string, birthday: { month: number; day: number } | null) {
    await this.db.withUser(user.id, async (c) => {
      try {
        await c.query("SELECT authz.set_staff_birthday($1, $2, $3)", [userId, birthday?.month ?? null, birthday?.day ?? null]);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P0002") throw new NotFoundException();
        if (e.code === "42501") throw new ForbiddenException("Not permitted");
        if (e.code === "23514") throw new UnprocessableEntityException("invalid_birthday");
        throw err;
      }
      // Whether a birthday is on file, never the date.
      await this.audit.record(c, { actorId: user.id, action: "staff_birthday.updated", entityType: "app_user", entityId: userId, changes: { birthdaySet: birthday !== null } });
    });
    return { id: userId, birthday };
  }
}

@Controller("api/v1/staff")
export class StaffBirthdaysController {
  constructor(private readonly svc: StaffBirthdaysService) {}

  @Get("birthdays")
  @RequirePermission("staff.birthday:manage")
  list(@CurrentUser() user: AuthedUser) {
    return this.svc.list(user);
  }

  @Put(":id/birthday")
  @RequirePermission("staff.birthday:manage")
  set(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.set(user, id, BirthdayUpdate.parse(body).birthday);
  }
}
