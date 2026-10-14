import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const decimal = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,4})?$/, "Use a non-negative decimal with at most 4 fractional digits")
  .refine((value) => value !== "0" && !/^0(?:\.0{1,4})?$/.test(value), "Value must be positive");

const nonNegativeDecimal = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,4})?$/, "Use a non-negative decimal with at most 4 fractional digits");

const lineSchema = z.object({
  productId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: decimal,
  unitPrice: nonNegativeDecimal,
  discountAmount: nonNegativeDecimal.default("0"),
  taxAmount: nonNegativeDecimal.default("0")
}).strict();

const createInvoiceSchema = z.object({
  operationId: z.string().uuid(),
  invoiceNumber: z.string().trim().min(1).max(80),
  customerId: z.string().uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  issueDate: z.string().date().optional(),
  dueDate: z.string().date().optional(),
  lines: z.array(lineSchema).min(1).max(100)
}).strict().superRefine((input, ctx) => {
  if (input.issueDate && input.dueDate && input.dueDate < input.issueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dueDate"], message: "Due date cannot be before issue date" });
  }
});

const postInvoiceSchema = z.object({ operationId: z.string().uuid() }).strict();

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
function mayCreate(role: string): boolean {
  return ["owner", "admin", "accountant", "sales"].includes(role);
}
function mayPost(role: string): boolean {
  return ["owner", "admin", "accountant"].includes(role);
}

