import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const movementSchema = z.object({
  operationId: z.string().uuid(),
  productId: z.string().uuid(),
  movementType: z.enum(["opening","purchase","sale","customer_return","supplier_return","damage","adjustment_in","adjustment_out","transfer_in","transfer_out"]),
  quantity: z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,4})?$/).refine((value) => Number(value) > 0, "Quantity must be positive"),
  unitCost: z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,4})?$/).default("0"),
  reason: z.string().trim().min(1).max(500),
  sourceType: z.enum(["purchase","invoice","sales_return","damage","adjustment","transfer","opening"]).optional(),
  sourceId: z.string().uuid().optional()
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ":" + canonical(obj[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): Buffer {
  return createHash("sha256").update(canonical(value)).digest();
}
function signedQuantity(type: z.infer<typeof movementSchema>["movementType"], quantity: string): string {
  return ["sale","supplier_return","damage","adjustment_out","transfer_out"].includes(type) ? "-" + quantity : quantity;
}

export function registerBusiness(app: FastifyInstance, db: Database) {
  app.post("/v1/inventory/movements", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = movementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_stock_movement", message: "Provide a valid product, operation ID, movement type, positive quantity, and reason." });

    const principal = request.principal!;
    if (!["owner","admin","inventory"].includes(principal.roleKey)) {
      return reply.code(403).send({ error: "forbidden", message: "Your role cannot record stock movements." });
    }
    const input = parsed.data;
    const requestHash = digest(input);
    const delta = signedQuantity(input.movementType, input.quantity);

    try {
      const result = await db.transaction(async (client) => {
        const idemInsert = await client.query(
          "INSERT INTO idempotency_records (tenant_id, operation_id, operation_type, request_hash) VALUES ($1,$2,'inventory.movement',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId, input.operationId, requestHash]
        );
        if (idemInsert.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId, input.operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { movementId?: string; sequence?: string; balance?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 200 || !prior.response_body?.movementId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }

        const lockKey = principal.tenantId + ":product:" + input.productId;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
        const productResult = await client.query(
          "SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND is_active=true FOR UPDATE",
          [principal.tenantId, input.productId]
        );
        if (productResult.rowCount !== 1) throw new Error("PRODUCT_NOT_FOUND");

        const balanceResult = await client.query(
          "SELECT (COALESCE(SUM(quantity_delta),0) + $3::numeric) AS next_balance FROM stock_movements WHERE tenant_id=$1 AND product_id=$2",
          [principal.tenantId, input.productId, delta]
        );
        const nextBalance = String((balanceResult.rows[0] as { next_balance: string }).next_balance);
        if (Number(nextBalance) < 0) throw new Error("INSUFFICIENT_STOCK");

        const movementResult = await client.query(
          "INSERT INTO stock_movements (tenant_id,product_id,movement_type,quantity_delta,unit_cost,source_type,source_id,reason,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at",
          [principal.tenantId,input.productId,input.movementType,delta,input.unitCost,input.sourceType ?? null,input.sourceId ?? null,input.reason,principal.userId]
        );
        const movement = movementResult.rows[0] as { id: string; created_at: Date | string };
        const eventResult = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'stock_movement',$2,1,'upsert',$3::jsonb) RETURNING sequence_id",
          [principal.tenantId,movement.id,JSON.stringify({ productId: input.productId, movementType: input.movementType, quantityDelta: delta, balance: nextBalance })]
        );
        const sequence = String((eventResult.rows[0] as { sequence_id: string | number }).sequence_id);
        const responseBody = { movementId: movement.id, sequence, balance: nextBalance };
        await client.query(
          "UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,input.operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'inventory.movement','stock_movement',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,movement.id,JSON.stringify({ operationId: input.operationId, movementType: input.movementType, quantityDelta: delta })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: "product_not_found", message: "The product does not exist or is inactive." });
        if (error.message === "INSUFFICIENT_STOCK") return reply.code(409).send({ error: "insufficient_stock", message: "This movement would make stock negative." });
      }
      throw error;
    }
  });

  app.get("/v1/inventory/products/:productId/balance", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ productId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_product_id", message: "A valid product ID is required." });
    const principal = request.principal!;
    const result = await db.query(
      "SELECT p.id,p.sku,p.name,p.unit_code,COALESCE(SUM(sm.quantity_delta),0) AS balance FROM products p LEFT JOIN stock_movements sm ON sm.tenant_id=p.tenant_id AND sm.product_id=p.id WHERE p.tenant_id=$1 AND p.id=$2 GROUP BY p.id,p.sku,p.name,p.unit_code",
      [principal.tenantId,params.data.productId]
    );
    if (result.rowCount !== 1) return reply.code(404).send({ error: "product_not_found", message: "The product was not found." });
    const row = result.rows[0] as { id: string; sku: string; name: string; unit_code: string; balance: string };
    return { product: { id: row.id, sku: row.sku, name: row.name, unit: row.unit_code }, balance: row.balance };
  });
}
