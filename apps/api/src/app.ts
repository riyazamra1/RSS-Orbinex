import Fastify from "fastify";
import helmet from "@fastify/helmet";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";

export function buildApp(config: AppConfig, db: Database) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie"]
    },
    trustProxy: false,
    bodyLimit: 1048576
  });

  app.register(helmet, { global: true });

  app.get("/health/live", async () => ({ status: "ok", service: "rss-orbinex-api" }));

  app.get("/health/ready", async (_request, reply) => {
    const databaseReady = await db.check();
    if (!databaseReady) {
      return reply.code(503).send({ status: "not_ready", dependencies: { database: "unavailable" } });
    }
    return { status: "ready", dependencies: { database: "available" } };
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: "not_found", message: "The requested resource was not found." });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ errorName: error.name, statusCode: error.statusCode ?? 500 }, "Request failed");
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
    return reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500 ? "An unexpected error occurred." : error.message
    });
  });

  return app;
}
