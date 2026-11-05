import { ForbiddenException, Injectable } from "@nestjs/common";
import type pg from "pg";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { mapAdminError } from "./admin.errors.js";

/**
 * What every admin and team service shares (audit C-04): a transaction as the
 * user that maps the definer functions' error codes to contract errors, and the
 * audit writer for the same transaction.
 */
@Injectable()
export class AdminTx {
  constructor(private readonly db: DbService, readonly audit: AuditService) {}

  /** Runs fn as the user and maps database error codes to contract errors. */
  async run<T>(user: AuthedUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withUser(user.id, fn);
    } catch (err) {
      mapAdminError(err);
    }
  }
}

/** AD-2: no change to oneself (403 self_change); the definer functions re-check it. */
export function notSelf(user: AuthedUser, target: string | null | undefined): void {
  if (target && target === user.id) throw new ForbiddenException("self_change");
}
