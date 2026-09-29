import type pg from "pg";
import { errorFields, type Logger } from "./log.js";

/** A job the scheduler runs once per run key (for daily jobs, the UTC date). */
export interface JobDefinition {
  name: string;
  /** Run keys due at `now`, oldest first. */
  dueKeys(now: Date): string[];
  /** Does the work for one run key. Must be idempotent. Returns detail for job_run. */
  run(runKey: string, ctx: JobContext): Promise<Record<string, unknown>>;
}

export interface JobContext {
  pool: pg.Pool;
  log: Logger;
  /** Aborted when the worker is shutting down; long jobs should check it between batches. */
  signal: AbortSignal;
}

export type RunOutcome = "ran" | "done-before" | "locked" | "failed";

/**
 * Postgres-backed job runner. Exactly-one-execution per (job, run key):
 *  - a session advisory lock on (job, run key) keeps two worker tasks from
 *    running the same period at once (the loser sees "locked" and moves on);
 *  - eureka.job_run records the outcome; a succeeded row makes later runs a
 *    no-op, a failed or abandoned ("running" with no lock holder) row is retried.
 * The worker needs no DDL and owns nothing (migration 0016).
 */
export class JobRunner {
  private readonly abort = new AbortController();
  private current: Promise<unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly jobs: JobDefinition[],
    private readonly log: Logger,
    private readonly onTick: () => void = () => undefined,
  ) {}

  /** Runs one (job, run key) under the lock and ledger. */
  async runOnce(job: JobDefinition, runKey: string): Promise<RunOutcome> {
    const lockClient = await this.pool.connect();
    let locked = false;
    try {
      const got = await lockClient.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`job:${job.name}:${runKey}`]);
      locked = got.rows[0]!.ok;
      if (!locked) return "locked";

      const prev = await lockClient.query<{ status: string }>(
        "SELECT status FROM eureka.job_run WHERE job_name = $1 AND run_key = $2", [job.name, runKey]);
      const status = prev.rows[0]?.status;
      if (status === "succeeded") return "done-before";
      if (status === undefined) {
        await lockClient.query(
          "INSERT INTO eureka.job_run (job_name, run_key, status) VALUES ($1, $2, 'running')", [job.name, runKey]);
      } else {
        await lockClient.query(
          `UPDATE eureka.job_run SET status = 'running', attempts = attempts + 1, started_at = now(),
             finished_at = NULL, detail = NULL WHERE job_name = $1 AND run_key = $2`, [job.name, runKey]);
      }

      const started = Date.now();
      this.log.info("job started", { job: job.name, runKey, previousStatus: status ?? null });
      try {
        const detail = await job.run(runKey, { pool: this.pool, log: this.log, signal: this.abort.signal });
        await lockClient.query(
          `UPDATE eureka.job_run SET status = 'succeeded', finished_at = now(), detail = $3
           WHERE job_name = $1 AND run_key = $2`, [job.name, runKey, detail]);
        this.log.info("job succeeded", { job: job.name, runKey, ms: Date.now() - started, ...detail });
        return "ran";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await lockClient.query(
          `UPDATE eureka.job_run SET status = 'failed', finished_at = now(), detail = $3
           WHERE job_name = $1 AND run_key = $2`, [job.name, runKey, { error: message.slice(0, 1000) }]);
        this.log.error("job failed", { job: job.name, runKey, ms: Date.now() - started, ...errorFields(err) });
        return "failed";
      }
    } finally {
      if (locked) {
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`job:${job.name}:${runKey}`])
          .catch(() => undefined);
      }
      lockClient.release();
    }
  }

  /** One scheduler pass: every due run key of every job, one at a time. */
  async tick(now: Date = new Date()): Promise<void> {
    this.onTick();
    for (const job of this.jobs) {
      for (const key of job.dueKeys(now)) {
        if (this.stopping) return;
        try {
          await this.runOnce(job, key);
        } catch (err) {
          // Database unavailable, for example; the next tick retries.
          this.log.error("job runner error", { job: job.name, runKey: key, ...errorFields(err) });
        }
      }
    }
  }

  start(tickMs: number): void {
    const loop = async () => {
      if (this.stopping) return;
      const p = this.tick();
      this.current = p;
      await p.catch((err) => this.log.error("tick failed", errorFields(err)));
      this.current = null;
      if (!this.stopping) this.timer = setTimeout(() => void loop(), tickMs);
    };
    void loop();
  }

  /**
   * Stops scheduling and waits up to `graceMs` for the running job. Returns
   * true when nothing was left running. An unfinished job stays "running" in
   * job_run; its lock dies with the connection and the next worker retries it.
   */
  async stop(graceMs: number): Promise<boolean> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const inflight = this.current;
    if (!inflight) return true;
    let timeout: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      inflight.then(() => true, () => true),
      new Promise<boolean>((r) => { timeout = setTimeout(() => r(false), graceMs); }),
    ]);
    clearTimeout(timeout);
    if (!finished) this.abort.abort();
    return finished;
  }
}
