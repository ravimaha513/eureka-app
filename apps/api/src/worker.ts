/**
 * Worker entrypoint (design A7, B6). Runs scheduled jobs from eureka.job_run
 * as eureka_worker (no BYPASSRLS, owns nothing; grants in migrations 0016, 0020).
 * Jobs: audit-export (nightly, 03:30 America/New_York), feedback email and
 * notification, outbox delivery (every tick), outbox prune and idempotency-key
 * cleanup (daily, schedules in worker/schedule.ts), resume and document
 * scan-and-promote (every tick, when DOCUMENTS_BUCKET or LOCAL_STORAGE_DIR is
 * set; documents also need RESTRICTED_KMS_KEY_ARN with S3). Phase 3 adds
 * reminders and retention.
 */
import { utimes, writeFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { LocalMail, SesMail } from "./worker/feedback-mail.js";
import { feedbackEmailJob, feedbackNotificationJob } from "./worker/jobs/feedback-email.js";
import { idempotencyCleanupJob, outboxDeliveryJob, outboxPruneJob } from "./worker/jobs/outbox.js";
import { loadWorkerConfig } from "./worker/config.js";
import { auditExportJob } from "./worker/jobs/audit-export.js";
import { createLogger, errorFields } from "./worker/log.js";
import { JobRunner } from "./worker/runner.js";
import { DirSink, S3Sink, type ExportSink } from "./worker/sink.js";
import { LocalDocumentStore, S3DocumentStore } from "./worker/document-store.js";
import { DEFAULT_RESUME_SCAN_OPTIONS, resumeScanJob } from "./worker/jobs/resume-scan.js";
import { documentScanJob } from "./worker/jobs/document-scan.js";

const log = createLogger({ service: "worker" });
const config = loadWorkerConfig();

// Default statement timeout 15 s (sent at connect); the export raises it to 60 s locally (N9).
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, statement_timeout: 15_000 });
pool.on("error", (err) => log.error("idle database client error", errorFields(err)));
await pool.query("SELECT 1");

// Bounded S3 calls: a hung connection must not hold a job (and its lease) forever.
const sink: ExportSink = config.AUDIT_BUCKET
  ? new S3Sink(new S3Client({
    region: config.AWS_REGION,
    maxAttempts: 3,
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
  }), config.AUDIT_BUCKET)
  : new DirSink(config.EXPORT_DIR!);

const heartbeat = () => {
  const now = new Date();
  void utimes(config.HEARTBEAT_FILE, now, now)
    .catch(() => writeFile(config.HEARTBEAT_FILE, ""))
    .catch((err) => log.warn("heartbeat write failed", errorFields(err)));
};

const jobs = [
  auditExportJob(sink, config.AUDIT_EXPORT_MAX_DAYS_PER_TICK),
  outboxPruneJob(config.OUTBOX_RETENTION_DAYS),
  idempotencyCleanupJob(),
];
if (config.OUTBOX_MAIL_MODE !== "disabled") {
  const mail = config.OUTBOX_MAIL_MODE === "local" ? new LocalMail(config.OUTBOX_MAIL_DIR!) : new SesMail(config.AWS_REGION!, config.OUTBOX_FROM_EMAIL!);
  jobs.push(outboxDeliveryJob(mail, new URL(config.APP_PUBLIC_ORIGIN!).origin, {
    batchSize: config.OUTBOX_BATCH_SIZE,
    maxRejections: config.OUTBOX_MAX_REJECTIONS,
    deliverSince: config.OUTBOX_DELIVER_SINCE ? new Date(config.OUTBOX_DELIVER_SINCE) : undefined,
  }));
}
if (config.FEEDBACK_MAIL_MODE !== "disabled") {
  const mail = config.FEEDBACK_MAIL_MODE === "local" ? new LocalMail(config.FEEDBACK_MAIL_DIR!) : new SesMail(config.AWS_REGION!, config.FEEDBACK_FROM_EMAIL!);
  const origin = new URL(config.FEEDBACK_PUBLIC_ORIGIN!).origin;
  jobs.push(feedbackEmailJob(mail, origin, config.FEEDBACK_TOKEN_KEY!), feedbackNotificationJob(mail, origin));
}
if (config.DOCUMENTS_BUCKET || config.LOCAL_STORAGE_DIR) {
  const store = config.DOCUMENTS_BUCKET
    ? new S3DocumentStore(new S3Client({
      region: config.AWS_REGION,
      maxAttempts: 3,
      requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
    }), config.DOCUMENTS_BUCKET)
    : new LocalDocumentStore(config.LOCAL_STORAGE_DIR!);
  const scanOptions = {
    ...DEFAULT_RESUME_SCAN_OPTIONS,
    scanTimeoutMs: config.RESUME_SCAN_TIMEOUT_MINUTES * 60_000,
    uploadGraceMs: config.RESUME_UPLOAD_GRACE_MINUTES * 60_000,
    maxVersionsPerKey: config.RESUME_MAX_KEY_VERSIONS,
  };
  jobs.push(resumeScanJob(store, scanOptions));
  if (store.kind === "local" || config.RESTRICTED_KMS_KEY_ARN) {
    jobs.push(documentScanJob(store, scanOptions, config.RESTRICTED_KMS_KEY_ARN));
  } else {
    log.warn("document-scan is off (set RESTRICTED_KMS_KEY_ARN); uploaded documents stay pending");
  }
} else {
  log.warn("resume-scan and document-scan are off (set DOCUMENTS_BUCKET or LOCAL_STORAGE_DIR); uploads stay pending");
}
const runner = new JobRunner(pool, jobs, log, heartbeat);
runner.start(config.JOB_TICK_SECONDS * 1000);
log.info("worker started", { jobs: jobs.map((j) => j.name), sink: sink.kind, tickSeconds: config.JOB_TICK_SECONDS });

const POOL_END_TIMEOUT_MS = 3_000;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("worker stopping", { signal, graceSeconds: config.SHUTDOWN_GRACE_SECONDS });
  const clean = await runner.stop(config.SHUTDOWN_GRACE_SECONDS * 1000);
  if (!clean) log.warn("job still running at shutdown; it is retried once its lease expires", { signal });
  let timer: NodeJS.Timeout | undefined;
  const poolClosed = await Promise.race([
    pool.end().then(() => true, (err) => { log.warn("closing the database pool failed", errorFields(err)); return false; }),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), POOL_END_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  log.info("worker stopped", { clean, poolClosed });
  process.exit(clean && poolClosed ? 0 : 1);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
