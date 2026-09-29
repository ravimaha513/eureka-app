import { createApp } from "./app.module.js";
import { loadConfig } from "./platform/config.js";

const config = loadConfig();
const app = await createApp(config);
await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
console.log(`Eureka API listening on ${await app.getUrl()} (auth mode: ${config.AUTH_MODE})`);
