import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
export interface Mail { id: string; to: string; subject: string; text: string }
export interface MailTransport { send(mail: Mail, signal: AbortSignal): Promise<void> }
export class LocalMail implements MailTransport {
  constructor(private readonly directory: string) {}
  async send(mail: Mail, signal: AbortSignal) {
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, `${mail.id}.json`), JSON.stringify(mail, null, 2), { mode: 0o600 });
  }
}
export class SesMail implements MailTransport {
  private readonly client: SESv2Client;
  constructor(region: string, private readonly from: string) {
    this.client = new SESv2Client({ region, maxAttempts: 1, requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 } });
  }
  async send(mail: Mail, signal: AbortSignal) {
    try {
      await this.client.send(new SendEmailCommand({ FromEmailAddress: this.from,
        Destination: { ToAddresses: [mail.to] }, Content: { Simple: {
          Subject: { Data: mail.subject, Charset: "UTF-8" }, Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
        } }, EmailTags: [{ Name: "delivery", Value: mail.id }],
      }), { abortSignal: signal });
    } catch { throw new Error("Feedback email delivery failed"); } // provider errors can contain recipient details
  }
}
/** Persist only an AEAD-encrypted retry copy. Validation uses a separate SHA-256 hash.
 * The worker-only key is not stored in PostgreSQL. Ciphertext is erased after send/use.
 */
export function encryptToken(token: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptToken(value: string, key: string) {
  const data = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
}
