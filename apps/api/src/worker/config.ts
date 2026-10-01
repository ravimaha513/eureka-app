import { z } from "zod";

/**
 * Worker configuration. Deliberately separate from the API config: the worker
 * needs no session secret or OAuth client, so its task definition does not get them.
 */
const WorkerConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().min(2).max(10).default(3),
    // How often the scheduler checks for due jobs.
    JOB_TICK_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    // On SIGTERM, how long a running job may continue before the process exits
    // (ECS stopTimeout is 30 s).
    SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(0).max(25).default(20),
    // Liveness file touched on every tick; the ECS health check reads its mtime.
    HEARTBEAT_FILE: z.string().default("/tmp/worker-heartbeat"),
    FEEDBACK_MAIL_MODE: z.enum(["disabled", "local", "ses"]).default("disabled"),
    FEEDBACK_MAIL_DIR: z.string().min(1).optional(),
    FEEDBACK_FROM_EMAIL: z.string().email().optional(),
    FEEDBACK_PUBLIC_ORIGIN: z.string().url().optional(),
    FEEDBACK_TOKEN_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    AWS_REGION: z.string().optional(),
    // Audit export target: an S3 bucket (AWS) or a local directory (development, tests).
    AUDIT_BUCKET: z.string().min(3).optional(),
    EXPORT_DIR: z.string().min(1).optional(),
    // At most this many missing UTC days are exported per tick while catching up
    // (every day since the last export is caught up eventually; see audit-export.ts).
    AUDIT_EXPORT_MAX_DAYS_PER_TICK: z.coerce.number().int().min(1).max(31).default(7),
    // Outbox delivery (placement notifications to HR, Accounts, Immigration).
    // Disabled: events stay unpublished (so they are not pruned) until a mail mode is set.
    OUTBOX_MAIL_MODE: z.enum(["disabled", "local", "ses"]).default("disabled"),
    OUTBOX_MAIL_DIR: z.string().min(1).optional(),
    OUTBOX_FROM_EMAIL: z.string().email().optional(),
    // Sign-in link in notification emails (the web app's origin).
    APP_PUBLIC_ORIGIN: z.string().url().optional(),
    // Events handled per tick (one job_run key each).
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    // Published outbox rows are deleted after this many days (the database refuses fewer than 7).
    OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  })
  .superRefine((c, ctx) => {
    if (c.FEEDBACK_MAIL_MODE !== "disabled") {
      if (!c.FEEDBACK_PUBLIC_ORIGIN || !c.FEEDBACK_TOKEN_KEY) ctx.addIssue({ code: "custom", message: "Feedback requires FEEDBACK_PUBLIC_ORIGIN and FEEDBACK_TOKEN_KEY" });
      if (c.FEEDBACK_PUBLIC_ORIGIN) {
        const url = new URL(c.FEEDBACK_PUBLIC_ORIGIN);
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) ctx.addIssue({code:"custom",message:"Feedback origin must be an HTTP(S) origin without a path or credentials"});
        if (c.NODE_ENV === "production" && url.protocol !== "https:") ctx.addIssue({code:"custom",message:"Production feedback requires HTTPS"});
      }
      if (c.FEEDBACK_MAIL_MODE === "local" && (!c.FEEDBACK_MAIL_DIR || c.NODE_ENV === "production")) ctx.addIssue({ code: "custom", message: "Local feedback mail requires FEEDBACK_MAIL_DIR and a non-production environment" });
      if (c.FEEDBACK_MAIL_MODE === "ses" && (!c.FEEDBACK_FROM_EMAIL || !c.AWS_REGION)) ctx.addIssue({ code: "custom", message: "SES feedback requires FEEDBACK_FROM_EMAIL and AWS_REGION" });
    }
    if (c.OUTBOX_MAIL_MODE !== "disabled") {
      if (!c.APP_PUBLIC_ORIGIN) ctx.addIssue({ code: "custom", message: "Outbox mail requires APP_PUBLIC_ORIGIN" });
      else {
        const url = new URL(c.APP_PUBLIC_ORIGIN);
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) ctx.addIssue({ code: "custom", message: "APP_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials" });
        if (c.NODE_ENV === "production" && url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "Production APP_PUBLIC_ORIGIN requires HTTPS" });
      }
      if (c.OUTBOX_MAIL_MODE === "local" && (!c.OUTBOX_MAIL_DIR || c.NODE_ENV === "production")) ctx.addIssue({ code: "custom", message: "Local outbox mail requires OUTBOX_MAIL_DIR and a non-production environment" });
      if (c.OUTBOX_MAIL_MODE === "ses" && (!c.OUTBOX_FROM_EMAIL || !c.AWS_REGION)) ctx.addIssue({ code: "custom", message: "SES outbox mail requires OUTBOX_FROM_EMAIL and AWS_REGION" });
    }
    if (!c.AUDIT_BUCKET && !c.EXPORT_DIR) {
      ctx.addIssue({ code: "custom", message: "Set AUDIT_BUCKET (S3) or EXPORT_DIR (local) for the audit export" });
    }
    if (c.AUDIT_BUCKET && c.EXPORT_DIR) {
      ctx.addIssue({ code: "custom", message: "Set only one of AUDIT_BUCKET and EXPORT_DIR" });
    }
    if (c.NODE_ENV === "production" && !c.AUDIT_BUCKET) {
      ctx.addIssue({ code: "custom", message: "AUDIT_BUCKET is required in production (EXPORT_DIR is for local use)" });
    }
  });

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = WorkerConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}
