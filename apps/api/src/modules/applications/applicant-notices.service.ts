import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APPLICATION_STATUS_LABELS, APP_INTERVIEW_LABELS, type ApplicationStatus } from "@eureka/shared";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { MAIL_PORT, type MailPort } from "../../platform/mail.js";

/** How often due notices are retried; a new notice is sent right after the commit that wrote it. */
const SWEEP_MS = 60_000;
const BATCH = 20;

interface NoticeRow {
  id: string; kind: "status" | "interview"; to_status: string | null; email: string; job_title: string; attempts: number;
  interview_type: string | null; interview_round: string | null; starts_at: Date | null; duration_minutes: number | null; meeting_link: string | null;
}

/**
 * Sends the applicant notices that application changes queue in the database (migration 0190): status
 * changes and scheduled interviews. A notice is written in the same transaction as the change, so it is
 * never lost; kick() sends it right after the commit, and a sweep every minute retries what failed,
 * with the backoff the claim applies. Delivery is at least once (a send that dies before it is marked
 * is sent again after the lease). The email never carries staff comments and greets without the name
 * (typed at sign-up by whoever created the account). Failures log the error class only: provider
 * messages can contain the recipient address.
 */
@Injectable()
export class ApplicantNoticesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("ApplicantNotices");
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly db: DbService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.kick(), SWEEP_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.drain();
  }

  /** Sends what is due now, in the background; one run at a time per process. */
  kick(): void {
    if (this.running) { this.again = true; return; }
    this.running = (async () => {
      do {
        this.again = false;
        try { while (await this.sendBatch() === BATCH); } catch (err) {
          this.log.warn(`applicant notices: claim failed (${(err as { name?: string })?.name ?? "error"})`);
        }
      } while (this.again);
    })().finally(() => { this.running = null; });
  }

  /** Resolves when the current run (if any) has finished; tests and shutdown wait on it. */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  private async sendBatch(): Promise<number> {
    const rows = (await this.db.system((c) =>
      c.query<NoticeRow>(`SELECT * FROM authz.applicant_notice_claim($1)`, [BATCH]))).rows;
    for (const r of rows) {
      const { subject, lines } = render(r);
      const text = `Hello,\n\n${lines.join("\n")}\n\nSign in to Eureka Careers for the details: ${new URL("/portal/applications", this.config.PUBLIC_BASE_URL).toString()}\n\n— Eureka Careers\n`;
      try {
        await this.mail.send({ to: r.email, subject, text });
        await this.db.system((c) => c.query(`SELECT authz.applicant_notice_sent($1)`, [r.id]));
      } catch (err) {
        this.log.warn(`applicant ${r.kind} email failed, attempt ${r.attempts} (${(err as { name?: string })?.name ?? "error"})`);
      }
    }
    return rows.length;
  }
}

function render(r: NoticeRow): { subject: string; lines: string[] } {
  if (r.kind === "status") {
    const label = APPLICATION_STATUS_LABELS[r.to_status as ApplicationStatus] ?? r.to_status;
    return {
      subject: `Your application for ${r.job_title}: ${label}`,
      lines: [`The status of your application for ${r.job_title} is now: ${label}.`],
    };
  }
  const label = (k: string | null) => (k === null ? "" : APP_INTERVIEW_LABELS[k] ?? k);
  const when = r.starts_at ? r.starts_at.toISOString().replace("T", " ").slice(0, 16) : "";
  return {
    subject: `Interview scheduled: ${r.job_title}`,
    lines: [
      `An interview for your application for ${r.job_title} has been scheduled.`,
      `Type: ${label(r.interview_type)}`, `Round: ${label(r.interview_round)}`,
      `When: ${when} UTC (${r.duration_minutes} minutes)`, ...(r.meeting_link ? [`Meeting link: ${r.meeting_link}`] : []),
    ],
  };
}
