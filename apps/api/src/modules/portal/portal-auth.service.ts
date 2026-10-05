import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../../platform/audit.service.js";
import { ipKey } from "../../platform/client-ip.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { MAIL_PORT, type MailPort } from "../../platform/mail.js";
import { PortalSessionService } from "../../platform/portal-session.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import type { RequestLink, SignUp } from "./portal.schemas.js";

/**
 * Applicant sign-up and sign-in with one-time email links (docs/jobs-portal-api.md
 * JP-10..JP-14, migration 0061). No passwords.
 *
 * Every answer to sign-up and link requests is the same whether or not the
 * email has an account, AND the answer does not wait for the work: the
 * database call and the mail run after the reply (deferred), so neither the
 * body, the status nor the latency depends on whether the address is known.
 * Only the per-client-address limiter (429) is synchronous: it says nothing
 * about accounts.
 *
 * Limits: per client address in memory per task (IPv6 keyed by /64, bounded
 * map); everything per email or global is in the database, shared by all
 * tasks and counted only for links actually issued, so asking for a link for
 * somebody else's address cannot lock them out: one link per 60 s and 10 an
 * hour per applicant, and database-wide hourly caps on links and on new accounts.
 */
export const LINK_TTL_MINUTES = 15;
export const LINKS_PER_HOUR = 10;
export const LINK_COOLDOWN_SECONDS = 60;
export const GLOBAL_LINKS_PER_HOUR = 600;
export const GLOBAL_SIGNUPS_PER_HOUR = 200;
/** Sign-up and link requests per client address (/64 for IPv6) per 15 minutes; link redemptions likewise. */
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
  private readonly verifyLimiter = new RateLimiter(VERIFY_PER_IP, 15 * 60_000);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly sessions: PortalSessionService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  private takeIp(limiter: RateLimiter, ip: string) {
    if (!limiter.take(`ip:${ipKey(ip)}`)) throw new HttpException("Too many requests; try again later", HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Runs `work` after the reply; failures are logged by class only (messages can carry addresses). */
  private defer(kind: string, work: () => Promise<void>) {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch((err: unknown) => this.log.warn(`portal ${kind} failed (${(err as { name?: string })?.name ?? "error"})`))
      .finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  /** Waits for deferred work (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private newLink() {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    return { id, secret, hash: sha256(secret), url: `${new URL("/portal/verify", this.config.PUBLIC_BASE_URL).toString()}#token=${id}.${secret}` };
  }

  /**
   * The mail goes to an address nobody has verified yet, so it contains no text the requester chose: a fixed
   * greeting, never the name typed into the form.
   */
  private linkText(url: string, lead: string) {
    return `Hello,\n\n${lead}\n\n${url}\n\nThe link works once and expires in ${LINK_TTL_MINUTES} minutes. `
      + "If you did not ask for it, you can ignore this email: nobody can sign in without the link.\n\n— Eureka Careers\n";
  }

  private async send(to: string, subject: string, text: string, kind: string) {
    try { await this.mail.send({ to, subject, text }); } catch (err) {
      this.log.warn(`portal ${kind} email failed (${(err as { name?: string })?.name ?? "error"})`); // never the message: it can name the recipient
    }
  }

  async signUp(body: SignUp, ip: string) {
    this.takeIp(this.ipLimiter, ip);
    this.defer("sign-up", async () => {
      const link = this.newLink();
      const r = await this.db.system(async (c) => {
        const row = (await c.query<{ applicant_id: string; existing: boolean; issued: boolean }>(
          `SELECT * FROM authz.portal_sign_up($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [body.firstName, body.lastName, body.email, body.phone, link.id, link.hash, LINK_TTL_MINUTES, LINKS_PER_HOUR,
            LINK_COOLDOWN_SECONDS, GLOBAL_LINKS_PER_HOUR, GLOBAL_SIGNUPS_PER_HOUR])).rows[0];
        if (row) {
          await this.audit.record(c, { actorId: row.applicant_id, action: "applicant.sign_up", entityType: "applicant", entityId: row.applicant_id,
            changes: { existing: row.existing, linkIssued: row.issued } });
        }
        return row;
      });
      if (r?.issued) {
        await this.send(body.email, r.existing ? "Sign in to Eureka Careers" : "Confirm your email for Eureka Careers",
          this.linkText(link.url, r.existing
            ? "Someone asked to sign in to a Eureka Careers account with this address. Use this link to sign in:"
            : "Someone used this address to create a Eureka Careers account. Use this link to confirm your email and sign in:"), "sign-up");
      }
    });
    return { message: GENERIC_SENT };
  }

  async requestLink(body: RequestLink, ip: string) {
    this.takeIp(this.ipLimiter, ip);
    this.defer("request-link", async () => {
      const link = this.newLink();
      const r = await this.db.system(async (c) => (await c.query<{ applicant_id: string; issued: boolean }>(
        `SELECT * FROM authz.portal_issue_link($1, $2, $3, $4, $5, $6, $7)`,
        [body.email, link.id, link.hash, LINK_TTL_MINUTES, LINKS_PER_HOUR, LINK_COOLDOWN_SECONDS, GLOBAL_LINKS_PER_HOUR])).rows[0]);
      if (r?.issued) await this.send(body.email, "Sign in to Eureka Careers", this.linkText(link.url, "Use this link to sign in to Eureka Careers:"), "sign-in");
    });
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
