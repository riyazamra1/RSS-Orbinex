import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { registerAuth } from "./auth.js";
import { registerSync } from "./sync.js";
import { registerBusiness } from "./business.js";
import { registerInvoices } from "./invoices.js";
import { registerPurchases } from "./purchases.js";
import { registerExpenses } from "./expenses.js";
import { registerAccounting } from "./accounting.js";
import { registerPayments } from "./payments.js";
import { registerCatalog } from "./catalog.js";
import { registerPlatform } from "./platform.js";
import { registerMembers } from "./members.js";
import { registerInventoryOperations } from "./inventoryOperations.js";
import { registerFinancialReports } from "./reports.js";
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
  app.register(cors, {
    origin: config.WEB_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"]
  });
  app.register(rateLimit, { global: true, max: 100, timeWindow: "1 minute" });
  registerAuth(app, db);
  registerSync(app, db);
  registerBusiness(app, db);
  registerInvoices(app, db);
  registerPurchases(app, db);
  registerExpenses(app, db);
  registerAccounting(app, db);
  registerPayments(app, db);
  registerCatalog(app, db);
  registerPlatform(app, config, db);
  registerMembers(app, db);
  registerInventoryOperations(app, db);
  registerFinancialReports(app, db);

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
    const statusCandidate = error instanceof Error && "statusCode" in error
      && typeof error.statusCode === "number" ? error.statusCode : 500;
    const statusCode = statusCandidate >= 400 && statusCandidate < 500 ? statusCandidate : 500;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    app.log.error({ errorName, statusCode }, "Request failed");
    return reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : "request_error",
      message: statusCode === 500
        ? "An unexpected error occurred."
        : error instanceof Error ? error.message : "Invalid request."
    });
  });

  return app;
}
