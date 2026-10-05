import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { DevMailbox, SesMailPort, createMailPort } from "./mail.js";

const prod = {
  NODE_ENV: "production", AUTH_MODE: "google", SESSION_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x@y/z",
  GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: "eureka.example", ORIGIN_VERIFY_SECRET: "o".repeat(40),
  AWS_REGION: "us-east-2", DOCUMENTS_BUCKET: "d-1",
  FIELD_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  BIDX_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/9876abcd-12ab-34cd-56ef-1234567890ab",
};

describe("portal mail configuration (jobs-portal)", () => {
  it("production refuses to start without SES and a sender", () => {
    expect(() => loadConfig(prod)).toThrow(/PORTAL_MAIL_MODE=ses and PORTAL_FROM_EMAIL are required in production/);
    expect(() => loadConfig({ ...prod, PORTAL_MAIL_MODE: "ses" })).toThrow(/PORTAL_FROM_EMAIL/);
    expect(() => loadConfig({ ...prod, PORTAL_MAIL_MODE: "dev", PORTAL_FROM_EMAIL: "careers@eureka.example" })).toThrow(/required in production/);
    const c = loadConfig({ ...prod, PORTAL_MAIL_MODE: "ses", PORTAL_FROM_EMAIL: "careers@eureka.example" });
    expect(createMailPort(c)).toBeInstanceOf(SesMailPort);
  });

  it("development and tests use the in-memory mailbox", () => {
    const c = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x@y/z" });
    expect(createMailPort(c)).toBeInstanceOf(DevMailbox);
  });

  it("the SES port sends from the configured sender and never echoes provider messages", async () => {
    const sent: unknown[] = [];
    const ok = new SesMailPort("us-east-2", "careers@eureka.example", { send: async (cmd: { input: unknown }) => { sent.push(cmd.input); return {}; } } as never);
    await ok.send({ to: "a@example.com", subject: "S", text: "T" });
    expect(sent[0]).toMatchObject({ FromEmailAddress: "careers@eureka.example", Destination: { ToAddresses: ["a@example.com"] } });
    const bad = new SesMailPort("us-east-2", "careers@eureka.example", {
      send: async () => { throw Object.assign(new Error("Email address is not verified: a@example.com"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } }); },
    } as never);
    await expect(bad.send({ to: "a@example.com", subject: "S", text: "T" })).rejects.toThrow(/^Email delivery failed \(MessageRejected 400\)$/);
  });

  it("the dev mailbox keeps the newest 200 messages per process", async () => {
    const m = new DevMailbox(false);
    for (let i = 0; i < 205; i++) await m.send({ to: i % 2 ? "A@example.com" : "b@example.com", subject: `s${i}`, text: "t" });
    expect(m.inbox("a@example.com")[0]!.subject).toBe("s203");
    expect(m.inbox("a@example.com").length + m.inbox("b@example.com").length).toBe(200);
  });
});
