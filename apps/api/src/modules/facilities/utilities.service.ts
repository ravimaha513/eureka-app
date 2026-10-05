import { randomUUID, timingSafeEqual } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import type pg from "pg";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { FIELD_CRYPTO, type FieldCrypto } from "../../platform/crypto/config.js";
import { DbService } from "../../platform/db.service.js";
import { requireStepUp } from "../../platform/step-up.js";
import { KINDS, covers, mapDbError, requireVersion, type OwnerKind } from "./facilities.common.js";
import type { UtilityCreate, UtilityType, UtilityUpdate } from "./facilities.schemas.js";
import { OwnersService } from "./owners.service.js";

/** Enforced in the database across API tasks (authz.utility_password_reveal, migration 0054). */
export const UTILITY_REVEALS_PER_MINUTE = 20;
export const UTILITY_REVEALS_PER_DAY = 200;

interface UtilityRow {
  id: string;
  company_id: string | null;
  facility_id: string | null;
  location_id: string;
  utility_type: UtilityType;
  service_provider: string;
  account_number: string | null;
  website_url: string | null;
  username: string | null;
  has_password: boolean;
  status: "active" | "inactive";
  notes: string | null;
  row_version: number;
}

/** Never the password or its ciphertext (the app role has no column privilege on them). */
const SELECT = `SELECT u.id, u.company_id, u.facility_id, coalesce(c.location_id, f.location_id) AS location_id, u.utility_type,
    u.service_provider, u.account_number, u.website_url, u.username, u.has_password, u.status, u.notes, u.row_version
  FROM eureka.utility u
  LEFT JOIN eureka.company c ON c.id = u.company_id
  LEFT JOIN eureka.facility f ON f.id = u.facility_id`;

const present = (r: UtilityRow) => ({
  id: r.id,
  utilityType: r.utility_type,
  serviceProvider: r.service_provider,
  accountNumber: r.account_number,
  websiteUrl: r.website_url,
  username: r.username,
  hasPassword: r.has_password,
  status: r.status,
  notes: r.notes,
  rowVersion: r.row_version,
});

const FIELDS = ["utilityType", "serviceProvider", "accountNumber", "websiteUrl", "username", "status", "notes"] as const;
const COLUMN = {
  utilityType: "utility_type", serviceProvider: "service_provider", accountNumber: "account_number", websiteUrl: "website_url",
  username: "username", status: "status", notes: "notes",
} as const satisfies Record<(typeof FIELDS)[number], keyof UtilityRow>;

/**
 * Utilities of a company or facility (docs/facilities-api.md, migration 0054).
 * Read: utility:read over the owner's location (RLS utility_read) and the
 * owner readable; writes: utility:manage, through authz.utility_create /
 * utility_update. The portal password is encrypted here (field class
 * utility_password, bound to the utility id) with its integrity MAC before it
 * reaches the database, and decrypted only for an audited reveal with a live
 * step-up; it never appears in a list, a log, audit_event or outbox_event.
 */
