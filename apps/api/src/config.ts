import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.toLowerCase() === "true";
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url().default("postgresql://localhost:5432/rss_orbinex"),
  DATABASE_SSL: booleanFromEnv.default(false)
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ");
    throw new Error("Invalid application configuration: " + issues);
  }
  if (result.data.NODE_ENV === "production" && !result.data.DATABASE_SSL) {
    throw new Error("DATABASE_SSL must be enabled in production.");
  }
  return result.data;
}
