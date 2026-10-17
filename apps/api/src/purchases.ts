import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const positive = z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/)
  .refine((value) => !/^0(?:\.0{1,4})?$/.test(value), "Value must be positive");
const nonNegative = z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/);
const lineSchema = z.object({
  productId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: positive,
  unitCost: nonNegative,
  taxAmount: nonNegative.default("0")
}).strict();
const createSchema = z.object({
  operationId: z.string().uuid(),
  billNumber: z.string().trim().min(1).max(80),
  supplierId: z.string().uuid(),
  supplierInvoiceNumber: z.string().trim().max(100).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  billDate: z.string().date().optional(),
  dueDate: z.string().date().optional(),
  lines: z.array(lineSchema).min(1).max(100)
}).strict().superRefine((input, ctx) => {
  if (input.billDate && input.dueDate && input.dueDate < input.billDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dueDate"], message: "Due date cannot be before bill date" });
  }
});
const postSchema = z.object({
  operationId: z.string().uuid(),
  journalNumber: z.string().trim().min(1).max(80),
  purchaseAccountId: z.string().uuid(),
  payableAccountId: z.string().uuid()
}).strict().refine((v) => v.purchaseAccountId !== v.payableAccountId, { path: ["payableAccountId"], message: "Accounts must differ" });

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
function canCreate(role: string): boolean {
  return ["owner", "admin", "accountant", "purchasing"].includes(role);
}
function canPost(role: string): boolean {
  return ["owner", "admin", "accountant"].includes(role);
}

