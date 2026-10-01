import type pg from "pg";
import { errorFields, type Logger } from "./log.js";

/** A job the scheduler runs once per run key (for daily jobs, the UTC date). */
export interface JobDefinition {
  name: string;
  /** Run keys due at `now`, oldest first. */
  dueKeys(now: Date, ctx: DueContext): string[] | Promise<string[]>;
  /** Does the work for one run key. Must be idempotent. Returns detail for job_run. */
  run(runKey: string, ctx: JobContext): Promise<Record<string, unknown>>;
}

export interface DueContext {
  pool: pg.Pool;
  log: Logger;
}

export interface JobContext extends DueContext {
  /**
   * Aborted when the worker is shutting down or the run's lease was lost; long
   * jobs check it between batches and pass it to network calls.
   */
  signal: AbortSignal;
  /** Touches the liveness heartbeat; call between batches of a long job. */
  heartbeat(): void;
}

/**
 * ran: this runner did the work; done-before: already succeeded; leased: another
 * runner holds a live lease; backoff: a failed run waits for next_attempt_at;
 * failed: the work failed (retried after backoff); lease-lost: the work finished
 * but another runner had taken over the key, so the outcome was not recorded.
 */
export type RunOutcome = "ran" | "done-before" | "leased" | "backoff" | "failed" | "lease-lost";

export interface RunnerOptions {
  /** How long a claim is valid without renewal. */
  leaseMs: number;
  /** How often a running job renews its lease (well under leaseMs). */
  renewMs: number;
  /** Retry delay after the first failure; doubles per attempt up to backoffMaxMs. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** From this many failed attempts on, each further failure logs an alert. */
  maxAttempts: number;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  leaseMs: 120_000,
  renewMs: 30_000,
  backoffBaseMs: 60_000,
  backoffMaxMs: 6 * 3600_000,
  maxAttempts: 8,
};

