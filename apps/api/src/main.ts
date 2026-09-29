import { createApp } from "./app.module.js";
import { loadConfig } from "./platform/config.js";

const config = loadConfig();
const app = await createApp(config);
await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
console.log(`Eureka API listening on ${await app.getUrl()} (auth mode: ${config.AUTH_MODE})`);

// Graceful shutdown. On SIGTERM ECS deregisters the task from Cloud Map, but the
// API Gateway VPC link can keep routing to it for a few seconds (SRV TTL). Keep
// serving for DRAIN_SECONDS, then stop accepting connections, finish in-flight
// requests and close the database pool. The container stopTimeout (30 s in the
// task definition) must exceed DRAIN_SECONDS plus the close time.
let stopping = false;

async function close(): Promise<void> {
  let code = 0;
  try {
    await app.close();
  } catch (err) {
    console.error("error during shutdown", err);
    code = 1;
  }
  process.exit(code);
}

process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  console.log(`SIGTERM received; draining for ${config.DRAIN_SECONDS}s before shutdown`);
  setTimeout(() => void close(), config.DRAIN_SECONDS * 1000);
});

// Local Ctrl-C: no drain.
process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  void close();
});
