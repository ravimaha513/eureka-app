/**
 * Worker entrypoint (design A7, B6). Runs scheduled jobs from eureka.job_run
 * as eureka_worker (no BYPASSRLS, owns nothing; grants in migrations 0016, 0020).
 * Jobs: audit-export (nightly, 03:30 America/New_York), feedback email and
 * notification, outbox delivery (every tick), outbox prune and idempotency-key
 * cleanup (daily, schedules in worker/schedule.ts), resume and document
 * scan-and-promote (every tick, when DOCUMENTS_BUCKET or LOCAL_STORAGE_DIR is
 * set; documents also need RESTRICTED_KMS_KEY_ARN with S3), notification inbox
 * prune (daily), the bench-time reminder (daily, when NOTIFY_BENCH_DAYS is set),
 * assignment-ending-soon outbox rows (daily), field key rotation (monthly) and
 * work authorization expiry notices and paperwork-overdue reminders (daily). The outbox delivery job always
 * runs: without a mail mode it delivers the in-app inbox channel only
 * (docs/notifications.md).
 */
import { utimes, writeFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { LocalMail, SesMail } from "./worker/feedback-mail.js";
import { feedbackEmailJob, feedbackNotificationJob } from "./worker/jobs/feedback-email.js";
import { idempotencyCleanupJob, outboxDeliveryJob, outboxPruneJob } from "./worker/jobs/outbox.js";
import { benchTimeJob, notificationPruneJob } from "./worker/jobs/notifications.js";
import { portalPruneJob } from "./worker/jobs/portal-prune.js";
import { loadWorkerConfig } from "./worker/config.js";
import { auditExportJob } from "./worker/jobs/audit-export.js";
import { createLogger, errorFields } from "./worker/log.js";
import { JobRunner } from "./worker/runner.js";
import { DirSink, S3Sink, type ExportSink } from "./worker/sink.js";
import { LocalDocumentStore, S3DocumentStore } from "./worker/document-store.js";
import { DEFAULT_RESUME_SCAN_OPTIONS, resumeScanJob } from "./worker/jobs/resume-scan.js";
import { documentScanJob } from "./worker/jobs/document-scan.js";
import { assignmentEndingSoonJob } from "./worker/jobs/assignment-ending-soon.js";
import { paperworkOverdueJob } from "./worker/jobs/paperwork-overdue.js";
import { FieldCipher } from "./platform/crypto/field-crypto.js";
import { createKeyProvider } from "./platform/crypto/config.js";
import { keyRotationJob } from "./worker/jobs/key-rotation.js";
import { visaExpiryJob } from "./worker/jobs/visa-expiry.js";

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
  notificationPruneJob(config.NOTIFICATION_RETENTION_DAYS),
  assignmentEndingSoonJob(),
  // Field encryption (design A6.3): monthly re-encryption under a new data key.
  keyRotationJob(new FieldCipher(createKeyProvider(config)), { batchSize: config.KEY_ROTATION_BATCH_SIZE }),
  // Work authorization expiry notices into the outbox (delivered by the notification jobs).
  visaExpiryJob(config.WORK_AUTH_EXPIRY_NOTICE_DAYS),
  // Paperwork items past their due date (FR-NTF-04, migration 0052), once per item and due date.
  paperworkOverdueJob(),
  // jobs-portal: applicants who never confirmed their mailbox, after 30 days (ids and counts only in the log).
  portalPruneJob(30),
];
{
  // Without a mail mode only the in-app channel is delivered; emailing events stay unpublished.
  const mail = config.OUTBOX_MAIL_MODE === "disabled" ? null
    : config.OUTBOX_MAIL_MODE === "local" ? new LocalMail(config.OUTBOX_MAIL_DIR!) : new SesMail(config.AWS_REGION!, config.OUTBOX_FROM_EMAIL!);
  jobs.push(outboxDeliveryJob(mail, mail ? new URL(config.APP_PUBLIC_ORIGIN!).origin : null, {
    batchSize: config.OUTBOX_BATCH_SIZE,
    maxRejections: config.OUTBOX_MAX_REJECTIONS,
    deliverSince: config.OUTBOX_DELIVER_SINCE ? new Date(config.OUTBOX_DELIVER_SINCE) : undefined,
  }));
}
if (config.NOTIFY_BENCH_DAYS) jobs.push(benchTimeJob(config.NOTIFY_BENCH_DAYS, config.NOTIFY_BENCH_WINDOW_DAYS));
else log.warn("bench-time reminder is off (NOTIFY_BENCH_DAYS unset; threshold is open decision OD-05)");
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
