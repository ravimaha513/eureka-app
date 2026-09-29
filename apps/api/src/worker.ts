/**
 * Worker entrypoint (design A7, B6). Runs scheduled jobs from eureka.job_run
 * as eureka_worker (no BYPASSRLS, owns nothing; grants in migration 0016).
 * Jobs: audit-export (nightly, 03:30 America/New_York). Phase 2 adds the
 * feedback email and outbox relay; Phase 3 reminders and retention.
 */
import { utimes, writeFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { loadWorkerConfig } from "./worker/config.js";
import { auditExportJob } from "./worker/jobs/audit-export.js";
import { createLogger, errorFields } from "./worker/log.js";
import { JobRunner } from "./worker/runner.js";
import { DirSink, S3Sink, type ExportSink } from "./worker/sink.js";

const log = createLogger({ service: "worker" });
const config = loadWorkerConfig();

// Default statement timeout 15 s (sent at connect); the export raises it to 60 s locally (N9).
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, statement_timeout: 15_000 });
pool.on("error", (err) => log.error("idle database client error", errorFields(err)));
await pool.query("SELECT 1");

const sink: ExportSink = config.AUDIT_BUCKET
  ? new S3Sink(new S3Client({ region: config.AWS_REGION }), config.AUDIT_BUCKET)
  : new DirSink(config.EXPORT_DIR!);

const heartbeat = () => {
  const now = new Date();
  void utimes(config.HEARTBEAT_FILE, now, now)
    .catch(() => writeFile(config.HEARTBEAT_FILE, ""))
    .catch((err) => log.warn("heartbeat write failed", errorFields(err)));
};

const jobs = [auditExportJob(sink, config.AUDIT_EXPORT_CATCHUP_DAYS)];
const runner = new JobRunner(pool, jobs, log, heartbeat);
runner.start(config.JOB_TICK_SECONDS * 1000);
log.info("worker started", { jobs: jobs.map((j) => j.name), sink: sink.kind, tickSeconds: config.JOB_TICK_SECONDS });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("worker stopping", { signal, graceSeconds: config.SHUTDOWN_GRACE_SECONDS });
  const clean = await runner.stop(config.SHUTDOWN_GRACE_SECONDS * 1000);
  if (!clean) log.warn("job still running at shutdown; it will be retried", { signal });
  await pool.end().catch(() => undefined);
  log.info("worker stopped", { clean });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
