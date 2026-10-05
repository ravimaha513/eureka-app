import { Logger } from "@nestjs/common";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { AppConfig } from "./config.js";

/**
 * Outgoing email from the API (jobs-portal: applicant sign-in links and
 * application notices). The worker keeps its own transports for staff email
 * (worker/feedback-mail.ts); this port is for messages the API must send
 * while handling a request.
 *
 *   dev: an in-memory mailbox (the last 200 messages), readable through the
 *        development-only GET /api/portal/dev/mailbox, and written to the API
 *        log in development (never in production: config refuses dev mail there).
 *   ses: Amazon SES v2 from PORTAL_FROM_EMAIL (the IAM policy allows only that
 *        sender). Message content is never logged.
 */
export interface OutgoingMail { to: string; subject: string; text: string }
export interface MailPort { readonly kind: "dev" | "ses"; send(mail: OutgoingMail): Promise<void> }
export const MAIL_PORT = Symbol("MAIL_PORT");

export interface DevMessage extends OutgoingMail { at: string }

export class DevMailbox implements MailPort {
  readonly kind = "dev" as const;
  private readonly messages: DevMessage[] = [];
  private readonly log = new Logger("DevMailbox");
  constructor(private readonly logToConsole: boolean) {}

  async send(mail: OutgoingMail): Promise<void> {
    this.messages.push({ ...mail, at: new Date().toISOString() });
    if (this.messages.length > 200) this.messages.shift();
    if (this.logToConsole) this.log.log(`[dev mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
  }

  /** Newest first; only messages to `to` (case-insensitive). */
  inbox(to: string): DevMessage[] {
    const t = to.toLowerCase();
    return this.messages.filter((m) => m.to.toLowerCase() === t).reverse();
  }
}

export class SesMailPort implements MailPort {
  readonly kind = "ses" as const;
  private readonly client: Pick<SESv2Client, "send">;
  constructor(region: string | undefined, private readonly from: string, client?: Pick<SESv2Client, "send">) {
    this.client = client ?? new SESv2Client({ region, maxAttempts: 2, requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 } });
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.client.send(new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [mail.to] },
        Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Body: { Text: { Data: mail.text, Charset: "UTF-8" } } } },
      }));
    } catch (err) {
      // Provider messages can contain the recipient; only the error class and status leave here.
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      throw new Error(`Email delivery failed (${e?.name ?? "error"} ${e?.$metadata?.httpStatusCode ?? ""})`.trim());
    }
  }
}

export function createMailPort(config: AppConfig): MailPort {
  if (config.PORTAL_MAIL_MODE === "ses") return new SesMailPort(config.AWS_REGION, config.PORTAL_FROM_EMAIL!);
  return new DevMailbox(config.NODE_ENV === "development");
}
