import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const entities = ["customer", "supplier", "product", "invoice", "payment", "stock_movement", "sales_return", "stock_damage", "account", "journal_entry"] as const;
const operationSchema = z.object({
  operationId: z.string().uuid(),
  entityType: z.enum(entities),
  entityId: z.string().uuid(),
  changeType: z.enum(["upsert", "delete"]),
  payload: z.record(z.unknown()).nullable().optional()
}).superRefine((op, ctx) => {
  if (op.changeType === "upsert" && (!op.payload || Object.keys(op.payload).length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Upsert payload required", path: ["payload"] });
  }
  if (op.changeType === "delete" && op.payload != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Delete payload must be empty", path: ["payload"] });
  }
});
const pushSchema = z.object({ operations: z.array(operationSchema).min(1).max(100) });
const pullSchema = z.object({
  cursor: z.string().regex(/^\\d+$/).default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(stableJson(value)).digest();
}
function mayWrite(role: string, entity: string): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role === "accountant") return ["customer", "supplier", "invoice", "payment", "account", "journal_entry"].includes(entity);
  if (role === "sales") return ["customer", "invoice", "sales_return"].includes(entity);
  if (role === "inventory") return ["product", "stock_movement", "sales_return", "stock_damage"].includes(entity);
  return false;
}

export function registerSync(app: FastifyInstance, db: Database) {
  app.post("/v1/sync/push", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = pushSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_sync_batch", message: "Provide 1–100 valid sync operations." });
    const principal = request.principal!;
    const ops = parsed.data.operations;
    if (ops.some((op) => !mayWrite(principal.roleKey, op.entityType))) {
      return reply.code(403).send({ error: "forbidden", message: "Your role cannot submit one or more entity types." });
    }
    if (new Set(ops.map((op) => op.operationId)).size !== ops.length) {
      return reply.code(400).send({ error: "duplicate_operation_id", message: "Operation IDs must be unique within a batch." });
    }

    const results: Array<{ operationId: string; status: string; sequence: string }> = [];
    try {
      await db.transaction(async (client) => {
        for (const op of ops) {
          const hash = requestDigest(op);
          const inserted = await client.query(
            "INSERT INTO idempotency_records (tenant_id, operation_id, operation_type, request_hash) VALUES ($1, $2, 'sync.push', $3) ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id",
            [principal.tenantId, op.operationId, hash]
          );
          if (inserted.rowCount === 0) {
            const priorResult = await client.query(
              "SELECT request_hash, response_status, response_body FROM idempotency_records WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE",
              [principal.tenantId, op.operationId]
            );
            const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { sequence?: string } | null } | undefined;
            if (!prior || !Buffer.from(prior.request_hash).equals(hash)) throw new Error("IDEMPOTENCY_CONFLICT");
            const sequence = prior.response_body?.sequence;
            if (prior.response_status !== 200 || !sequence) throw new Error("IDEMPOTENCY_INCOMPLETE");
            results.push({ operationId: op.operationId, status: "replayed", sequence });
            continue;
          }

          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal.tenantId + ":" + op.entityType + ":" + op.entityId]);
          const versionResult = await client.query(
            "SELECT COALESCE(MAX(entity_version), 0) + 1 AS next_version FROM change_events WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3",
            [principal.tenantId, op.entityType, op.entityId]
          );
          const version = Number((versionResult.rows[0] as { next_version: string | number }).next_version);
          const eventResult = await client.query(
            "INSERT INTO change_events (tenant_id, entity_type, entity_id, entity_version, change_type, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING sequence_id",
            [principal.tenantId, op.entityType, op.entityId, version, op.changeType, op.changeType === "delete" ? null : JSON.stringify(op.payload)]
          );
          const sequence = String((eventResult.rows[0] as { sequence_id: string | number }).sequence_id);
          await client.query(
            "UPDATE idempotency_records SET response_status = 200, response_body = $3::jsonb, completed_at = now() WHERE tenant_id = $1 AND operation_id = $2",
            [principal.tenantId, op.operationId, JSON.stringify({ sequence })]
          );
          await client.query(
            "INSERT INTO audit_events (tenant_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata) VALUES ($1, $2, 'sync.push', $3, $4, 'success', jsonb_build_object('operationId', $5, 'sequence', $6))",
            [principal.tenantId, principal.userId, op.entityType, op.entityId, op.operationId, sequence]
          );
          results.push({ operationId: op.operationId, status: "accepted", sequence });
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
        return reply.code(409).send({ error: "idempotency_conflict", message: "An operation ID was reused with different content." });
      }
      throw error;
    }
    return { accepted: results.length, results };
  });

  app.get("/v1/sync/pull", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = pullSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_sync_cursor", message: "Cursor and limit are invalid." });
    const principal = request.principal!;
    const result = await db.query(
      "SELECT sequence_id, entity_type, entity_id, entity_version, change_type, payload, created_at FROM change_events WHERE tenant_id = $1 AND sequence_id > $2 ORDER BY sequence_id ASC LIMIT $3",
      [principal.tenantId, parsed.data.cursor, parsed.data.limit]
    );
    const events = result.rows.map((row) => ({
      sequence: String(row.sequence_id),
      entityType: row.entity_type,
      entityId: row.entity_id,
      version: Number(row.entity_version),
      changeType: row.change_type,
      payload: row.payload,
      createdAt: new Date(row.created_at as string | Date).toISOString()
    }));
    return {
      events,
      nextCursor: events.length ? events[events.length - 1]!.sequence : parsed.data.cursor,
      hasMore: events.length === parsed.data.limit
    };
  });
}
