import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";

const bootstrapSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  timeZone: z.string().trim().min(1).max(80).default("Asia/Colombo")
}).strict();

const defaultAccounts = [
  ["1000", "Cash on hand", "asset", true],
  ["1010", "Bank account", "asset", true],
  ["1100", "Accounts receivable", "asset", true],
  ["1200", "Inventory", "asset", false],
  ["2000", "Accounts payable", "liability", true],
  ["3000", "Owner equity", "equity", false],
  ["4000", "Sales income", "income", false],
  ["5000", "Cost of goods sold", "expense", false],
  ["6000", "Operating expenses", "expense", false]
] as const;

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function registerPlatform(app: FastifyInstance, config: AppConfig, db: Database) {
  app.post("/v1/platform/bootstrap", {
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    if (!config.BOOTSTRAP_SECRET) {
      return reply.code(503).send({ error: "bootstrap_disabled", message: "Initial setup is not enabled on this server." });
    }
    const provided = typeof request.headers["x-rss-bootstrap-secret"] === "string"
      ? request.headers["x-rss-bootstrap-secret"] : undefined;
    if (!secretMatches(provided, config.BOOTSTRAP_SECRET)) {
      return reply.code(403).send({ error: "forbidden", message: "Initial setup authorization is invalid." });
    }
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_bootstrap", message: "Provide a business name, valid email, password of at least 12 characters, currency, and time zone." });
    }
    const input = parsed.data;
    const passwordHash = await hashPassword(input.password);
    try {
      const result = await db.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rss-orbinex:initial-bootstrap',0))");
        const existing = await client.query("SELECT COUNT(*)::int AS count FROM tenants");
        if (Number((existing.rows[0] as { count: number | string }).count) > 0) throw new Error("BOOTSTRAP_ALREADY_USED");

        const tenantResult = await client.query(
          "INSERT INTO tenants (legal_name,base_currency,time_zone,status) VALUES ($1,$2,$3,'active') RETURNING id",
          [input.businessName,input.baseCurrency,input.timeZone]
        );
        const tenantId = String((tenantResult.rows[0] as { id: string }).id);
        const userResult = await client.query(
          "INSERT INTO users (email,password_hash,status,email_verified_at) VALUES ($1,$2,'active',now()) RETURNING id,email",
          [input.email,passwordHash]
        );
        const user = userResult.rows[0] as { id: string; email: string };
        await client.query(
          "INSERT INTO tenant_memberships (tenant_id,user_id,role_key,status) VALUES ($1,$2,'owner','active')",
          [tenantId,user.id]
        );
        for (const [code,name,type,isControl] of defaultAccounts) {
          await client.query(
            "INSERT INTO accounts (tenant_id,account_code,name,account_type,is_control_account) VALUES ($1,$2,$3,$4,$5)",
            [tenantId,code,name,type,isControl]
          );
        }
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'platform.bootstrap','tenant',$1,'success',$3::jsonb)",
          [tenantId,user.id,JSON.stringify({ ownerEmail: user.email, seededAccountCount: defaultAccounts.length })]
        );
        return { tenantId, userId: user.id, email: user.email, businessName: input.businessName, baseCurrency: input.baseCurrency, timeZone: input.timeZone };
      });
      return reply.code(201).send({
        status: "initialized",
        tenant: { id: result.tenantId, name: result.businessName, baseCurrency: result.baseCurrency, timeZone: result.timeZone },
        owner: { id: result.userId, email: result.email, role: "owner" },
        defaultAccountsCreated: defaultAccounts.length,
        nextStep: "Sign in through POST /v1/auth/login using the returned tenant ID."
      });
    } catch (error) {
      if (error instanceof Error && error.message === "BOOTSTRAP_ALREADY_USED") {
        return reply.code(409).send({ error: "bootstrap_already_used", message: "Initial setup has already been completed for this database." });
      }
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505") {
        return reply.code(409).send({ error: "owner_email_exists", message: "That email address is already registered." });
      }
      throw error;
    }
  });
}
