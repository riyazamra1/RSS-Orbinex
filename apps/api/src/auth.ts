import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./security.js";
import type { Database } from "./db.js";

const loginSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  deviceLabel: z.string().trim().min(1).max(120),
  platform: z.enum(["web", "windows", "android"])
});

type Principal = {
  userId: string;
  tenantId: string;
  deviceId: string;
  sessionId: string;
  roleKey: string;
  email: string;
};

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function registerAuth(app: FastifyInstance, db: Database) {
  app.decorateRequest("principal", null);

  app.post("/v1/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { body: loginSchema }
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "Provide a valid tenant, email, password, and device details." });
    }
    const input = parsed.data;
    const userResult = await db.query(
      `SELECT u.id AS user_id, u.email, u.password_hash, u.status AS user_status,
              t.status AS tenant_status, tm.role_key, tm.status AS membership_status
       FROM users u
       JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.tenant_id = $1
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE u.email_normalized = lower(trim($2))
       LIMIT 1`,
      [input.tenantId, input.email]
    );
    const user = userResult.rows[0] as {
      user_id: string; email: string; password_hash: string; user_status: string;
      tenant_status: string; role_key: string; membership_status: string;
    } | undefined;

    // Verify a fixed dummy hash path is intentionally not exposed as an account-existence signal.
    const passwordValid = user
      ? await verifyPassword(user.password_hash, input.password)
      : await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
    if (!user || !passwordValid || user.user_status !== "active" ||
        user.tenant_status !== "active" || user.membership_status !== "active") {
      return reply.code(401).send({ error: "authentication_failed", message: "Email, password, or account access is invalid." });
    }

    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const deviceResult = await db.query(
      `INSERT INTO registered_devices (tenant_id, user_id, device_label, platform, status, last_seen_at)
       VALUES ($1, $2, $3, $4, 'active', now())
       RETURNING id`,
      [input.tenantId, user.user_id, input.deviceLabel, input.platform]
    );
    const deviceId = String((deviceResult.rows[0] as { id: string }).id);

    const sessionResult = await db.query(
      `INSERT INTO auth_sessions (tenant_id, user_id, device_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, expires_at`,
      [input.tenantId, user.user_id, deviceId, tokenHash, expiresAt]
    );
    const session = sessionResult.rows[0] as { id: string; expires_at: Date | string };

    await db.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
       VALUES ($1, $2, 'auth.login', 'device', $3, 'success', jsonb_build_object('platform', $4))`,
      [input.tenantId, user.user_id, deviceId, input.platform]
    );

    return reply.code(200).send({
      token,
      tokenType: "Bearer",
      expiresAt: new Date(session.expires_at).toISOString(),
      user: { id: user.user_id, email: user.email, role: user.role_key },
      tenant: { id: input.tenantId },
      device: { id: deviceId, platform: input.platform }
    });
  });

  app.get("/v1/auth/session", { preHandler: authenticate(db) }, async (request) => {
    const principal = request.principal!;
    return {
      authenticated: true,
      user: { id: principal.userId, email: principal.email, role: principal.roleKey },
      tenant: { id: principal.tenantId },
      device: { id: principal.deviceId }
    };
  });

  app.post("/v1/auth/logout", { preHandler: authenticate(db) }, async (request, reply) => {
    const principal = request.principal!;
    await db.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [principal.sessionId]
    );
    await db.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, event_type, entity_type, entity_id, outcome)
       VALUES ($1, $2, 'auth.logout', 'device', $3, 'success')`,
      [principal.tenantId, principal.userId, principal.deviceId]
    );
    return reply.code(204).send();
  });
}

export function authenticate(db: Database) {
  return async (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,64})$/);
    if (!match) {
      return reply.code(401).send({ error: "unauthorized", message: "A valid online session is required." });
    }
    const tokenHash = hashSessionToken(match[1]);
    const result = await db.query(
      `SELECT s.id AS session_id, s.tenant_id, s.user_id, s.device_id,
              u.email, tm.role_key
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = s.tenant_id
       JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id
       JOIN registered_devices d ON d.id = s.device_id AND d.tenant_id = s.tenant_id AND d.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.status = 'active' AND t.status = 'active'
         AND tm.status = 'active' AND d.status = 'active'
       LIMIT 1`,
      [tokenHash]
    );
    const row = result.rows[0] as {
      session_id: string; tenant_id: string; user_id: string; device_id: string; email: string; role_key: string;
    } | undefined;
    if (!row) {
      return reply.code(401).send({ error: "session_invalid", message: "Session expired, revoked, or no longer authorized." });
    }
    request.principal = {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      deviceId: row.device_id,
      email: row.email,
      roleKey: row.role_key
    };
  };
}

// A fixed Argon2id hash keeps unknown-account login work closer to known-account work.
// This hash is a valid, non-secret dummy credential and can never authenticate a real account.
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$U1JTLU9yYmluZXgtZHVtbXktaGFzaA$Q7z8YJ7R9q4M2H0W2VJ4t8P3Hf6GQ8j5n2K6b8R9V0A";
export { hashPassword };
