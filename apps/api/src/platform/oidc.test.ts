import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { OidcService } from "./oidc.service.js";

const base = {
  NODE_ENV: "test", AUTH_MODE: "google", SESSION_SECRET: "session-secret-session-secret-session-secret",
  DATABASE_URL: "postgres://x@127.0.0.1:1/z", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec",
  GOOGLE_HOSTED_DOMAIN: "eureka.example", EUREKA_ENVIRONMENT: "staging", AUTH_TEST_EMAILS: "Tester@gmail.com",
};
let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let svc: OidcService;

const token = (claims: Record<string, unknown>) =>
  new SignJWT({ nonce: "n", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer("https://accounts.google.com")
    .setAudience("cid").setSubject("sub1").setIssuedAt().setExpirationTime("5m").sign(key);

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  key = privateKey;
  svc = new OidcService(loadConfig(base));
  svc.useKeySet(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256" }] }));
});

describe("OidcService.verify domain gate", () => {
  it("accepts a company account", async () => {
    const id = await svc.verify(await token({ email: "a@eureka.example", hd: "eureka.example" }), "n");
    expect(id.email).toBe("a@eureka.example");
  });
  it("accepts a listed test email without hd or domain (case-insensitive)", async () => {
    const id = await svc.verify(await token({ email: "TESTER@gmail.com" }), "n");
    expect(id.email).toBe("tester@gmail.com");
  });
  it("still rejects an unlisted outside email", async () => {
    await expect(svc.verify(await token({ email: "other@gmail.com" }), "n")).rejects.toThrow(/company domain/);
  });
  it("still requires a verified email for a listed test email", async () => {
    await expect(svc.verify(await token({ email: "tester@gmail.com", email_verified: false }), "n")).rejects.toThrow(/not verified/);
  });
});
