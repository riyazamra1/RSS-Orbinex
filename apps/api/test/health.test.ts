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
