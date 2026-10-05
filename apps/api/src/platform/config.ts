import { z } from "zod";
import { checkFieldCrypto, fieldCryptoEnv } from "./crypto/config.js";

/** Placeholder Terraform writes to SSM until the real Google OAuth values are set. */
const PLACEHOLDER = "set-me";

/** ORIGIN_VERIFY_SECRET may hold several comma-separated secrets (rotation). */
export function parseSecretList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    // Connections per process. RDS db.t4g.micro allows roughly 80-110 connections
    // and a rolling deploy can briefly run twice the API tasks plus the worker,
    // so keep this small in AWS (the task definitions set 5).
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // Seconds to keep serving after SIGTERM before closing, so API Gateway and
    // Cloud Map stop routing to this task before its connections go away.
    DRAIN_SECONDS: z.coerce.number().int().min(0).max(25).default(15), // ECS stopTimeout is 30 s
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    AUTH_MODE: z.enum(["google", "dev"]).default("google"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_HOSTED_DOMAIN: z.string().optional(),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:5173"),
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
    // Step-up (design A6.1): how long a fresh re-authentication opens restricted
    // documents for this session (the database caps it at 15 minutes), and how
    // old the Google sign-in (auth_time) may be when the step-up completes.
    STEP_UP_TTL_MINUTES: z.coerce.number().int().min(1).max(15).default(10),
    STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    // Shared secret CloudFront adds as X-Origin-Verify. The API Gateway endpoint
    // is publicly addressable, so requests without it (bypassing CloudFront and
    // its WAF) are rejected. Required in production. For rotation it may be a
    // comma-separated list ("new,old"); a request matching any entry is accepted.
    ORIGIN_VERIFY_SECRET: z.string().optional(),
    // Documents (resumes): the S3 bucket in AWS; otherwise a local directory
    // served by the API itself (development and tests only).
    DOCUMENTS_BUCKET: z.string().min(3).optional(),
    AWS_REGION: z.string().optional(),
    LOCAL_STORAGE_DIR: z.string().min(1).optional(),
    // Field encryption (design A6.3): KMS keys in AWS, a local provider otherwise
    // (refused in production). See platform/crypto/config.ts.
    ...fieldCryptoEnv,
    // jobs-portal: email the API sends to applicants (sign-in links, application
    // notices). "dev" keeps messages in memory (development mailbox endpoint);
    // "ses" sends from PORTAL_FROM_EMAIL. Production requires ses and a sender.
    PORTAL_MAIL_MODE: z.enum(["dev", "ses"]).default("dev"),
    PORTAL_FROM_EMAIL: z.string().email().optional(),
    // Applicant sessions (separate from staff sessions).
    PORTAL_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(60),
    PORTAL_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  })
  .superRefine((c, ctx) => {
    checkFieldCrypto(c, ctx, { bidx: true });
    // Design A6.1: the development identity provider can never run in production.
    if (c.NODE_ENV === "production" && c.AUTH_MODE === "dev") {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev is not allowed in production" });
    }
    if (c.ORIGIN_VERIFY_SECRET !== undefined) {
      const secrets = parseSecretList(c.ORIGIN_VERIFY_SECRET);
      if (secrets.length === 0 || secrets.some((s) => s.length < 32)) {
        ctx.addIssue({
          code: "custom",
          message: "ORIGIN_VERIFY_SECRET must be at least 32 characters (every entry, when comma-separated)",
        });
      }
    }
    if (c.NODE_ENV === "production" && !c.ORIGIN_VERIFY_SECRET) {
      ctx.addIssue({ code: "custom", message: "ORIGIN_VERIFY_SECRET is required in production" });
    }
    if (c.NODE_ENV === "production" && !c.DOCUMENTS_BUCKET) {
      ctx.addIssue({ code: "custom", message: "DOCUMENTS_BUCKET is required in production (the local document driver is for development)" });
    }
    // jobs-portal: applicants must get real email in production, from a configured sender.
    if (c.NODE_ENV === "production" && (c.PORTAL_MAIL_MODE !== "ses" || !c.PORTAL_FROM_EMAIL)) {
      ctx.addIssue({ code: "custom", message: "PORTAL_MAIL_MODE=ses and PORTAL_FROM_EMAIL are required in production" });
    }
    if (c.PORTAL_MAIL_MODE === "ses" && (!c.PORTAL_FROM_EMAIL || !c.AWS_REGION)) {
      ctx.addIssue({ code: "custom", message: "PORTAL_MAIL_MODE=ses needs PORTAL_FROM_EMAIL and AWS_REGION" });
    }
    if (c.DOCUMENTS_BUCKET && c.LOCAL_STORAGE_DIR) {
      ctx.addIssue({ code: "custom", message: "Set only one of DOCUMENTS_BUCKET and LOCAL_STORAGE_DIR" });
    }
    if (c.AUTH_MODE === "google") {
      if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.GOOGLE_HOSTED_DOMAIN) {
        ctx.addIssue({ code: "custom", message: "Google OIDC settings are required when AUTH_MODE=google" });
      } else if (c.GOOGLE_CLIENT_ID.trim() === PLACEHOLDER || c.GOOGLE_CLIENT_SECRET.trim() === PLACEHOLDER) {
        // Terraform creates the SSM parameters with this placeholder; refuse to
        // start until the real OAuth client is entered (infra/README.md step 4).
        ctx.addIssue({
          code: "custom",
          message: `GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are still the "${PLACEHOLDER}" placeholder; set the real Google OAuth client in SSM`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol("CONFIG");
