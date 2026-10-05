import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../../platform/audit.service.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { MAIL_PORT, type MailPort } from "../../platform/mail.js";
import { PortalSessionService } from "../../platform/portal-session.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import type { RequestLink, SignUp } from "./portal.schemas.js";

/**
 * Applicant sign-up and sign-in with one-time email links (docs/jobs-portal-api.md
 * JP-10..JP-14, migration 0061). No passwords. Every answer to sign-up and
 * link requests is the same whether or not the email has an account, and the
 * email is sent after the response is decided (not awaited), so neither the
 * body nor the status reveals an account.
 */
export const LINK_TTL_MINUTES = 15;
/** Links per applicant per hour (database) and requests per email per 15 minutes (memory). */
export const LINKS_PER_HOUR = 5;
export const REQUESTS_PER_EMAIL = 5;
/** Sign-up and link requests per client address per 15 minutes; link redemptions likewise. */
export const REQUESTS_PER_IP = 20;
export const VERIFY_PER_IP = 30;

export const GENERIC_SENT = "If the address can receive email, we sent a sign-in link to it. It works once and expires in 15 minutes.";

const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const sha256 = (v: string) => createHash("sha256").update(v).digest();
/** Compared against when no link is open, so a miss costs the same as a hit. */
const DUMMY_HASH = sha256("eureka-portal-no-such-link");

@Injectable()
export class PortalAuthService {
  private readonly log = new Logger("PortalAuth");
  private readonly ipLimiter = new RateLimiter(REQUESTS_PER_IP, 15 * 60_000);
  private readonly emailLimiter = new RateLimiter(REQUESTS_PER_EMAIL, 15 * 60_000);
  private readonly verifyLimiter = new RateLimiter(VERIFY_PER_IP, 15 * 60_000);

  constructor(
    private readonly db: DbService,
    private readonly sessions: PortalSessionService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  private takeIp(limiter: RateLimiter, ip: string) {
    if (!limiter.take(`ip:${ip}`)) throw new HttpException("Too many requests; try again later", HttpStatus.TOO_MANY_REQUESTS);
  }

  /** false when this email asked too often recently (the caller still gets the generic answer). */
  private takeEmail(email: string): boolean {
    return this.emailLimiter.take(`email:${sha256(email.toLowerCase()).toString("hex")}`);
  }

  private newLink() {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    return { id, secret, hash: sha256(secret), url: `${new URL("/portal/verify", this.config.PUBLIC_BASE_URL).toString()}#token=${id}.${secret}` };
  }

  /** Fire and forget: the response never waits for (or reveals) the email. Content is never logged. */
  private sendLater(to: string, subject: string, text: string, kind: string) {
    void this.mail.send({ to, subject, text }).catch((err: Error) => this.log.warn(`portal ${kind} email failed: ${err.message}`));
  }

  private linkText(first: string, url: string, lead: string) {
    return `Hi ${first},\n\n${lead}\n\n${url}\n\nThe link works once and expires in ${LINK_TTL_MINUTES} minutes. `
      + "If you did not ask for it, you can ignore this email: nobody can sign in without the link.\n\n— Eureka Careers\n";
  }

  async signUp(body: SignUp, ip: string) {
    this.takeIp(this.ipLimiter, ip);
    if (!this.takeEmail(body.email)) return { message: GENERIC_SENT };
    const link = this.newLink();
    const r = await this.db.system(async (c) => {
      const row = (await c.query<{ applicant_id: string; first_name: string; existing: boolean; issued: boolean }>(
        `SELECT * FROM authz.portal_sign_up($1, $2, $3, $4, $5, $6, $7, $8)`,
        [body.firstName, body.lastName, body.email, body.phone, link.id, link.hash, LINK_TTL_MINUTES, LINKS_PER_HOUR])).rows[0];
      if (row) {
        await this.audit.record(c, { actorId: row.applicant_id, action: "applicant.sign_up", entityType: "applicant", entityId: row.applicant_id,
          changes: { existing: row.existing, linkIssued: row.issued } });
      }
      return row;
    });
    if (r?.issued) {
      this.sendLater(body.email, r.existing ? "Sign in to Eureka Careers" : "Confirm your email for Eureka Careers",
        this.linkText(r.first_name, link.url, r.existing
          ? "You already have a Eureka Careers account. Use this link to sign in:"
          : "Thanks for creating a Eureka Careers account. Use this link to confirm your email and sign in:"), "sign-up");
    }
    return { message: GENERIC_SENT };
  }

  async requestLink(body: RequestLink, ip: string) {
    this.takeIp(this.ipLimiter, ip);
    if (!this.takeEmail(body.email)) return { message: GENERIC_SENT };
    const link = this.newLink();
    const r = await this.db.system(async (c) => (await c.query<{ applicant_id: string; first_name: string; issued: boolean }>(
      `SELECT * FROM authz.portal_issue_link($1, $2, $3, $4, $5)`, [body.email, link.id, link.hash, LINK_TTL_MINUTES, LINKS_PER_HOUR])).rows[0]);
    if (r?.issued) this.sendLater(body.email, "Sign in to Eureka Careers", this.linkText(r.first_name, link.url, "Use this link to sign in to Eureka Careers:"), "sign-in");
    return { message: GENERIC_SENT };
  }

  /** Redeems a link (once): returns the new session id for the cookie. 400 `link_invalid` for anything else. */
  async verify(token: string, ip: string): Promise<{ sid: string; applicantId: string }> {
    this.takeIp(this.verifyLimiter, ip);
    const m = TOKEN.exec(token);
    const invalid = () => new BadRequestException("link_invalid");
    if (!m) throw invalid();
    const [, id, secret] = m as unknown as [string, string, string];
    const given = sha256(secret);
    const stored = await this.db.system(async (c) =>
      (await c.query<{ h: Buffer | null }>(`SELECT authz.portal_link_hash($1) AS h`, [id])).rows[0]?.h ?? null);
    const match = timingSafeEqual(given, stored && stored.length === 32 ? stored : DUMMY_HASH);
    if (!stored || !match) throw invalid();
    const { sid, hash } = PortalSessionService.newSessionId();
    const applicantId = await this.db.system(async (c) => {
      const who = (await c.query<{ id: string | null }>(`SELECT authz.portal_redeem_link($1, $2, $3, $4) AS id`,
        [id, given, hash, this.config.PORTAL_SESSION_HOURS])).rows[0]?.id ?? null;
      if (who) await this.audit.record(c, { actorId: who, action: "applicant.signed_in", entityType: "applicant", entityId: who });
      return who;
    });
    if (!applicantId) throw invalid();
    return { sid, applicantId };
  }
}
