import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const quantitySchema = z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,4})?$/)
  .refine((value) => !/^0(?:\.0{1,4})?$/.test(value), "Quantity must be positive");
const createDamageSchema = z.object({
  operationId: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: quantitySchema,
  reason: z.string().trim().min(1).max(500)
}).strict();
const operationSchema = z.object({ operationId: z.string().uuid() }).strict();
const damageParams = z.object({ damageId: z.string().uuid() });
const decisionSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ":" + stableJson(obj[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): Buffer {
  return createHash("sha256").update(stableJson(value)).digest();
}
function mayReportDamage(role: string): boolean {
  return ["owner", "admin", "inventory"].includes(role);
}
function mayApproveDamage(role: string): boolean {
  return ["owner", "admin"].includes(role);
}

export function registerInventoryOperations(app: FastifyInstance, db: Database) {
  app.get("/v1/inventory/damages", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({
      status: z.enum(["reported","approved","rejected","written_off"]).optional(),
      productId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0)
    }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_damage_filter", message: "Damage filters are invalid." });
    const principal = request.principal!;
    const input = query.data;
    const result = await db.query(
      `SELECT d.id,d.product_id,p.sku,p.name,d.quantity::text AS quantity,d.reason,d.status,
              d.reported_by,d.approved_by,d.occurred_at,d.created_at
       FROM stock_damages d JOIN products p ON p.tenant_id=d.tenant_id AND p.id=d.product_id
       WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.status=$2)
         AND ($3::uuid IS NULL OR d.product_id=$3)
       ORDER BY d.created_at DESC,d.id DESC LIMIT $4 OFFSET $5`,
      [principal.tenantId,input.status ?? null,input.productId ?? null,input.limit,input.offset]
    );
    return { damages: result.rows.map((row) => ({
      id: row.id, productId: row.product_id, sku: row.sku, productName: row.name,
      quantity: row.quantity, reason: row.reason, status: row.status,
      reportedBy: row.reported_by, approvedBy: row.approved_by,
      occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
      createdAt: new Date(row.created_at as string | Date).toISOString()
    })), limit: input.limit, offset: input.offset };
  });

  app.post("/v1/inventory/damages", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = createDamageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_damage_report", message: "Provide a product, positive quantity, reason, and operation ID." });
    const principal = request.principal!;
    if (!mayReportDamage(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot report stock damage." });
    const input = parsed.data;
    const requestHash = digest(input);
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'inventory.damage.report',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,input.operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { damageId?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 201 || !prior.response_body?.damageId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }
        const product = await client.query("SELECT id,product_type,is_active FROM products WHERE tenant_id=$1 AND id=$2 FOR SHARE",[principal.tenantId,input.productId]);
        if (product.rowCount !== 1 || !(product.rows[0] as { is_active: boolean }).is_active) throw new Error("PRODUCT_NOT_FOUND");
        if ((product.rows[0] as { product_type: string }).product_type !== "stock") throw new Error("SERVICE_ITEM_NO_STOCK");
        const created = await client.query(
          "INSERT INTO stock_damages (tenant_id,product_id,quantity,reason,status,reported_by) VALUES ($1,$2,$3::numeric,$4,'reported',$5) RETURNING id,quantity::text AS quantity,reason,status,occurred_at,created_at",
          [principal.tenantId,input.productId,input.quantity,input.reason,principal.userId]
        );
        const row = created.rows[0] as { id: string; quantity: string; reason: string; status: string; occurred_at: Date | string; created_at: Date | string };
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_damage',$2,1,'upsert',$3::jsonb)",[principal.tenantId,row.id,JSON.stringify({ id: row.id, productId: input.productId, quantity: row.quantity, reason: row.reason, status: row.status })]);
        const responseBody = { damageId: row.id, productId: input.productId, quantity: row.quantity, reason: row.reason, status: row.status };
        await client.query("UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'inventory.damage.report','stock_damage',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ operationId: input.operationId, productId: input.productId, quantity: input.quantity })]);
        return { ...responseBody, replayed: false };
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: "product_not_found", message: "The product was not found or is inactive." });
        if (error.message === "SERVICE_ITEM_NO_STOCK") return reply.code(400).send({ error: "service_item_has_no_stock", message: "Damage reports are only allowed for stock-tracked products." });
      }
      throw error;
    }
  });

  app.post("/v1/inventory/damages/:damageId/approve", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = damageParams.safeParse(request.params);
    const parsed = decisionSchema.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_damage_decision", message: "A valid damage ID and optional reason are required." });
    const principal = request.principal!;
    if (!mayApproveDamage(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Only an owner or administrator can approve stock damage." });
    try {
      const result = await db.transaction(async (client) => {
        const selected = await client.query("SELECT id,product_id,quantity::text AS quantity,reason,status,reported_by FROM stock_damages WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,params.data.damageId]);
        const damage = selected.rows[0] as { id: string; product_id: string; quantity: string; reason: string; status: string; reported_by: string } | undefined;
        if (!damage) throw new Error("DAMAGE_NOT_FOUND");
        if (damage.status !== "reported") throw new Error("DAMAGE_NOT_REPORTED");
        if (damage.reported_by === principal.userId) throw new Error("SELF_APPROVAL");
        await client.query("UPDATE stock_damages SET status='approved',approved_by=$3 WHERE tenant_id=$1 AND id=$2",[principal.tenantId,damage.id,principal.userId]);
        const versionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='stock_damage' AND entity_id=$2",[principal.tenantId,damage.id]);
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_damage',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,damage.id,version,JSON.stringify({ id: damage.id, productId: damage.product_id, quantity: damage.quantity, reason: damage.reason, status: "approved", approvedBy: principal.userId })]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'inventory.damage.approve','stock_damage',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,damage.id,JSON.stringify({ decisionReason: parsed.data.reason ?? null })]);
        return { damageId: damage.id, status: "approved", approvedBy: principal.userId };
      });
      return { damage: result };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "DAMAGE_NOT_FOUND") return reply.code(404).send({ error: "damage_not_found", message: "The damage report was not found in this business." });
        if (error.message === "DAMAGE_NOT_REPORTED") return reply.code(409).send({ error: "damage_not_reported", message: "Only reported damage can be approved." });
        if (error.message === "SELF_APPROVAL") return reply.code(403).send({ error: "self_approval_denied", message: "The person who reported damage cannot approve the same report." });
      }
      throw error;
    }
  });

  app.post("/v1/inventory/damages/:damageId/reject", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = damageParams.safeParse(request.params);
    const parsed = decisionSchema.safeParse(request.body ?? {});
    if (!params.success || !parsed.success || !parsed.data.reason) return reply.code(400).send({ error: "invalid_damage_rejection", message: "A valid damage ID and rejection reason are required." });
    const principal = request.principal!;
    if (!mayApproveDamage(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Only an owner or administrator can reject stock damage." });
    try {
      const result = await db.transaction(async (client) => {
        const selected = await client.query("SELECT id,product_id,quantity::text AS quantity,reason,status FROM stock_damages WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,params.data.damageId]);
        const damage = selected.rows[0] as { id: string; product_id: string; quantity: string; reason: string; status: string } | undefined;
        if (!damage) throw new Error("DAMAGE_NOT_FOUND");
        if (damage.status !== "reported") throw new Error("DAMAGE_NOT_REPORTED");
        await client.query("UPDATE stock_damages SET status='rejected' WHERE tenant_id=$1 AND id=$2",[principal.tenantId,damage.id]);
        const versionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='stock_damage' AND entity_id=$2",[principal.tenantId,damage.id]);
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_damage',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,damage.id,version,JSON.stringify({ id: damage.id, productId: damage.product_id, quantity: damage.quantity, reason: damage.reason, status: "rejected", rejectionReason: parsed.data.reason })]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'inventory.damage.reject','stock_damage',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,damage.id,JSON.stringify({ rejectionReason: parsed.data.reason })]);
        return { damageId: damage.id, status: "rejected" };
      });
      return { damage: result };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "DAMAGE_NOT_FOUND") return reply.code(404).send({ error: "damage_not_found", message: "The damage report was not found in this business." });
        if (error.message === "DAMAGE_NOT_REPORTED") return reply.code(409).send({ error: "damage_not_reported", message: "Only reported damage can be rejected." });
      }
      throw error;
    }
  });

  app.post("/v1/inventory/damages/:damageId/write-off", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = damageParams.safeParse(request.params);
    const parsed = operationSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_damage_write_off", message: "A valid damage ID and operation ID are required." });
    const principal = request.principal!;
    if (!mayReportDamage(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot write off stock damage." });
    const damageId = params.data.damageId;
    const operationId = parsed.data.operationId;
    const requestHash = digest({ damageId, operationId });
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query("INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'inventory.damage.writeoff',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",[principal.tenantId,operationId,requestHash]);
        if (inserted.rowCount === 0) {
          const priorResult = await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,operationId]);
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { damageId?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 200 || !prior.response_body?.damageId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }
        const selected = await client.query("SELECT id,product_id,quantity::text AS quantity,reason,status FROM stock_damages WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,damageId]);
        const damage = selected.rows[0] as { id: string; product_id: string; quantity: string; reason: string; status: string } | undefined;
        if (!damage) throw new Error("DAMAGE_NOT_FOUND");
        if (damage.status !== "approved") throw new Error("DAMAGE_NOT_APPROVED");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[principal.tenantId + ":product:" + damage.product_id]);
        const productResult = await client.query("SELECT id,product_type,cost_price::text AS cost_price,is_active FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,damage.product_id]);
        const product = productResult.rows[0] as { id: string; product_type: string; cost_price: string; is_active: boolean } | undefined;
        if (!product || !product.is_active) throw new Error("PRODUCT_NOT_FOUND");
        if (product.product_type !== "stock") throw new Error("SERVICE_ITEM_NO_STOCK");
        const balanceResult = await client.query("SELECT COALESCE(SUM(quantity_delta),0)::text AS balance FROM stock_movements WHERE tenant_id=$1 AND product_id=$2",[principal.tenantId,damage.product_id]);
        const balance = String((balanceResult.rows[0] as { balance: string }).balance);
        const enough = await client.query("SELECT $1::numeric >= $2::numeric AS enough",[balance,damage.quantity]);
        if (!(enough.rows[0] as { enough: boolean }).enough) throw new Error("INSUFFICIENT_STOCK");
        const movement = await client.query(
          "INSERT INTO stock_movements (tenant_id,product_id,movement_type,quantity_delta,unit_cost,source_type,source_id,reason,recorded_by) VALUES ($1,$2,'damage',-$3::numeric,$4::numeric,'damage',$5,$6,$7) RETURNING id",
          [principal.tenantId,damage.product_id,damage.quantity,product.cost_price,damage.id,damage.reason,principal.userId]
        );
        const movementId = String((movement.rows[0] as { id: string }).id);
        await client.query("UPDATE stock_damages SET status='written_off' WHERE tenant_id=$1 AND id=$2",[principal.tenantId,damage.id]);
        const movementEvent = await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_movement',$2,1,'upsert',$3::jsonb) RETURNING sequence_id",[principal.tenantId,movementId,JSON.stringify({ id: movementId, productId: damage.product_id, movementType: "damage", quantityDelta: "-" + damage.quantity, sourceType: "damage", sourceId: damage.id, reason: damage.reason })]);
        const damageVersionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='stock_damage' AND entity_id=$2",[principal.tenantId,damage.id]);
        const damageVersion = Number((damageVersionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_damage',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,damage.id,damageVersion,JSON.stringify({ id: damage.id, productId: damage.product_id, quantity: damage.quantity, reason: damage.reason, status: "written_off", stockMovementId: movementId })]);
        const responseBody = { damageId: damage.id, movementId, status: "written_off", quantity: damage.quantity, balance: String((await client.query("SELECT COALESCE(SUM(quantity_delta),0)::text AS balance FROM stock_movements WHERE tenant_id=$1 AND product_id=$2",[principal.tenantId,damage.product_id])).rows[0]?.balance ?? "0"), sequence: String((movementEvent.rows[0] as { sequence_id: string | number }).sequence_id) };
        await client.query("UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'inventory.damage.writeoff','stock_damage',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,damage.id,JSON.stringify({ operationId, movementId, quantity: damage.quantity })]);
        return { ...responseBody, replayed: false };
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "DAMAGE_NOT_FOUND") return reply.code(404).send({ error: "damage_not_found", message: "The damage report was not found in this business." });
        if (error.message === "DAMAGE_NOT_APPROVED") return reply.code(409).send({ error: "damage_not_approved", message: "Only approved damage can be written off." });
        if (error.message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: "product_not_found", message: "The product was not found or is inactive." });
        if (error.message === "SERVICE_ITEM_NO_STOCK") return reply.code(400).send({ error: "service_item_has_no_stock", message: "Only stock-tracked products can be written off." });
        if (error.message === "INSUFFICIENT_STOCK") return reply.code(409).send({ error: "insufficient_stock", message: "The write-off would make stock negative." });
      }
      throw error;
    }
  });
}
