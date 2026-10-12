import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const db = createDatabase(config);
const app = buildApp(config, db);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "API startup failed");
  await db.close();
  process.exitCode = 1;
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await db.close();
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
