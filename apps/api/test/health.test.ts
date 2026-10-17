import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { Database } from "../src/db.js";

const config: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 4000,
  DATABASE_URL: "postgresql://localhost:5432/rss_orbinex_test",
  DATABASE_SSL: false
};

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API health endpoints", () => {
  it("returns liveness without exposing configuration", async () => {
    const db = { check: vi.fn(async () => true) } as unknown as Database;
    const app = buildApp(config, db);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "rss-orbinex-api" });
  });

  it("returns 503 when the database is not ready", async () => {
    const db = { check: vi.fn(async () => false) } as unknown as Database;
    const app = buildApp(config, db);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready", dependencies: { database: "unavailable" } });
  });
});

describe("Purchasing and payment API route protection", () => {
  it("requires an authenticated online session for purchase and payment routes", async () => {
    const db = { check: vi.fn(async () => true) } as unknown as Database;
    const app = buildApp(config, db);
    apps.push(app);
    const requests = [
      { method: "GET" as const, url: "/v1/purchase-bills" },
      { method: "GET" as const, url: "/v1/purchase-bills/00000000-0000-4000-8000-000000000001" },
      { method: "POST" as const, url: "/v1/purchase-bills", payload: {} },
      { method: "POST" as const, url: "/v1/purchase-bills/00000000-0000-4000-8000-000000000001/post", payload: {} },
      { method: "POST" as const, url: "/v1/supplier-payments", payload: {} },
      { method: "GET" as const, url: "/v1/payments" },
      { method: "POST" as const, url: "/v1/payments", payload: {} }
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("unauthorized");
    }
  });
});

describe("Expense API route protection", () => {
  it("registers expense endpoints behind online authentication", async () => {
    const db = { check: vi.fn(async () => true) } as unknown as Database;
    const app = buildApp(config, db);
    apps.push(app);
    const requests = [
      { method: "GET" as const, url: "/v1/expenses" },
      { method: "GET" as const, url: "/v1/expenses/00000000-0000-4000-8000-000000000001" },
      { method: "POST" as const, url: "/v1/expenses", payload: {} },
      { method: "POST" as const, url: "/v1/expenses/00000000-0000-4000-8000-000000000001/post", payload: {} }
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("unauthorized");
    }
  });
});
