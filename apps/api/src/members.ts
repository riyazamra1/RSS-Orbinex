import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, hashPassword } from "./auth.js";
import type { Database } from "./db.js";

const memberRole = z.enum(["owner", "admin", "accountant", "sales", "inventory", "viewer"]);
const createMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128).optional(),
  role: memberRole
}).strict();
const updateMemberSchema = z.object({
  role: memberRole.optional(),
  status: z.enum(["active", "revoked"]).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
const memberIdSchema = z.object({ userId: z.string().uuid() });

function mayManageMembers(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function registerMembers(app: FastifyInstance, db: Database) {
  app.get("/v1/admin/members", { preHandler: authenticate(db) }, async (request, reply) => {
    const principal = request.principal!;
    if (!mayManageMembers(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot view member administration." });
    const result = await db.query(
      `SELECT u.id,u.email,u.status AS user_status,tm.role_key,tm.status AS membership_status,tm.created_at,
              (SELECT COUNT(*)::int FROM auth_sessions s WHERE s.tenant_id=tm.tenant_id AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now()) AS active_sessions
       FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
       WHERE tm.tenant_id=$1 ORDER BY tm.created_at,u.email`,
      [principal.tenantId]
    );
    return { members: result.rows.map((row) => ({
      userId: row.id, email: row.email, userStatus: row.user_status, role: row.role_key,
      membershipStatus: row.membership_status, activeSessions: Number(row.active_sessions),
      joinedAt: new Date(row.created_at as string | Date).toISOString()
    })) };
  });

  app.post("/v1/admin/members", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = createMemberSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_member", message: "Provide a valid email, role, and a 12-character password when creating a new account." });
    const principal = request.principal!;
    if (!mayManageMembers(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage members." });
    const input = parsed.data;
    if (principal.roleKey === "admin" && ["owner", "admin"].includes(input.role)) {
      return reply.code(403).send({ error: "role_escalation_denied", message: "Only an owner can assign owner or administrator access." });
    }

    const passwordHash = input.password ? await hashPassword(input.password) : null;
    try {
      const result = await db.transaction(async (client) => {
        const userResult = await client.query(
          "SELECT id,email FROM users WHERE email_normalized=lower(trim($1)) FOR UPDATE",
          [input.email]
        );
        let user = userResult.rows[0] as { id: string; email: string } | undefined;
        let created = false;
        if (!user) {
          if (!passwordHash) throw new Error("NEW_USER_PASSWORD_REQUIRED");
          const createdUser = await client.query(
            "INSERT INTO users (email,password_hash,status,email_verified_at) VALUES ($1,$2,'active',now()) RETURNING id,email",
            [input.email,passwordHash]
          );
          user = createdUser.rows[0] as { id: string; email: string };
          created = true;
        }
        const existingMembership = await client.query(
          "SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
          [principal.tenantId,user.id]
        );
        if (existingMembership.rowCount === 1) {
          const status = String((existingMembership.rows[0] as { status: string }).status);
          if (status !== "revoked") throw new Error("MEMBERSHIP_ALREADY_EXISTS");
          await client.query(
            "UPDATE tenant_memberships SET role_key=$3,status='active' WHERE tenant_id=$1 AND user_id=$2",
            [principal.tenantId,user.id,input.role]
          );
        } else {
          await client.query(
            "INSERT INTO tenant_memberships (tenant_id,user_id,role_key,status) VALUES ($1,$2,$3,'active')",
            [principal.tenantId,user.id,input.role]
          );
        }
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'member.create','user',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,user.id,JSON.stringify({ role: input.role, createdUser: created, reactivated: existingMembership.rowCount === 1 })]
        );
        return { userId: user.id, email: user.email, role: input.role, createdUser: created };
      });
      return reply.code(201).send({ member: result });
    } catch (error) {
      if (error instanceof Error && error.message === "NEW_USER_PASSWORD_REQUIRED") return reply.code(400).send({ error: "password_required", message: "A new account requires an initial password of at least 12 characters." });
      if (error instanceof Error && error.message === "MEMBERSHIP_ALREADY_EXISTS") return reply.code(409).send({ error: "membership_exists", message: "This user already belongs to the business." });
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505") return reply.code(409).send({ error: "email_exists", message: "That email is already registered." });
      throw error;
    }
  });

  app.patch("/v1/admin/members/:userId", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = memberIdSchema.safeParse(request.params);
    const parsed = updateMemberSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_member_update", message: "Provide a valid user ID and at least one valid role or status." });
    const principal = request.principal!;
    if (!mayManageMembers(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage members." });
    const input = parsed.data;
    if (principal.roleKey === "admin" && input.role && ["owner", "admin"].includes(input.role)) {
      return reply.code(403).send({ error: "role_escalation_denied", message: "Only an owner can assign owner or administrator access." });
    }
    if (params.data.userId === principal.userId && input.status === "revoked") {
      return reply.code(400).send({ error: "cannot_revoke_self", message: "You cannot revoke your own membership from this screen." });
    }
    try {
      const result = await db.transaction(async (client) => {
        const membership = await client.query(
          "SELECT role_key,status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
          [principal.tenantId,params.data.userId]
        );
        if (membership.rowCount !== 1) throw new Error("MEMBERSHIP_NOT_FOUND");
        const current = membership.rows[0] as { role_key: string; status: string };
        const nextRole = input.role ?? current.role_key;
        const nextStatus = input.status ?? current.status;
        if (principal.roleKey === "admin" && ["owner", "admin"].includes(nextRole)) throw new Error("ROLE_ESCALATION_DENIED");
        if (current.role_key === "owner" && current.status === "active" && (nextRole !== "owner" || nextStatus !== "active")) {
          const owners = await client.query(
            "SELECT COUNT(*)::int AS count FROM tenant_memberships WHERE tenant_id=$1 AND role_key='owner' AND status='active'",
            [principal.tenantId]
          );
          if (Number((owners.rows[0] as { count: number | string }).count) <= 1) throw new Error("LAST_OWNER");
        }
        await client.query(
          "UPDATE tenant_memberships SET role_key=$3,status=$4 WHERE tenant_id=$1 AND user_id=$2",
          [principal.tenantId,params.data.userId,nextRole,nextStatus]
        );
        if (nextStatus === "revoked") {
          await client.query(
            "UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
            [principal.tenantId,params.data.userId]
          );
        }
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'member.update','user',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,params.data.userId,JSON.stringify({ role: nextRole, status: nextStatus })]
        );
        const user = await client.query("SELECT email,status FROM users WHERE id=$1",[params.data.userId]);
        return { userId: params.data.userId, email: (user.rows[0] as { email: string }).email, userStatus: (user.rows[0] as { status: string }).status, role: nextRole, membershipStatus: nextStatus };
      });
      return { member: result };
    } catch (error) {
      if (error instanceof Error && error.message === "MEMBERSHIP_NOT_FOUND") return reply.code(404).send({ error: "membership_not_found", message: "The user is not a member of this business." });
      if (error instanceof Error && error.message === "LAST_OWNER") return reply.code(409).send({ error: "last_owner_required", message: "A business must retain at least one active owner." });
      if (error instanceof Error && error.message === "ROLE_ESCALATION_DENIED") return reply.code(403).send({ error: "role_escalation_denied", message: "Only an owner can manage owner or administrator memberships." });
      throw error;
    }
  });
}