export function registerPurchases(app: FastifyInstance, db: Database) {
  app.get("/v1/purchase-bills", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = z.object({
      supplierId: z.string().uuid().optional(),
      status: z.enum(["draft","posted","partially_paid","paid","void"]).optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      q: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0)
    }).strict().safeParse(request.query);
    if (!parsed.success || (parsed.data?.from && parsed.data?.to && parsed.data.from > parsed.data.to)) {
      return reply.code(400).send({ error: "invalid_purchase_bill_filter", message: "Purchase bill filters are invalid." });
    }
    const p = parsed.data;
    const result = await db.query(
      `SELECT b.id,b.bill_number,b.supplier_invoice_number,b.supplier_id,s.display_name AS supplier_name,
              b.status,b.currency,b.bill_date,b.due_date,b.subtotal::text AS subtotal,
              b.tax_total::text AS tax_total,b.grand_total::text AS grand_total,
              COALESCE(pay.paid_total,0)::text AS paid_total,
              (b.grand_total-COALESCE(pay.paid_total,0))::text AS balance_due,b.created_at
       FROM purchase_bills b JOIN suppliers s ON s.tenant_id=b.tenant_id AND s.id=b.supplier_id
       LEFT JOIN LATERAL (SELECT SUM(amount) AS paid_total FROM supplier_payments sp
         WHERE sp.tenant_id=b.tenant_id AND sp.bill_id=b.id) pay ON TRUE
       WHERE b.tenant_id=$1 AND ($2::uuid IS NULL OR b.supplier_id=$2)
         AND ($3::text IS NULL OR b.status=$3)
         AND ($4::date IS NULL OR b.bill_date >= $4::date)
         AND ($5::date IS NULL OR b.bill_date <= $5::date)
         AND ($6::text IS NULL OR b.bill_number ILIKE '%'||$6||'%' OR s.display_name ILIKE '%'||$6||'%')
       ORDER BY b.bill_date DESC,b.created_at DESC LIMIT $7 OFFSET $8`,
      [request.principal!.tenantId,p.supplierId ?? null,p.status ?? null,p.from ?? null,p.to ?? null,p.q ?? null,p.limit,p.offset]
    );
    return { purchaseBills: result.rows.map((r) => ({
      id:r.id,billNumber:r.bill_number,supplierInvoiceNumber:r.supplier_invoice_number,
      supplierId:r.supplier_id,supplierName:r.supplier_name,status:r.status,currency:r.currency,
      billDate:r.bill_date,dueDate:r.due_date,subtotal:r.subtotal,taxTotal:r.tax_total,
      grandTotal:r.grand_total,paidTotal:r.paid_total,balanceDue:r.balance_due,
      createdAt:new Date(r.created_at as string|Date).toISOString()
    })),limit:p.limit,offset:p.offset };
  });

  app.get("/v1/purchase-bills/:billId", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ billId:z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({error:"invalid_purchase_bill_id",message:"A valid bill ID is required."});
    const tenantId = request.principal!.tenantId;
    const billResult = await db.query(
      `SELECT b.id,b.bill_number,b.supplier_invoice_number,b.supplier_id,s.display_name AS supplier_name,
              b.status,b.currency,b.bill_date,b.due_date,b.subtotal::text AS subtotal,
              b.tax_total::text AS tax_total,b.grand_total::text AS grand_total,b.posted_at,b.created_at,
              COALESCE(pay.paid_total,0)::text AS paid_total,
              (b.grand_total-COALESCE(pay.paid_total,0))::text AS balance_due
       FROM purchase_bills b JOIN suppliers s ON s.tenant_id=b.tenant_id AND s.id=b.supplier_id
       LEFT JOIN LATERAL (SELECT SUM(amount) AS paid_total FROM supplier_payments sp
         WHERE sp.tenant_id=b.tenant_id AND sp.bill_id=b.id) pay ON TRUE
       WHERE b.tenant_id=$1 AND b.id=$2`,
      [tenantId,params.data.billId]
    );
    if (billResult.rowCount !== 1) return reply.code(404).send({error:"purchase_bill_not_found",message:"Purchase bill not found."});
    const row = billResult.rows[0]!;
    const lines = await db.query(
      `SELECT l.id,l.line_number,l.product_id,p.sku,l.description,l.quantity::text AS quantity,
              l.unit_cost::text AS unit_cost,l.tax_amount::text AS tax_amount,l.line_total::text AS line_total
       FROM purchase_bill_lines l LEFT JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
       WHERE l.tenant_id=$1 AND l.bill_id=$2 ORDER BY l.line_number`,
      [tenantId,params.data.billId]
    );
    const payments = await db.query(
      `SELECT id,payment_number,amount::text AS amount,currency,method,reference,paid_at
       FROM supplier_payments WHERE tenant_id=$1 AND bill_id=$2 ORDER BY paid_at DESC`,
      [tenantId,params.data.billId]
    );
    return { purchaseBill:{
      id:row.id,billNumber:row.bill_number,supplierInvoiceNumber:row.supplier_invoice_number,
      supplierId:row.supplier_id,supplierName:row.supplier_name,status:row.status,currency:row.currency,
      billDate:row.bill_date,dueDate:row.due_date,subtotal:row.subtotal,taxTotal:row.tax_total,
      grandTotal:row.grand_total,paidTotal:row.paid_total,balanceDue:row.balance_due,
      postedAt:row.posted_at ? new Date(row.posted_at as string|Date).toISOString() : null,
      createdAt:new Date(row.created_at as string|Date).toISOString(),
      lines:lines.rows.map((l)=>({id:l.id,lineNumber:l.line_number,productId:l.product_id,sku:l.sku,
        description:l.description,quantity:l.quantity,unitCost:l.unit_cost,taxAmount:l.tax_amount,lineTotal:l.line_total})),
      payments:payments.rows.map((p)=>({id:p.id,paymentNumber:p.payment_number,amount:p.amount,
        currency:p.currency,method:p.method,reference:p.reference,paidAt:new Date(p.paid_at as string|Date).toISOString()}))
    }};
  });

  app.post("/v1/purchase-bills", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:"invalid_purchase_bill",message:"Provide a valid supplier bill and 1–100 lines."});
    const principal = request.principal!;
    if (!canCreate(principal.roleKey)) return reply.code(403).send({error:"forbidden",message:"Your role cannot create purchase bills."});
    const input = parsed.data;
    const requestHash = digest(input);
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'purchase_bill.create',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,input.operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const previous = await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior = previous.rows[0] as {request_hash:Buffer;response_status:number|null;response_body:{purchaseBillId?:string;billNumber?:string}|null}|undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 201 || !prior.response_body?.purchaseBillId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return {...prior.response_body,replayed:true};
        }
        const supplier = await client.query("SELECT id FROM suppliers WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",[principal.tenantId,input.supplierId]);
        if (supplier.rowCount !== 1) throw new Error("SUPPLIER_NOT_FOUND");
        for (const line of input.lines) if (line.productId) {
          const product = await client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND is_active=true FOR SHARE",[principal.tenantId,line.productId]);
          if (product.rowCount !== 1) throw new Error("PRODUCT_NOT_FOUND");
        }
        const billResult = await client.query(
          `INSERT INTO purchase_bills (tenant_id,bill_number,supplier_id,supplier_invoice_number,status,currency,bill_date,due_date,created_by)
           VALUES ($1,$2,$3,$4,'draft',$5,COALESCE($6::date,CURRENT_DATE),$7::date,$8)
           RETURNING id,bill_number,status,bill_date,due_date`,
          [principal.tenantId,input.billNumber,input.supplierId,input.supplierInvoiceNumber ?? null,input.currency,input.billDate ?? null,input.dueDate ?? null,principal.userId]
        );
        const bill = billResult.rows[0] as {id:string;bill_number:string;status:string;bill_date:string;due_date:string|null};
        for (let i=0;i<input.lines.length;i++) {
          const line=input.lines[i]!;
          await client.query(
            `INSERT INTO purchase_bill_lines (tenant_id,bill_id,line_number,product_id,description,quantity,unit_cost,tax_amount)
             VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric)`,
            [principal.tenantId,bill.id,i+1,line.productId ?? null,line.description,line.quantity,line.unitCost,line.taxAmount]
          );
        }
        const totalResult = await client.query(
          `SELECT COALESCE(SUM(quantity*unit_cost),0)::text AS subtotal,
                  COALESCE(SUM(tax_amount),0)::text AS tax_total,COALESCE(SUM(line_total),0)::text AS grand_total
           FROM purchase_bill_lines WHERE tenant_id=$1 AND bill_id=$2`,
          [principal.tenantId,bill.id]
        );
        const totals = totalResult.rows[0] as {subtotal:string;tax_total:string;grand_total:string};
        await client.query("UPDATE purchase_bills SET subtotal=$3::numeric,tax_total=$4::numeric,grand_total=$5::numeric WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId,bill.id,totals.subtotal,totals.tax_total,totals.grand_total]);
        const responseBody={purchaseBillId:bill.id,billNumber:bill.bill_number,status:"draft",...totals};
        await client.query("UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'purchase_bill.create','purchase_bill',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,bill.id,JSON.stringify({operationId:input.operationId,lineCount:input.lines.length})]);
        return {...responseBody,replayed:false};
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message==="IDEMPOTENCY_CONFLICT") return reply.code(409).send({error:"idempotency_conflict",message:"The operation ID was already used with different content."});
        if (error.message==="IDEMPOTENCY_INCOMPLETE") return reply.code(409).send({error:"idempotency_incomplete",message:"The previous operation did not complete; retry with a new operation ID."});
        if (error.message==="SUPPLIER_NOT_FOUND") return reply.code(404).send({error:"supplier_not_found",message:"Supplier does not exist or is inactive."});
        if (error.message==="PRODUCT_NOT_FOUND") return reply.code(404).send({error:"product_not_found",message:"A bill product does not exist or is inactive."});
      }
      throw error;
    }
  });

  app.post("/v1/purchase-bills/:billId/post", { preHandler: authenticate(db) }, async (request, reply) => {
    const params=z.object({billId:z.string().uuid()}).safeParse(request.params);
    const parsed=postSchema.safeParse(request.body);
    if (!params.success||!parsed.success) return reply.code(400).send({error:"invalid_purchase_bill_post",message:"Bill ID, operation ID, journal number and accounts are required."});
    const principal=request.principal!;
    if (!canPost(principal.roleKey)) return reply.code(403).send({error:"forbidden",message:"Only an owner, administrator or accountant can post purchase bills."});
    const billId=params.data.billId,input=parsed.data,requestHash=digest({billId,...input});
    try {
      const result=await db.transaction(async(client)=>{
        const inserted=await client.query("INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'purchase_bill.post',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",[principal.tenantId,input.operationId,requestHash]);
        if(inserted.rowCount===0){
          const previous=await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior=previous.rows[0] as {request_hash:Buffer;response_status:number|null;response_body:{purchaseBillId?:string;status?:string}|null}|undefined;
          if(!prior||!Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if(prior.response_status!==200||!prior.response_body?.purchaseBillId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return {...prior.response_body,replayed:true};
        }
        const selected=await client.query("SELECT id,bill_number,supplier_id,status,currency,grand_total::text AS grand_total FROM purchase_bills WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,billId]);
        const bill=selected.rows[0] as {id:string;bill_number:string;supplier_id:string;status:string;currency:string;grand_total:string}|undefined;
        if(!bill) throw new Error("PURCHASE_BILL_NOT_FOUND");
        if(bill.status!=="draft") throw new Error("PURCHASE_BILL_NOT_DRAFT");
        if(Number(bill.grand_total)<=0) throw new Error("PURCHASE_BILL_ZERO_TOTAL");
        const accounts=await client.query("SELECT id,account_type FROM accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND is_active=true",[principal.tenantId,[input.purchaseAccountId,input.payableAccountId]]);
        const rows=accounts.rows as Array<{id:string;account_type:string}>;
        if(rows.length!==2||!rows.some(a=>a.id===input.purchaseAccountId&&["asset","expense"].includes(a.account_type))||!rows.some(a=>a.id===input.payableAccountId&&a.account_type==="liability")) throw new Error("INVALID_PURCHASE_ACCOUNTS");
        const lineResult=await client.query("SELECT product_id,quantity::text AS quantity,unit_cost::text AS unit_cost FROM purchase_bill_lines WHERE tenant_id=$1 AND bill_id=$2 ORDER BY line_number",[principal.tenantId,billId]);
        if(lineResult.rowCount===0) throw new Error("PURCHASE_BILL_EMPTY");
        const journalResult=await client.query(
          `INSERT INTO journal_entries (tenant_id,journal_number,entry_date,description,status,currency,source_type,source_id,posted_at,posted_by)
           SELECT $1,$2,bill_date,'Supplier bill '||bill_number,'draft',$3,'purchase_bill',$4,NULL,$5 FROM purchase_bills WHERE tenant_id=$1 AND id=$4
           RETURNING id`,
          [principal.tenantId,input.journalNumber,bill.currency,billId,principal.userId]
        );
        const journalId=String((journalResult.rows[0] as {id:string}).id);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,1,$3,$4::numeric,0,'Supplier purchase')",
          [principal.tenantId,journalId,input.purchaseAccountId,bill.grand_total]);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,2,$3,0,$4::numeric,'Accounts payable')",
          [principal.tenantId,journalId,input.payableAccountId,bill.grand_total]);
        await client.query("UPDATE journal_entries SET status='posted',posted_at=now(),posted_by=$3 WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId,journalId,principal.userId]);
        for(const line of lineResult.rows as Array<{product_id:string|null;quantity:string;unit_cost:string}>) if(line.product_id){
          const product=await client.query("SELECT product_type FROM products WHERE tenant_id=$1 AND id=$2 AND is_active=true",[principal.tenantId,line.product_id]);
          if(product.rowCount!==1) throw new Error("PRODUCT_NOT_FOUND");
          if((product.rows[0] as {product_type:string}).product_type==="stock"){
            await client.query("INSERT INTO stock_movements (tenant_id,product_id,movement_type,quantity_delta,unit_cost,source_type,source_id,reason,recorded_by) VALUES ($1,$2,'purchase',$3::numeric,$4::numeric,'purchase_bill',$5,'Supplier bill posted',$6)",
              [principal.tenantId,line.product_id,line.quantity,line.unit_cost,billId,principal.userId]);
            await client.query("UPDATE products SET cost_price=$3::numeric,updated_at=now() WHERE tenant_id=$1 AND id=$2",
              [principal.tenantId,line.product_id,line.unit_cost]);
          }
        }
        await client.query("UPDATE purchase_bills SET status='posted',posted_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,billId]);
        const responseBody={purchaseBillId:billId,billNumber:bill.bill_number,status:"posted",grandTotal:bill.grand_total,journalId};
        await client.query("UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'purchase_bill.post','purchase_bill',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,billId,JSON.stringify({operationId:input.operationId,journalId})]);
        return {...responseBody,replayed:false};
      });
      return reply.code(200).send(result);
    }catch(error){
      if(error instanceof Error){
        if(error.message==="IDEMPOTENCY_CONFLICT") return reply.code(409).send({error:"idempotency_conflict",message:"The operation ID was already used with different content."});
        if(error.message==="IDEMPOTENCY_INCOMPLETE") return reply.code(409).send({error:"idempotency_incomplete",message:"The previous operation did not complete; retry with a new operation ID."});
        if(error.message==="PURCHASE_BILL_NOT_FOUND") return reply.code(404).send({error:"purchase_bill_not_found",message:"Purchase bill not found."});
        if(error.message==="PURCHASE_BILL_NOT_DRAFT") return reply.code(409).send({error:"purchase_bill_not_draft",message:"Only a draft purchase bill can be posted."});
        if(error.message==="PURCHASE_BILL_EMPTY") return reply.code(409).send({error:"purchase_bill_empty",message:"A bill needs at least one line."});
        if(error.message==="PURCHASE_BILL_ZERO_TOTAL") return reply.code(409).send({error:"purchase_bill_zero_total",message:"A zero-value supplier bill cannot be posted."});
        if(error.message==="INVALID_PURCHASE_ACCOUNTS") return reply.code(400).send({error:"invalid_purchase_accounts",message:"Choose an active asset/expense account and an active liability account."});
        if(error.message==="PRODUCT_NOT_FOUND") return reply.code(409).send({error:"product_not_found",message:"A bill product is no longer active."});
      }
      throw error;
    }
  });
  app.post("/v1/supplier-payments", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = z.object({
      operationId:z.string().uuid(), paymentNumber:z.string().trim().min(1).max(80),
      journalNumber:z.string().trim().min(1).max(80), billId:z.string().uuid(), amount:positive,
      currency:z.string().regex(/^[A-Z]{3}$/).default("LKR"), method:z.enum(["cash","bank_transfer","card","cheque","other"]),
      reference:z.string().trim().max(200).optional(), paidAt:z.string().datetime().optional(),
      cashAccountId:z.string().uuid(), payableAccountId:z.string().uuid()
    }).strict().refine(v=>v.cashAccountId!==v.payableAccountId,{path:["payableAccountId"],message:"Accounts must differ"}).safeParse(request.body);
    if(!parsed.success) return reply.code(400).send({error:"invalid_supplier_payment",message:"Provide a valid payment, bill, journal number and two distinct accounts."});
    const principal=request.principal!;
    if(!canPost(principal.roleKey)) return reply.code(403).send({error:"forbidden",message:"Only an owner, administrator or accountant can record supplier payments."});
    const input=parsed.data,requestHash=digest(input);
    try {
      const result=await db.transaction(async(client)=>{
        const inserted=await client.query("INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'supplier_payment.record',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",[principal.tenantId,input.operationId,requestHash]);
        if(inserted.rowCount===0){
          const previous=await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior=previous.rows[0] as {request_hash:Buffer;response_status:number|null;response_body:{supplierPaymentId?:string}|null}|undefined;
          if(!prior||!Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if(prior.response_status!==201||!prior.response_body?.supplierPaymentId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return {...prior.response_body,replayed:true};
        }
        const selected=await client.query("SELECT id,bill_number,supplier_id,status,currency,grand_total::text AS grand_total FROM purchase_bills WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,input.billId]);
        const bill=selected.rows[0] as {id:string;bill_number:string;supplier_id:string;status:string;currency:string;grand_total:string}|undefined;
        if(!bill) throw new Error("PURCHASE_BILL_NOT_FOUND");
        if(!["posted","partially_paid"].includes(bill.status)) throw new Error("PURCHASE_BILL_NOT_PAYABLE");
        if(bill.currency.trim()!==input.currency) throw new Error("SUPPLIER_PAYMENT_CURRENCY_MISMATCH");
        const accountResult=await client.query("SELECT id,account_type FROM accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND is_active=true",[principal.tenantId,[input.cashAccountId,input.payableAccountId]]);
        const accountRows=accountResult.rows as Array<{id:string;account_type:string}>;
        if(accountRows.length!==2||!accountRows.some(a=>a.id===input.cashAccountId&&a.account_type==="asset")||!accountRows.some(a=>a.id===input.payableAccountId&&a.account_type==="liability")) throw new Error("INVALID_SUPPLIER_PAYMENT_ACCOUNTS");
        const paid=await client.query("SELECT COALESCE(SUM(amount),0)::text AS total FROM supplier_payments WHERE tenant_id=$1 AND bill_id=$2",[principal.tenantId,input.billId]);
        const valid=await client.query("SELECT ($1::numeric+$2::numeric <= $3::numeric) AS within_balance",[String((paid.rows[0] as {total:string}).total),input.amount,bill.grand_total]);
        if(!(valid.rows[0] as {within_balance:boolean}).within_balance) throw new Error("SUPPLIER_PAYMENT_EXCEEDS_BALANCE");
        const paymentResult=await client.query("INSERT INTO supplier_payments (tenant_id,payment_number,supplier_id,bill_id,amount,currency,method,reference,paid_at,recorded_by) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,COALESCE($9::timestamptz,now()),$10) RETURNING id,payment_number,amount::text AS amount,paid_at",[principal.tenantId,input.paymentNumber,bill.supplier_id,input.billId,input.amount,input.currency,input.method,input.reference??null,input.paidAt??null,principal.userId]);
        const payment=paymentResult.rows[0] as {id:string;payment_number:string;amount:string};
        const journalResult=await client.query("INSERT INTO journal_entries (tenant_id,journal_number,entry_date,description,status,currency,source_type,source_id,posted_by) VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,'draft',$5,'supplier_payment',$6,$7) RETURNING id",[principal.tenantId,input.journalNumber,input.paidAt?input.paidAt.slice(0,10):null,"Supplier payment "+payment.payment_number+" for bill "+bill.bill_number,input.currency,payment.id,principal.userId]);
        const journalId=String((journalResult.rows[0] as {id:string}).id);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,1,$3,$4::numeric,0,'Accounts payable reduced')",[principal.tenantId,journalId,input.payableAccountId,input.amount]);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,2,$3,0,$4::numeric,'Cash or bank paid')",[principal.tenantId,journalId,input.cashAccountId,input.amount]);
        await client.query("UPDATE journal_entries SET status='posted',posted_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,journalId]);
        const updatedPaid=await client.query("SELECT COALESCE(SUM(amount),0)::text AS total FROM supplier_payments WHERE tenant_id=$1 AND bill_id=$2",[principal.tenantId,input.billId]);
        const statusResult=await client.query("SELECT ($1::numeric >= $2::numeric) AS is_paid",[String((updatedPaid.rows[0] as {total:string}).total),bill.grand_total]);
        const newStatus=(statusResult.rows[0] as {is_paid:boolean}).is_paid?"paid":"partially_paid";
        await client.query("UPDATE purchase_bills SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,input.billId,newStatus]);
        const responseBody={supplierPaymentId:payment.id,paymentNumber:payment.payment_number,billId:input.billId,amount:payment.amount,status:newStatus,journalId};
        await client.query("UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'supplier_payment.record','supplier_payment',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,payment.id,JSON.stringify({operationId:input.operationId,billId:input.billId,journalId})]);
        return {...responseBody,replayed:false};
      });
      return reply.code(201).send(result);
    } catch(error) {
      if(error instanceof Error){
        if(error.message==="IDEMPOTENCY_CONFLICT") return reply.code(409).send({error:"idempotency_conflict",message:"The operation ID was already used with different content."});
        if(error.message==="PURCHASE_BILL_NOT_FOUND") return reply.code(404).send({error:"purchase_bill_not_found",message:"Purchase bill not found."});
        if(error.message==="PURCHASE_BILL_NOT_PAYABLE") return reply.code(409).send({error:"purchase_bill_not_payable",message:"Only posted or partially paid bills can be paid."});
        if(error.message==="SUPPLIER_PAYMENT_CURRENCY_MISMATCH") return reply.code(400).send({error:"currency_mismatch",message:"Payment currency must match the bill currency."});
        if(error.message==="INVALID_SUPPLIER_PAYMENT_ACCOUNTS") return reply.code(400).send({error:"invalid_supplier_payment_accounts",message:"Choose an active cash/bank asset account and a liability/payables account."});
        if(error.message==="SUPPLIER_PAYMENT_EXCEEDS_BALANCE") return reply.code(409).send({error:"supplier_payment_exceeds_balance",message:"Payment exceeds the bill's remaining balance."});
      }
      throw error;
    }
  });

}