/** Delay before retrying after failed attempt number `attempt` (1-based). */
export function backoffMs(attempt: number, o: Pick<RunnerOptions, "backoffBaseMs" | "backoffMaxMs">): number {
  return Math.min(o.backoffMaxMs, o.backoffBaseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

/**
 * Postgres-backed job runner. At most one live execution per (job, run key):
 *  - a runner claims a key with one conditional UPDATE (or INSERT for a new
 *    key) that sets lease_until; only a row that is not succeeded, not held
 *    under a live lease and past its next_attempt_at can be claimed, so of two
 *    concurrent runners exactly one gets the row;
 *  - while the job runs the lease is renewed every renewMs; renewals and the
 *    final update match on `attempts` (the fencing token), so a runner whose
 *    lease expired and was taken over cannot overwrite the new owner's row, and
 *    its job is aborted;
 *  - a failed run gets next_attempt_at = now() + exponential backoff.
 * No session state is held on a pooled connection, so a dropped connection
 * cannot silently release anything. The worker needs no DDL and owns nothing
 * (migrations 0016, 0020).
 */
export class JobRunner {
  private readonly abort = new AbortController();
  private current: Promise<unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly opts: RunnerOptions;

  constructor(
    private readonly pool: pg.Pool,
    private readonly jobs: JobDefinition[],
    private readonly log: Logger,
    private readonly onTick: () => void = () => undefined,
    opts: Partial<RunnerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_RUNNER_OPTIONS, ...opts };
  }

  /** Claims (job, run key); returns the attempt number, or why it could not. */
  private async claim(job: string, runKey: string): Promise<number | RunOutcome> {
    const lease = this.opts.leaseMs;
    const upd = await this.pool.query<{ attempts: number }>(
      `UPDATE eureka.job_run
          SET status = 'running', attempts = attempts + 1, detail = NULL, next_attempt_at = NULL,
              lease_until = now() + $3 * interval '1 millisecond'
        WHERE job_name = $1 AND run_key = $2
          AND status <> 'succeeded'
          AND (status <> 'running' OR lease_until < now())
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        RETURNING attempts`, [job, runKey, lease]);
    if (upd.rows[0]) return upd.rows[0].attempts;

    const ins = await this.pool.query<{ attempts: number }>(
      `INSERT INTO eureka.job_run (job_name, run_key, status, lease_until)
       VALUES ($1, $2, 'running', now() + $3 * interval '1 millisecond')
       ON CONFLICT (job_name, run_key) DO NOTHING
       RETURNING attempts`, [job, runKey, lease]);
    if (ins.rows[0]) return ins.rows[0].attempts;

    const cur = await this.pool.query<{ status: string }>(
      "SELECT status FROM eureka.job_run WHERE job_name = $1 AND run_key = $2", [job, runKey]);
    const status = cur.rows[0]?.status;
    if (status === "succeeded") return "done-before";
    if (status === "running") return "leased";
    return "backoff";
  }

  /** Extends the lease; false when this runner no longer holds it. */
  private async renew(job: string, runKey: string, attempt: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE eureka.job_run SET lease_until = now() + $4 * interval '1 millisecond'
        WHERE job_name = $1 AND run_key = $2 AND status = 'running' AND attempts = $3
          AND lease_until > now()`, // an expired lease is lost, even if nobody has claimed it yet
      [job, runKey, attempt, this.opts.leaseMs]);
    return r.rowCount === 1;
  }

  /** Records the outcome if this runner still holds the lease; false otherwise. */
  private async finish(
    job: string, runKey: string, attempt: number, status: "succeeded" | "failed",
    detail: Record<string, unknown>, retryInMs: number | null,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE eureka.job_run
          SET status = $4, detail = $5, lease_until = NULL,
              next_attempt_at = CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + $6::bigint * interval '1 millisecond' END
        WHERE job_name = $1 AND run_key = $2 AND status = 'running' AND attempts = $3`,
      [job, runKey, attempt, status, detail, retryInMs]);
    return r.rowCount === 1;
  }

  /** Runs one (job, run key) under a lease and records the outcome in job_run. */
  async runOnce(job: JobDefinition, runKey: string): Promise<RunOutcome> {
    const claimed = await this.claim(job.name, runKey);
    if (typeof claimed !== "number") return claimed;
    const attempt = claimed;

    const lost = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, lost.signal]);
    let settled = false;
    let renewing = false;
    const renewTimer = setInterval(() => {
      if (renewing || settled) return;
      renewing = true;
      this.renew(job.name, runKey, attempt).then(
        (held) => {
          if (!held && !settled) {
            this.log.error("job lease lost; aborting", { job: job.name, runKey, attempt, alert: true });
            lost.abort();
          }
        },
        // Database unreachable: keep working; if the lease expires meanwhile,
        // the final update notices (fencing on attempts).
        (err) => this.log.warn("job lease renewal failed", { job: job.name, runKey, attempt, ...errorFields(err) }),
      ).finally(() => { renewing = false; });
    }, this.opts.renewMs);

    const started = Date.now();
    this.log.info("job started", { job: job.name, runKey, attempt });
    try {
      let detail: Record<string, unknown>;
      let recordedSuccess: boolean;
      try {
        detail = await job.run(runKey, { pool: this.pool, log: this.log, signal, heartbeat: this.onTick });
        settled = true;
        // Can fail on the database's own checks (audit-export: no ledger row for the day).
        recordedSuccess = await this.finish(job.name, runKey, attempt, "succeeded", detail, null);
      } catch (err) {
        settled = true;
        // A shutdown abort is not the job's fault: the next worker may retry at once.
        const retryInMs = this.abort.signal.aborted ? 0 : backoffMs(attempt, this.opts);
        const message = err instanceof Error ? err.message : String(err);
        const recorded = await this.finish(job.name, runKey, attempt, "failed",
          { error: message.slice(0, 1000) }, retryInMs);
        const exhausted = attempt >= this.opts.maxAttempts;
        this.log.error(exhausted ? "job failed repeatedly" : "job failed", {
          job: job.name, runKey, attempt, ms: Date.now() - started, retryInMs, recorded,
          ...(exhausted ? { alert: true, maxAttempts: this.opts.maxAttempts } : {}), ...errorFields(err),
        });
        return recorded ? "failed" : "lease-lost";
      }
      if (!recordedSuccess) {
        this.log.error("job finished after losing its lease; outcome not recorded",
          { job: job.name, runKey, attempt, alert: true });
        return "lease-lost";
      }
      this.log.info("job succeeded", { job: job.name, runKey, attempt, ms: Date.now() - started, ...detail });
      return "ran";
    } finally {
      settled = true;
      clearInterval(renewTimer);
    }
  }

  /** One scheduler pass: every due run key of every job, one at a time. */
  async tick(now: Date = new Date()): Promise<void> {
    this.onTick();
    for (const job of this.jobs) {
      let keys: string[];
      try {
        keys = await job.dueKeys(now, { pool: this.pool, log: this.log });
      } catch (err) {
        this.log.error("job due-key lookup failed", { job: job.name, ...errorFields(err) });
        continue;
      }
      for (const key of keys) {
        if (this.stopping) return;
        this.onTick();
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
   * true when nothing was left running. An unfinished job is aborted and stays
   * "running" in job_run until its lease expires; then any worker retries it.
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
