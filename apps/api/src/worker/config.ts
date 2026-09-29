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
    AWS_REGION: z.string().optional(),
    // Audit export target: an S3 bucket (AWS) or a local directory (development, tests).
    AUDIT_BUCKET: z.string().min(3).optional(),
    EXPORT_DIR: z.string().min(1).optional(),
    // How many past UTC days the audit export catches up on after downtime.
    AUDIT_EXPORT_CATCHUP_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  })
  .superRefine((c, ctx) => {
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
