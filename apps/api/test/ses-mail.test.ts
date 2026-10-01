import { describe, expect, it } from "vitest";
import { MailRejected, SesMail } from "../src/worker/feedback-mail.js";

/** SesMail error classification with a stubbed SES client (no network). */
const MAIL = { id: "e-u", to: "secret.person@example.com", subject: "s", text: "t" };

function sesWith(outcome: unknown) {
  const calls: { signal?: AbortSignal }[] = [];
  const client = {
    async send(_cmd: unknown, opts?: { abortSignal?: AbortSignal }) {
      calls.push({ signal: opts?.abortSignal });
      if (outcome !== undefined) throw outcome;
      return {};
    },
  };
  return { ses: new SesMail("us-east-1", "noreply@eureka.example", client as never), calls };
}

async function classify(outcome: unknown): Promise<Error | null> {
  const { ses } = sesWith(outcome);
  try {
    await ses.send(MAIL, new AbortController().signal);
    return null;
  } catch (err) {
    return err as Error;
  }
}

const sdkError = (name: string, status?: number) =>
  Object.assign(new Error(`${name}: recipient ${MAIL.to}`), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

describe("SesMail error classification", () => {
  it("passes the abort signal and succeeds", async () => {
    const { ses, calls } = sesWith(undefined);
    const ac = new AbortController();
    await ses.send(MAIL, ac.signal);
    expect(calls[0]!.signal).toBe(ac.signal);
  });

  it("4xx is a definite, counted rejection", async () => {
    const e = await classify(sdkError("MessageRejected", 400));
    expect(e).toBeInstanceOf(MailRejected);
    expect((e as MailRejected).throttled).toBe(false);
  });

  it("429 and throttling errors are retryable rejections that are not counted", async () => {
    for (const x of [sdkError("TooManyRequestsException", 429), sdkError("ThrottlingException", 400),
      sdkError("SendingPausedException", 400), sdkError("Whatever", 429)]) {
      const e = await classify(x);
      expect(e, x.name).toBeInstanceOf(MailRejected);
      expect((e as MailRejected).throttled, x.name).toBe(true);
    }
  });

  it("5xx, timeouts, aborts and network errors leave the outcome unknown", async () => {
    for (const x of [sdkError("InternalFailure", 500), sdkError("ServiceUnavailable", 503), sdkError("TimeoutError"),
      sdkError("AbortError"), sdkError("ECONNRESET"), "not even an error"]) {
      const e = await classify(x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(MailRejected);
    }
  });

  it("never passes provider messages (which may name the recipient) on", async () => {
    for (const x of [sdkError("MessageRejected", 400), sdkError("InternalFailure", 500), sdkError("TooManyRequestsException", 429)]) {
      expect((await classify(x))!.message).not.toContain(MAIL.to);
    }
  });
});
