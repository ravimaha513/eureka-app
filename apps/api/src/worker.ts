/**
 * Worker entrypoint (design A7). Jobs are added in Phase 2 (feedback email,
 * outbox relay) and Phase 3 (reminders, retention). The ECS service runs with
 * desired_count = 0 until then.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: url, max: 2 });
await pool.query("SELECT 1");
console.log(JSON.stringify({ level: "info", msg: "worker started", jobs: [] }));

const shutdown = async () => { await pool.end(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => undefined, 60_000);