@Injectable()
export class UtilitiesService {
  private readonly log = new Logger("Utilities");

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly owners: OwnersService,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto,
  ) {}

  private async seal(c: pg.PoolClient, id: string, password: string) {
    const sealed = await this.crypto.cipher.encrypt(c, { cls: "utility_password", rowId: id }, password);
    return { ...sealed, mac: await this.crypto.blindIndex.stretchedIntegrityMac("utility_password", id, password) };
  }

  /** The utility as the caller sees it (RLS); 404 when not visible. */
  private async load(c: pg.PoolClient, id: string): Promise<UtilityRow> {
    const r = (await c.query<UtilityRow>(`${SELECT} WHERE u.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  async list(user: AuthedUser, kind: OwnerKind, ownerId: string) {
    return this.db.withUser(user.id, async (c) => {
      const o = await this.owners.load(c, kind, ownerId);
      const { rows } = await c.query<UtilityRow>(
        `${SELECT} WHERE u.${KINDS[kind].fk} = $1 ORDER BY u.utility_type, lower(u.service_provider), u.id`, [ownerId]);
      return {
        items: rows.map(present),
        actions: { manage: covers(user.access, "utility:manage", o.location_id), revealPassword: covers(user.access, "utility.secret:read", o.location_id) },
      };
    });
  }

  /** The body is parsed after the scope check, so callers without rights get 403/404, not 422. */
  async create(user: AuthedUser, kind: OwnerKind, ownerId: string, parse: () => UtilityCreate) {
    return this.db.withUser(user.id, async (c) => {
      const o = await this.owners.load(c, kind, ownerId);
      if (!covers(user.access, "utility:read", o.location_id)) throw new NotFoundException();
      if (!covers(user.access, "utility:manage", o.location_id)) throw new ForbiddenException("Not permitted");
      const body = parse();
      const id = randomUUID();
      const sealed = body.password ? await this.seal(c, id, body.password) : null;
      await c.query(`SELECT authz.utility_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, kind, ownerId, body.utilityType, body.serviceProvider, body.accountNumber ?? null, body.websiteUrl ?? null,
          body.username ?? null, sealed?.enc ?? null, sealed?.keyId ?? null, sealed?.mac ?? null, body.notes ?? null])
        .catch(mapDbError);
      // Rule 5: never the password, account number, username or notes.
      await this.audit.record(c, {
        actorId: user.id, action: "utility.created", entityType: "utility", entityId: id,
        changes: { ownerKind: kind, ownerId, utilityType: body.utilityType, passwordSet: sealed !== null },
      });
      return present(await this.load(c, id));
    });
  }

  async update(user: AuthedUser, id: string, expectedVersion: number | null, parse: () => UtilityUpdate) {
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.load(c, id);
      if (!covers(user.access, "utility:manage", cur.location_id)) throw new ForbiddenException("Not permitted");
      const body = parse();
      requireVersion(expectedVersion, cur.row_version);
      const next = Object.fromEntries(FIELDS.map((f) => [f, body[f] !== undefined ? body[f] : cur[COLUMN[f]]])) as Record<(typeof FIELDS)[number], unknown>;
      const setPassword = body.password !== undefined;
      const sealed = body.password ? await this.seal(c, id, body.password) : null;
      const version = (await c.query<{ v: number }>(
        `SELECT authz.utility_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) AS v`,
        [id, expectedVersion, next.utilityType, next.serviceProvider, next.accountNumber, next.websiteUrl, next.username,
          setPassword, sealed?.enc ?? null, sealed?.keyId ?? null, sealed?.mac ?? null, next.status, next.notes])
        .catch(mapDbError)).rows[0]!.v;
      const changed = FIELDS.filter((f) => body[f] !== undefined && (body[f] ?? null) !== cur[COLUMN[f]]);
      await this.audit.record(c, {
        actorId: user.id, action: "utility.updated", entityType: "utility", entityId: id,
        changes: {
          changed, rowVersion: version,
          ...(changed.includes("utilityType") ? { utilityType: next.utilityType } : {}),
          ...(changed.includes("status") ? { status: next.status } : {}),
          ...(setPassword ? { passwordChanged: true, passwordSet: sealed !== null } : {}),
        },
      });
      return present(await this.load(c, id));
    });
  }

  /**
   * The portal password in clear (utility.secret:read over the location,
   * restricted). Needs a live step-up grant of this session (requireStepUp,
   * the same gate as the work-authorization reveal and restricted documents).
   * authz.utility_password_reveal re-checks scope and the step-up, enforces
   * the reveal limits across API tasks and writes the audit row (ids only)
   * in this transaction before anything is decrypted. The value must match
   * its integrity MAC (FE-3a); a mismatch is audited and alerted, and nothing
   * is returned.
   */
  async reveal(user: AuthedUser, id: string) {
    const out = await this.db.withUser(user.id, async (c) => {
      const r = await this.load(c, id);
      if (!covers(user.access, "utility.secret:read", r.location_id)) throw new ForbiddenException("Not permitted");
      if (!r.has_password) throw new ConflictException("no_password");
      await requireStepUp(c, user);
      const s = (await c.query<{ enc: Buffer; mac: Buffer }>(`SELECT enc, mac FROM authz.utility_password_reveal($1, $2)`, [id, user.sessionHash])
        .catch(mapDbError)).rows[0]!;
      const password = await this.crypto.cipher.decrypt(c, { cls: "utility_password", rowId: id }, s.enc);
      const expected = await this.crypto.blindIndex.stretchedIntegrityMac("utility_password", id, password);
      if (s.mac.length !== expected.length || !timingSafeEqual(s.mac, expected)) {
        // Committed (not thrown inside the transaction) so the evidence stays.
        await this.audit.record(c, { actorId: user.id, action: "utility.integrity_failed", entityType: "utility", entityId: id });
        return null;
      }
      return { password };
    });
    if (!out) {
      this.log.error(JSON.stringify({ msg: "utility password failed its integrity check", utilityId: id, alert: true }));
      throw new InternalServerErrorException("integrity_check_failed");
    }
    return out;
  }
}
