import pg from "pg";
import type { AppConfig } from "./config.js";

const { Pool } = pg;

export function createDatabase(config: AppConfig) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ...(config.DATABASE_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: "rss-orbinex-api"
  });

  pool.on("error", () => {
    // Do not log connection details or query data.
  });

  return {
    query: pool.query.bind(pool),
    async transaction<T>(work: (client: any) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async check(): Promise<boolean> {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

export type Database = ReturnType<typeof createDatabase>;