export function registerInvoices(app: FastifyInstance, db: Database) {
  app.get("/v1/invoices", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(["draft","posted","partially_paid","paid","void"]).optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0)
    }).strict().safeParse(request.query);
    if (!query.success || (query.data?.from && query.data?.to && query.data.from > query.data.to)) {
      return reply.code(400).send({ error: "invalid_invoice_filter", message: "Invoice filters or date range are invalid." });
    }
    const principal = request.principal!;
    const input = query.data;
    const result = await db.query(
      `SELECT i.id,i.invoice_number,i.customer_id,c.display_name AS customer_name,i.status,i.currency,
              i.issue_date,i.due_date,i.subtotal::text AS subtotal,i.discount_total::text AS discount_total,
              i.tax_total::text AS tax_total,i.grand_total::text AS grand_total,i.created_at,
              COALESCE((SELECT SUM(CASE WHEN p.direction='received' THEN p.amount ELSE -p.amount END)
                FROM payments p WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id),0)::text AS paid_total
       FROM invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
       WHERE i.tenant_id=$1 AND ($2::text IS NULL OR i.status=$2)
         AND ($3::date IS NULL OR i.issue_date >= $3::date) AND ($4::date IS NULL OR i.issue_date <= $4::date)
         AND ($5::text IS NULL OR i.invoice_number ILIKE '%' || $5 || '%' OR c.display_name ILIKE '%' || $5 || '%')
       ORDER BY i.issue_date DESC,i.created_at DESC LIMIT $6 OFFSET $7`,
      [principal.tenantId,input.status ?? null,input.from ?? null,input.to ?? null,input.q ?? null,input.limit,input.offset]
    );
    return { invoices: result.rows.map((row) => ({
      id: row.id, invoiceNumber: row.invoice_number, customerId: row.customer_id, customerName: row.customer_name,
      status: row.status, currency: row.currency, issueDate: row.issue_date, dueDate: row.due_date,
      subtotal: row.subtotal, discountTotal: row.discount_total, taxTotal: row.tax_total, grandTotal: row.grand_total,
      paidTotal: row.paid_total,
      balanceDue: String((Number(row.grand_total) - Number(row.paid_total)).toFixed(4)),
      createdAt: new Date(row.created_at as string | Date).toISOString()
    })), limit: input.limit, offset: input.offset };
  });

  app.get("/v1/invoices/:invoiceId", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ invoiceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_invoice_id", message: "A valid invoice ID is required." });
    const principal = request.principal!;
    const result = await db.query(
      `SELECT i.id,i.invoice_number,i.customer_id,c.display_name AS customer_name,i.status,i.currency,
              i.issue_date,i.due_date,i.subtotal::text AS subtotal,i.discount_total::text AS discount_total,
              i.tax_total::text AS tax_total,i.grand_total::text AS grand_total,i.posted_at,i.created_at,
              COALESCE((SELECT SUM(CASE WHEN p.direction='received' THEN p.amount ELSE -p.amount END)
                FROM payments p WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id),0)::text AS paid_total
       FROM invoices i JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
       WHERE i.tenant_id=$1 AND i.id=$2`,
      [principal.tenantId,params.data.invoiceId]
    );
    if (result.rowCount !== 1) return reply.code(404).send({ error: "invoice_not_found", message: "The invoice was not found in this business." });
    const row = result.rows[0]!;
    const lineResult = await db.query(
      `SELECT il.id,il.line_number,il.product_id,p.sku,il.description,il.quantity::text AS quantity,
              il.unit_price::text AS unit_price,il.discount_amount::text AS discount_amount,
              il.tax_amount::text AS tax_amount,il.line_total::text AS line_total
       FROM invoice_lines il LEFT JOIN products p ON p.tenant_id=il.tenant_id AND p.id=il.product_id
       WHERE il.tenant_id=$1 AND il.invoice_id=$2 ORDER BY il.line_number`,
      [principal.tenantId,params.data.invoiceId]
    );
    return { invoice: {
      id: row.id, invoiceNumber: row.invoice_number, customerId: row.customer_id, customerName: row.customer_name,
      status: row.status, currency: row.currency, issueDate: row.issue_date, dueDate: row.due_date,
      subtotal: row.subtotal, discountTotal: row.discount_total, taxTotal: row.tax_total, grandTotal: row.grand_total,
      paidTotal: row.paid_total, balanceDue: String((Number(row.grand_total) - Number(row.paid_total)).toFixed(4)),
      postedAt: row.posted_at ? new Date(row.posted_at as string | Date).toISOString() : null,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      lines: lineResult.rows.map((line) => ({
        id: line.id, lineNumber: line.line_number, productId: line.product_id, sku: line.sku,
        description: line.description, quantity: line.quantity, unitPrice: line.unit_price,
        discountAmount: line.discount_amount, taxAmount: line.tax_amount, lineTotal: line.line_total
      }))
    } };
  });

  app.post("/v1/invoices", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = createInvoiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_invoice", message: "Provide a valid invoice header and 1–100 valid lines." });
    }
    const principal = request.principal!;
    if (!mayCreate(principal.roleKey)) {
      return reply.code(403).send({ error: "forbidden", message: "Your role cannot create invoices." });
    }
    const input = parsed.data;
    const requestHash = digest(input);

    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'invoice.create',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId, input.operationId, requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId, input.operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { invoiceId?: string; invoiceNumber?: string; status?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 201 || !prior.response_body?.invoiceId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }

        const customer = await client.query(
          "SELECT id FROM customers WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
          [principal.tenantId, input.customerId]
        );
        if (customer.rowCount !== 1) throw new Error("CUSTOMER_NOT_FOUND");

        for (const line of input.lines) {
          if (line.productId) {
            const product = await client.query(
              "SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND is_active=true FOR SHARE",
              [principal.tenantId, line.productId]
            );
            if (product.rowCount !== 1) throw new Error("PRODUCT_NOT_FOUND");
          }
          const amountCheck = await client.query(
            "SELECT ($1::numeric * $2::numeric) >= $3::numeric AS discount_valid",
            [line.quantity, line.unitPrice, line.discountAmount]
          );
          if (!(amountCheck.rows[0] as { discount_valid: boolean }).discount_valid) throw new Error("INVALID_LINE_DISCOUNT");
        }

        const invoiceResult = await client.query(
          `INSERT INTO invoices (tenant_id,invoice_number,customer_id,status,currency,issue_date,due_date,created_by)
           VALUES ($1,$2,$3,'draft',$4,COALESCE($5::date,CURRENT_DATE),$6::date,$7)
           RETURNING id,invoice_number,status,issue_date,due_date`,
          [principal.tenantId,input.invoiceNumber,input.customerId,input.currency,input.issueDate ?? null,input.dueDate ?? null,principal.userId]
        );
        const invoice = invoiceResult.rows[0] as { id: string; invoice_number: string; status: string; issue_date: string; due_date: string | null };

        for (let index = 0; index < input.lines.length; index++) {
          const line = input.lines[index]!;
          await client.query(
            `INSERT INTO invoice_lines (tenant_id,invoice_id,line_number,product_id,description,quantity,unit_price,discount_amount,tax_amount)
             VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric)`,
            [principal.tenantId,invoice.id,index + 1,line.productId ?? null,line.description,line.quantity,line.unitPrice,line.discountAmount,line.taxAmount]
          );
        }

        const totalsResult = await client.query(
          `SELECT COALESCE(SUM(quantity * unit_price),0)::text AS subtotal,
                  COALESCE(SUM(discount_amount),0)::text AS discount_total,
                  COALESCE(SUM(tax_amount),0)::text AS tax_total,
                  COALESCE(SUM(line_total),0)::text AS grand_total
           FROM invoice_lines WHERE tenant_id=$1 AND invoice_id=$2`,
          [principal.tenantId,invoice.id]
        );
        const totals = totalsResult.rows[0] as { subtotal: string; discount_total: string; tax_total: string; grand_total: string };
        await client.query(
          "UPDATE invoices SET subtotal=$3::numeric,discount_total=$4::numeric,tax_total=$5::numeric,grand_total=$6::numeric WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId,invoice.id,totals.subtotal,totals.discount_total,totals.tax_total,totals.grand_total]
        );

        const event = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'invoice',$2,1,'upsert',$3::jsonb) RETURNING sequence_id",
          [principal.tenantId,invoice.id,JSON.stringify({ id: invoice.id, invoiceNumber: invoice.invoice_number, customerId: input.customerId, status: "draft", ...totals })]
        );
        const responseBody = {
          invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, status: "draft",
          issueDate: invoice.issue_date, dueDate: invoice.due_date, ...totals,
          sequence: String((event.rows[0] as { sequence_id: string | number }).sequence_id)
        };
        await client.query(
          "UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,input.operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'invoice.create','invoice',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,invoice.id,JSON.stringify({ operationId: input.operationId, lineCount: input.lines.length })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "CUSTOMER_NOT_FOUND") return reply.code(404).send({ error: "customer_not_found", message: "The customer does not exist or is inactive in this tenant." });
        if (error.message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: "product_not_found", message: "A line product does not exist or is inactive in this tenant." });
        if (error.message === "INVALID_LINE_DISCOUNT") return reply.code(400).send({ error: "invalid_discount", message: "A line discount cannot exceed its pre-tax line amount." });
      }
      // Unique invoice number conflicts are handled by the central database error handler.
      throw error;
    }
  });

  app.post("/v1/invoices/:invoiceId/post", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ invoiceId: z.string().uuid() }).safeParse(request.params);
    const parsed = postInvoiceSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_invoice_post", message: "A valid invoice ID and operation ID are required." });
    }
    const principal = request.principal!;
    if (!mayPost(principal.roleKey)) {
      return reply.code(403).send({ error: "forbidden", message: "Only an owner, administrator, or accountant can post invoices." });
    }
    const invoiceId = params.data.invoiceId;
    const { operationId } = parsed.data;
    const requestHash = digest({ invoiceId, operationId });

    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'invoice.post',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId,operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { invoiceId?: string; status?: string; grandTotal?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 200 || !prior.response_body?.invoiceId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }

        const invoiceResult = await client.query(
          "SELECT id,invoice_number,status,grand_total::text AS grand_total FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [principal.tenantId,invoiceId]
        );
        const invoice = invoiceResult.rows[0] as { id: string; invoice_number: string; status: string; grand_total: string } | undefined;
        if (!invoice) throw new Error("INVOICE_NOT_FOUND");
        if (invoice.status !== "draft") throw new Error("INVOICE_NOT_DRAFT");

        const lineResult = await client.query(
          `SELECT il.product_id,il.quantity::text AS quantity,p.product_type,p.is_active
           FROM invoice_lines il LEFT JOIN products p ON p.tenant_id=il.tenant_id AND p.id=il.product_id
           WHERE il.tenant_id=$1 AND il.invoice_id=$2 ORDER BY il.product_id NULLS LAST,il.line_number`,
          [principal.tenantId,invoiceId]
        );
        if (lineResult.rowCount === 0) throw new Error("INVOICE_EMPTY");
        const demand = new Map<string, string>();
        for (const row of lineResult.rows as Array<{ product_id: string | null; quantity: string; product_type: string | null; is_active: boolean | null }>) {
          if (row.product_id && row.is_active !== true) throw new Error("PRODUCT_NOT_FOUND");
          if (row.product_id && row.product_type === "stock") {
            const previous = demand.get(row.product_id);
            if (previous === undefined) demand.set(row.product_id,row.quantity);
            else {
              const sum = await client.query("SELECT ($1::numeric + $2::numeric)::text AS quantity", [previous,row.quantity]);
              demand.set(row.product_id,String((sum.rows[0] as { quantity: string }).quantity));
            }
          }
        }

        const productIds = [...demand.keys()].sort();
        for (const productId of productIds) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [principal.tenantId + ":product:" + productId]);
          const product = await client.query(
            "SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND is_active=true FOR UPDATE",
            [principal.tenantId,productId]
          );
          if (product.rowCount !== 1) throw new Error("PRODUCT_NOT_FOUND");
          const balance = await client.query(
            "SELECT COALESCE(SUM(quantity_delta),0)::text AS current_balance FROM stock_movements WHERE tenant_id=$1 AND product_id=$2",
            [principal.tenantId,productId]
          );
          const currentBalance = String((balance.rows[0] as { current_balance: string }).current_balance);
          const check = await client.query(
            "SELECT $1::numeric >= $2::numeric AS enough",
            [currentBalance,demand.get(productId)!]
          );
          if (!(check.rows[0] as { enough: boolean }).enough) throw new Error("INSUFFICIENT_STOCK");
        }

        const totalsResult = await client.query(
          `SELECT COALESCE(SUM(quantity * unit_price),0)::text AS subtotal,
                  COALESCE(SUM(discount_amount),0)::text AS discount_total,
                  COALESCE(SUM(tax_amount),0)::text AS tax_total,
                  COALESCE(SUM(line_total),0)::text AS grand_total
           FROM invoice_lines WHERE tenant_id=$1 AND invoice_id=$2`,
          [principal.tenantId,invoiceId]
        );
        const totals = totalsResult.rows[0] as { subtotal: string; discount_total: string; tax_total: string; grand_total: string };
        for (const [productId,quantity] of demand) {
          const lineCost = await client.query(
            "SELECT cost_price::text AS unit_cost FROM products WHERE tenant_id=$1 AND id=$2",
            [principal.tenantId,productId]
          );
          await client.query(
            `INSERT INTO stock_movements (tenant_id,product_id,movement_type,quantity_delta,unit_cost,source_type,source_id,reason,recorded_by)
             VALUES ($1,$2,'sale',-$3::numeric,$4::numeric,'invoice',$5,'Invoice posted',$6)`,
            [principal.tenantId,productId,quantity,String((lineCost.rows[0] as { unit_cost: string }).unit_cost),invoiceId,principal.userId]
          );
        }

        const update = await client.query(
          "UPDATE invoices SET status='posted',posted_at=now(),subtotal=$3::numeric,discount_total=$4::numeric,tax_total=$5::numeric,grand_total=$6::numeric WHERE tenant_id=$1 AND id=$2 RETURNING posted_at",
          [principal.tenantId,invoiceId,totals.subtotal,totals.discount_total,totals.tax_total,totals.grand_total]
        );
        const versionResult = await client.query(
          "SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='invoice' AND entity_id=$2",
          [principal.tenantId,invoiceId]
        );
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        const event = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'invoice',$2,$3,'upsert',$4::jsonb) RETURNING sequence_id",
          [principal.tenantId,invoiceId,version,JSON.stringify({ id: invoiceId, invoiceNumber: invoice.invoice_number, status: "posted", postedAt: new Date((update.rows[0] as { posted_at: Date | string }).posted_at).toISOString(), ...totals })]
        );
        const responseBody = {
          invoiceId, invoiceNumber: invoice.invoice_number, status: "posted", ...totals,
          sequence: String((event.rows[0] as { sequence_id: string | number }).sequence_id)
        };
        await client.query(
          "UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'invoice.post','invoice',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,invoiceId,JSON.stringify({ operationId, stockProducts: demand.size })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "INVOICE_NOT_FOUND") return reply.code(404).send({ error: "invoice_not_found", message: "The invoice was not found in this tenant." });
        if (error.message === "INVOICE_NOT_DRAFT") return reply.code(409).send({ error: "invoice_not_draft", message: "Only a draft invoice can be posted." });
        if (error.message === "INVOICE_EMPTY") return reply.code(409).send({ error: "invoice_empty", message: "An invoice needs at least one line before posting." });
        if (error.message === "PRODUCT_NOT_FOUND") return reply.code(409).send({ error: "product_not_found", message: "A line product is no longer active in this tenant." });
        if (error.message === "INSUFFICIENT_STOCK") return reply.code(409).send({ error: "insufficient_stock", message: "Posting would make one or more product balances negative." });
      }
      throw error;
    }
  });
}
