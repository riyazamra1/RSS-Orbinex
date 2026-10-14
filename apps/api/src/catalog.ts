import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/);
const address = z.record(z.unknown()).default({});
const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(24).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0)
}).strict();
const customerCreate = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  billingAddress: address.optional(),
  creditLimit: decimal.default("0"),
  status: z.enum(["active", "inactive", "blocked"]).default("active")
}).strict();
const customerUpdate = z.object({
  code: z.string().trim().min(1).max(50).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.union([z.string().trim().email().max(254), z.null()]).optional(),
  phone: z.union([z.string().trim().max(40), z.null()]).optional(),
  billingAddress: z.record(z.unknown()).optional(),
  creditLimit: decimal.optional(),
  status: z.enum(["active", "inactive", "blocked"]).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
const supplierCreate = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.record(z.unknown()).default({}),
  status: z.enum(["active", "inactive", "blocked"]).default("active")
}).strict();
const supplierUpdate = z.object({
  code: z.string().trim().min(1).max(50).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.union([z.string().trim().email().max(254), z.null()]).optional(),
  phone: z.union([z.string().trim().max(40), z.null()]).optional(),
  address: z.record(z.unknown()).optional(),
  status: z.enum(["active", "inactive", "blocked"]).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
const productCreate = z.object({
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  productType: z.enum(["stock", "service"]).default("stock"),
  description: z.string().trim().max(1000).optional(),
  unitCode: z.string().trim().min(1).max(24).default("each"),
  costPrice: decimal.default("0"),
  salePrice: decimal.default("0"),
  reorderLevel: decimal.default("0"),
  isActive: z.boolean().default(true)
}).strict();
const productUpdate = z.object({
  sku: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  productType: z.enum(["stock", "service"]).optional(),
  description: z.union([z.string().trim().max(1000), z.null()]).optional(),
  unitCode: z.string().trim().min(1).max(24).optional(),
  costPrice: decimal.optional(),
  salePrice: decimal.optional(),
  reorderLevel: decimal.optional(),
  isActive: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");
const idParam = z.object({ id: z.string().uuid() });

function mayManageCustomers(role: string): boolean {
  return ["owner", "admin", "accountant", "sales"].includes(role);
}
function mayManageSuppliersAndProducts(role: string): boolean {
  return ["owner", "admin", "accountant", "inventory"].includes(role);
}
function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

export function registerCatalog(app: FastifyInstance, db: Database) {
  app.get("/v1/customers", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_customer_filter", message: "Customer filters are invalid." });
    const principal = request.principal!;
    const { q, status, limit, offset } = parsed.data;
    const result = await db.query(
      `SELECT id,customer_code,display_name,email,phone,billing_address,credit_limit::text AS credit_limit,status,created_at,updated_at
       FROM customers WHERE tenant_id=$1
         AND ($2::text IS NULL OR status=$2)
         AND ($3::text IS NULL OR display_name ILIKE '%' || $3 || '%' OR customer_code ILIKE '%' || $3 || '%' OR COALESCE(email,'') ILIKE '%' || $3 || '%' OR COALESCE(phone,'') ILIKE '%' || $3 || '%')
       ORDER BY display_name,id LIMIT $4 OFFSET $5`,
      [principal.tenantId,status ?? null,q ?? null,limit,offset]
    );
    return { customers: result.rows.map((row) => ({
      id: row.id, code: row.customer_code, name: row.display_name, email: row.email,
      phone: row.phone, billingAddress: row.billing_address, creditLimit: row.credit_limit,
      status: row.status, createdAt: new Date(row.created_at as string | Date).toISOString(),
      updatedAt: new Date(row.updated_at as string | Date).toISOString()
    })), limit, offset };
  });

  app.get("/v1/customers/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_customer_id", message: "A valid customer ID is required." });
    const principal = request.principal!;
    const result = await db.query(
      "SELECT id,customer_code,display_name,email,phone,billing_address,credit_limit::text AS credit_limit,status,created_at,updated_at FROM customers WHERE tenant_id=$1 AND id=$2",
      [principal.tenantId,parsed.data.id]
    );
    if (result.rowCount !== 1) return reply.code(404).send({ error: "customer_not_found", message: "The customer was not found in this business." });
    const row = result.rows[0]!;
    return { customer: { id: row.id, code: row.customer_code, name: row.display_name, email: row.email, phone: row.phone, billingAddress: row.billing_address, creditLimit: row.credit_limit, status: row.status, createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() } };
  });

  app.post("/v1/customers", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = customerCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_customer", message: "Provide a customer code and name with valid optional contact and credit-limit fields." });
    const principal = request.principal!;
    if (!mayManageCustomers(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage customers." });
    const input = parsed.data;
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO customers (tenant_id,customer_code,display_name,email,phone,billing_address,credit_limit,status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::numeric,$8)
           RETURNING id,customer_code,display_name,email,phone,billing_address,credit_limit::text AS credit_limit,status,created_at,updated_at`,
          [principal.tenantId,input.code,input.name,input.email ?? null,input.phone ?? null,JSON.stringify(input.billingAddress ?? {}),input.creditLimit,input.status]
        );
        const row = inserted.rows[0]!;
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'customer.create','customer',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ code: input.code })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'customer',$2,1,'upsert',$3::jsonb)",[principal.tenantId,row.id,JSON.stringify({ id: row.id, code: row.customer_code, name: row.display_name, email: row.email, phone: row.phone, billingAddress: row.billing_address, creditLimit: row.credit_limit, status: row.status })]);
        return row;
      });
      return reply.code(201).send({ customer: { id: result.id, code: result.customer_code, name: result.display_name, email: result.email, phone: result.phone, billingAddress: result.billing_address, creditLimit: result.credit_limit, status: result.status } });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "customer_code_exists", message: "That customer code is already in use in this business." });
      throw error;
    }
  });

  app.patch("/v1/customers/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const parsed = customerUpdate.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_customer_update", message: "Provide a valid customer ID and at least one valid field." });
    const principal = request.principal!;
    if (!mayManageCustomers(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage customers." });
    const input = parsed.data;
    const fields: Array<[string, unknown]> = [
      ["customer_code",input.code],["display_name",input.name],["email",input.email],["phone",input.phone],
      ["billing_address",input.billingAddress === undefined ? undefined : JSON.stringify(input.billingAddress)],
      ["credit_limit",input.creditLimit],["status",input.status]
    ];
    const setFields = fields.filter((entry) => entry[1] !== undefined);
    const values: unknown[] = [principal.tenantId,params.data.id];
    const sets = setFields.map(([column,value]) => {
      values.push(value);
      const idx = values.length;
      return column === "billing_address" ? column + "=$" + idx + "::jsonb" : column === "credit_limit" ? column + "=$" + idx + "::numeric" : column + "=$" + idx;
    });
    values.push(new Date().toISOString());
    const updatedAtIndex = values.length;
    try {
      const result = await db.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE customers SET ${sets.join(",")},updated_at=$${updatedAtIndex}::timestamptz WHERE tenant_id=$1 AND id=$2
           RETURNING id,customer_code,display_name,email,phone,billing_address,credit_limit::text AS credit_limit,status,updated_at`,
          values
        );
        if (updated.rowCount !== 1) throw new Error("CUSTOMER_NOT_FOUND");
        const row = updated.rows[0]!;
        const versionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='customer' AND entity_id=$2",[principal.tenantId,row.id]);
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'customer.update','customer',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ changedFields: setFields.map(([column]) => column) })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'customer',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,row.id,version,JSON.stringify({ id: row.id, code: row.customer_code, name: row.display_name, email: row.email, phone: row.phone, billingAddress: row.billing_address, creditLimit: row.credit_limit, status: row.status })]);
        return row;
      });
      return { customer: { id: result.id, code: result.customer_code, name: result.display_name, email: result.email, phone: result.phone, billingAddress: result.billing_address, creditLimit: result.credit_limit, status: result.status, updatedAt: new Date(result.updated_at as string | Date).toISOString() } };
    } catch (error) {
      if (error instanceof Error && error.message === "CUSTOMER_NOT_FOUND") return reply.code(404).send({ error: "customer_not_found", message: "The customer was not found in this business." });
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "customer_code_exists", message: "That customer code is already in use in this business." });
      throw error;
    }
  });

  app.get("/v1/suppliers", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_supplier_filter", message: "Supplier filters are invalid." });
    const principal = request.principal!;
    const { q, status, limit, offset } = parsed.data;
    const result = await db.query(
      `SELECT id,supplier_code,display_name,email,phone,address,status,created_at,updated_at FROM suppliers
       WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::text IS NULL OR display_name ILIKE '%' || $3 || '%' OR supplier_code ILIKE '%' || $3 || '%' OR COALESCE(email,'') ILIKE '%' || $3 || '%' OR COALESCE(phone,'') ILIKE '%' || $3 || '%')
       ORDER BY display_name,id LIMIT $4 OFFSET $5`,
      [principal.tenantId,status ?? null,q ?? null,limit,offset]
    );
    return { suppliers: result.rows.map((row) => ({ id: row.id, code: row.supplier_code, name: row.display_name, email: row.email, phone: row.phone, address: row.address, status: row.status, createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() })), limit, offset };
  });

  app.get("/v1/suppliers/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_supplier_id", message: "A valid supplier ID is required." });
    const principal = request.principal!;
    const result = await db.query(
      "SELECT id,supplier_code,display_name,email,phone,address,status,created_at,updated_at FROM suppliers WHERE tenant_id=$1 AND id=$2",
      [principal.tenantId,parsed.data.id]
    );
    if (result.rowCount !== 1) return reply.code(404).send({ error: "supplier_not_found", message: "The supplier was not found in this business." });
    const row = result.rows[0]!;
    return { supplier: { id: row.id, code: row.supplier_code, name: row.display_name, email: row.email, phone: row.phone, address: row.address, status: row.status, createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() } };
  });

  app.patch("/v1/suppliers/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const parsed = supplierUpdate.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_supplier_update", message: "Provide a valid supplier ID and at least one valid field." });
    const principal = request.principal!;
    if (!mayManageSuppliersAndProducts(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage suppliers." });
    const input = parsed.data;
    const fields: Array<[string, unknown]> = [
      ["supplier_code",input.code],["display_name",input.name],["email",input.email],["phone",input.phone],
      ["address",input.address === undefined ? undefined : JSON.stringify(input.address)],["status",input.status]
    ];
    const setFields = fields.filter((entry) => entry[1] !== undefined);
    const values: unknown[] = [principal.tenantId,params.data.id];
    const sets = setFields.map(([column,value]) => {
      values.push(value);
      const idx = values.length;
      return column === "address" ? column + "=$" + idx + "::jsonb" : column + "=$" + idx;
    });
    values.push(new Date().toISOString());
    const updatedAtIndex = values.length;
    try {
      const result = await db.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE suppliers SET ${sets.join(",")},updated_at=${updatedAtIndex}::timestamptz WHERE tenant_id=$1 AND id=$2
           RETURNING id,supplier_code,display_name,email,phone,address,status,updated_at`,
          values
        );
        if (updated.rowCount !== 1) throw new Error("SUPPLIER_NOT_FOUND");
        const row = updated.rows[0]!;
        const versionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='supplier' AND entity_id=$2",[principal.tenantId,row.id]);
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'supplier.update','supplier',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ changedFields: setFields.map(([column]) => column) })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'supplier',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,row.id,version,JSON.stringify({ id: row.id, code: row.supplier_code, name: row.display_name, email: row.email, phone: row.phone, address: row.address, status: row.status })]);
        return row;
      });
      return { supplier: { id: result.id, code: result.supplier_code, name: result.display_name, email: result.email, phone: result.phone, address: result.address, status: result.status, updatedAt: new Date(result.updated_at as string | Date).toISOString() } };
    } catch (error) {
      if (error instanceof Error && error.message === "SUPPLIER_NOT_FOUND") return reply.code(404).send({ error: "supplier_not_found", message: "The supplier was not found in this business." });
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "supplier_code_exists", message: "That supplier code is already in use in this business." });
      throw error;
    }
  });

  app.post("/v1/suppliers", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = supplierCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_supplier", message: "Provide a supplier code and name with valid contact details." });
    const principal = request.principal!;
    if (!mayManageSuppliersAndProducts(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage suppliers." });
    const input = parsed.data;
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO suppliers (tenant_id,supplier_code,display_name,email,phone,address,status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
           RETURNING id,supplier_code,display_name,email,phone,address,status,created_at,updated_at`,
          [principal.tenantId,input.code,input.name,input.email ?? null,input.phone ?? null,JSON.stringify(input.address),input.status]
        );
        const row = inserted.rows[0]!;
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'supplier.create','supplier',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ code: input.code })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'supplier',$2,1,'upsert',$3::jsonb)",[principal.tenantId,row.id,JSON.stringify({ id: row.id, code: row.supplier_code, name: row.display_name, email: row.email, phone: row.phone, address: row.address, status: row.status })]);
        return row;
      });
      return reply.code(201).send({ supplier: { id: result.id, code: result.supplier_code, name: result.display_name, email: result.email, phone: result.phone, address: result.address, status: result.status } });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "supplier_code_exists", message: "That supplier code is already in use in this business." });
      throw error;
    }
  });

  app.get("/v1/products", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_product_filter", message: "Product filters are invalid." });
    const principal = request.principal!;
    const { q, status, limit, offset } = parsed.data;
    const result = await db.query(
      `SELECT p.id,p.sku,p.name,p.product_type,p.description,p.unit_code,p.cost_price::text AS cost_price,p.sale_price::text AS sale_price,p.reorder_level::text AS reorder_level,p.is_active,p.created_at,p.updated_at,
              COALESCE(SUM(sm.quantity_delta),0)::text AS stock_balance
       FROM products p LEFT JOIN stock_movements sm ON sm.tenant_id=p.tenant_id AND sm.product_id=p.id
       WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.is_active::text=$2 OR ($2='active' AND p.is_active=true) OR ($2='inactive' AND p.is_active=false))
         AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.sku ILIKE '%' || $3 || '%' OR COALESCE(p.description,'') ILIKE '%' || $3 || '%')
       GROUP BY p.id ORDER BY p.name,p.sku LIMIT $4 OFFSET $5`,
      [principal.tenantId,status ?? null,q ?? null,limit,offset]
    );
    return { products: result.rows.map((row) => ({ id: row.id, sku: row.sku, name: row.name, productType: row.product_type, description: row.description, unitCode: row.unit_code, costPrice: row.cost_price, salePrice: row.sale_price, reorderLevel: row.reorder_level, active: row.is_active, stockBalance: row.stock_balance, lowStock: row.product_type === "stock" && Number(row.stock_balance) <= Number(row.reorder_level), createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString() })), limit, offset };
  });

  app.get("/v1/products/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = idParam.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_product_id", message: "A valid product ID is required." });
    const principal = request.principal!;
    const result = await db.query(
      `SELECT p.id,p.sku,p.name,p.product_type,p.description,p.unit_code,p.cost_price::text AS cost_price,
              p.sale_price::text AS sale_price,p.reorder_level::text AS reorder_level,p.is_active,p.created_at,p.updated_at,
              COALESCE(SUM(sm.quantity_delta),0)::text AS stock_balance
       FROM products p LEFT JOIN stock_movements sm ON sm.tenant_id=p.tenant_id AND sm.product_id=p.id
       WHERE p.tenant_id=$1 AND p.id=$2
       GROUP BY p.id`,
      [principal.tenantId,parsed.data.id]
    );
    if (result.rowCount !== 1) return reply.code(404).send({ error: "product_not_found", message: "The product was not found in this business." });
    const row = result.rows[0]!;
    return { product: {
      id: row.id, sku: row.sku, name: row.name, productType: row.product_type, description: row.description,
      unitCode: row.unit_code, costPrice: row.cost_price, salePrice: row.sale_price,
      reorderLevel: row.reorder_level, active: row.is_active, stockBalance: row.stock_balance,
      lowStock: row.product_type === "stock" && Number(row.stock_balance) <= Number(row.reorder_level),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      updatedAt: new Date(row.updated_at as string | Date).toISOString()
    } };
  });

  app.post("/v1/products", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = productCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_product", message: "Provide a SKU, product name, and valid price/stock-threshold fields." });
    const principal = request.principal!;
    if (!mayManageSuppliersAndProducts(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage products." });
    const input = parsed.data;
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO products (tenant_id,sku,name,product_type,description,unit_code,cost_price,sale_price,reorder_level,is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10)
           RETURNING id,sku,name,product_type,description,unit_code,cost_price::text AS cost_price,sale_price::text AS sale_price,reorder_level::text AS reorder_level,is_active,created_at,updated_at`,
          [principal.tenantId,input.sku,input.name,input.productType,input.description ?? null,input.unitCode,input.costPrice,input.salePrice,input.reorderLevel,input.isActive]
        );
        const row = inserted.rows[0]!;
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'product.create','product',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ sku: input.sku })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'product',$2,1,'upsert',$3::jsonb)",[principal.tenantId,row.id,JSON.stringify({ id: row.id, sku: row.sku, name: row.name, productType: row.product_type, description: row.description, unitCode: row.unit_code, costPrice: row.cost_price, salePrice: row.sale_price, reorderLevel: row.reorder_level, isActive: row.is_active })]);
        return row;
      });
      return reply.code(201).send({ product: { id: result.id, sku: result.sku, name: result.name, productType: result.product_type, description: result.description, unitCode: result.unit_code, costPrice: result.cost_price, salePrice: result.sale_price, reorderLevel: result.reorder_level, active: result.is_active, stockBalance: "0" } });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "sku_exists", message: "That SKU is already in use in this business." });
      throw error;
    }
  });

  app.patch("/v1/products/:id", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const parsed = productUpdate.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_product_update", message: "Provide a valid product ID and at least one valid field." });
    const principal = request.principal!;
    if (!mayManageSuppliersAndProducts(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage products." });
    const input = parsed.data;
    const fields: Array<[string, unknown]> = [
      ["sku",input.sku],["name",input.name],["product_type",input.productType],["description",input.description],["unit_code",input.unitCode],
      ["cost_price",input.costPrice],["sale_price",input.salePrice],["reorder_level",input.reorderLevel],["is_active",input.isActive]
    ];
    const setFields = fields.filter((entry) => entry[1] !== undefined);
    const values: unknown[] = [principal.tenantId,params.data.id];
    const sets = setFields.map(([column,value]) => {
      values.push(value);
      const idx = values.length;
      return ["cost_price","sale_price","reorder_level"].includes(column) ? column + "=$" + idx + "::numeric" : column + "=$" + idx;
    });
    values.push(new Date().toISOString());
    const updatedAtIndex = values.length;
    try {
      const result = await db.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE products SET ${sets.join(",")},updated_at=${updatedAtIndex}::timestamptz WHERE tenant_id=$1 AND id=$2
           RETURNING id,sku,name,product_type,description,unit_code,cost_price::text AS cost_price,sale_price::text AS sale_price,reorder_level::text AS reorder_level,is_active,updated_at`,
          values
        );
        if (updated.rowCount !== 1) throw new Error("PRODUCT_NOT_FOUND");
        const row = updated.rows[0]!;
        const versionResult = await client.query("SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='product' AND entity_id=$2",[principal.tenantId,row.id]);
        const version = Number((versionResult.rows[0] as { version: string | number }).version);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'product.update','product',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,row.id,JSON.stringify({ changedFields: setFields.map(([column]) => column) })]);
        await client.query("INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'product',$2,$3,'upsert',$4::jsonb)",[principal.tenantId,row.id,version,JSON.stringify({ id: row.id, sku: row.sku, name: row.name, description: row.description, unitCode: row.unit_code, costPrice: row.cost_price, salePrice: row.sale_price, reorderLevel: row.reorder_level, isActive: row.is_active })]);
        return row;
      });
      return { product: { id: result.id, sku: result.sku, name: result.name, productType: result.product_type, description: result.description, unitCode: result.unit_code, costPrice: result.cost_price, salePrice: result.sale_price, reorderLevel: result.reorder_level, active: result.is_active, updatedAt: new Date(result.updated_at as string | Date).toISOString() } };
    } catch (error) {
      if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: "product_not_found", message: "The product was not found in this business." });
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "sku_exists", message: "That SKU is already in use in this business." });
      throw error;
    }
  });

  app.get("/v1/inventory/movements/history", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = z.object({
      productId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0)
    }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_movement_filter", message: "Inventory movement filters are invalid." });
    const principal = request.principal!;
    const result = await db.query(
      `SELECT sm.id,sm.product_id,p.sku,p.name,sm.movement_type,sm.quantity_delta::text AS quantity_delta,sm.unit_cost::text AS unit_cost,sm.source_type,sm.source_id,sm.reason,sm.occurred_at
       FROM stock_movements sm JOIN products p ON p.tenant_id=sm.tenant_id AND p.id=sm.product_id
       WHERE sm.tenant_id=$1 AND ($2::uuid IS NULL OR sm.product_id=$2)
       ORDER BY sm.occurred_at DESC,sm.id DESC LIMIT $3 OFFSET $4`,
      [principal.tenantId,parsed.data.productId ?? null,parsed.data.limit,parsed.data.offset]
    );
    return { movements: result.rows.map((row) => ({ id: row.id, productId: row.product_id, sku: row.sku, productName: row.name, type: row.movement_type, quantityDelta: row.quantity_delta, unitCost: row.unit_cost, sourceType: row.source_type, sourceId: row.source_id, reason: row.reason, occurredAt: new Date(row.occurred_at as string | Date).toISOString() })), limit: parsed.data.limit, offset: parsed.data.offset };
  });
}
