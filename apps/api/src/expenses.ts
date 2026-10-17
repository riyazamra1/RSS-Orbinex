import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const decimal = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,14})(?:\\.[0-9]{1,4})?$/)
  .refine((value) => !/^0(?:\\.0{1,4})?$/.test(value), "Amount must be positive");
const nonNegative = z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\\.[0-9]{1,4})?$/);
const createSchema = z.object({
  operationId: z.string().uuid(),
  expenseNumber: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  expenseDate: z.string().date().optional(),
  supplierName: z.string().trim().max(200).optional(),
  category: z.string().trim().min(1).max(120),
  amount: decimal,
  taxAmount: nonNegative.default("0"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  paymentMethod: z.enum(["cash","bank_transfer","card","cheque","other"]),
  paymentReference: z.string().trim().max(200).optional()
}).strict();
const postSchema = z.object({
  operationId: z.string().uuid(),
  journalNumber: z.string().trim().min(1).max(80),
  expenseAccountId: z.string().uuid(),
  cashAccountId: z.string().uuid()
}).strict().refine((v) => v.expenseAccountId !== v.cashAccountId, {
  path: ["cashAccountId"], message: "Expense and cash/bank accounts must differ"
});

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
function canManage(role: string): boolean {
  return ["owner","admin","accountant"].includes(role);
}
function canCreate(role: string): boolean {
  return ["owner","admin","accountant","purchasing"].includes(role);
}

export function registerExpenses(app: FastifyInstance, db: Database) {
  app.get("/v1/expenses", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = z.object({
      status: z.enum(["draft","posted","void"]).optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      q: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0)
    }).strict().safeParse(request.query);
    if (!parsed.success || (parsed.data?.from && parsed.data?.to && parsed.data.from > parsed.data.to)) {
      return reply.code(400).send({ error: "invalid_expense_filter", message: "Expense filters or date range are invalid." });
    }
    const p = parsed.data;
    const result = await db.query(
      `SELECT id,expense_number,description,expense_date,supplier_name,category,amount::text AS amount,
              tax_amount::text AS tax_amount,total_amount::text AS total_amount,currency,payment_method,
              payment_reference,status,expense_account_id,cash_account_id,journal_entry_id,created_at,posted_at
       FROM expenses WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
         AND ($3::date IS NULL OR expense_date >= $3::date)
         AND ($4::date IS NULL OR expense_date <= $4::date)
         AND ($5::text IS NULL OR expense_number ILIKE '%'||$5||'%' OR description ILIKE '%'||$5||'%' OR category ILIKE '%'||$5||'%' OR COALESCE(supplier_name,'') ILIKE '%'||$5||'%')
       ORDER BY expense_date DESC,created_at DESC LIMIT $6 OFFSET $7`,
      [request.principal!.tenantId,p.status ?? null,p.from ?? null,p.to ?? null,p.q ?? null,p.limit,p.offset]
    );
    return { expenses: result.rows.map((r) => ({
      id:r.id,expenseNumber:r.expense_number,description:r.description,expenseDate:r.expense_date,
      supplierName:r.supplier_name,category:r.category,amount:r.amount,taxAmount:r.tax_amount,
      totalAmount:r.total_amount,currency:String(r.currency).trim(),paymentMethod:r.payment_method,
      paymentReference:r.payment_reference,status:r.status,expenseAccountId:r.expense_account_id,
      cashAccountId:r.cash_account_id,journalEntryId:r.journal_entry_id,
      createdAt:new Date(r.created_at as string|Date).toISOString(),
      postedAt:r.posted_at ? new Date(r.posted_at as string|Date).toISOString() : null
    })) };
  });

  app.get("/v1/expenses/:expenseId", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ expenseId:z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({error:"invalid_expense_id",message:"Expense ID must be a UUID."});
    const result = await db.query(
      `SELECT id,expense_number,description,expense_date,supplier_name,category,amount::text AS amount,
              tax_amount::text AS tax_amount,total_amount::text AS total_amount,currency,payment_method,
              payment_reference,status,expense_account_id,cash_account_id,journal_entry_id,created_at,posted_at
       FROM expenses WHERE tenant_id=$1 AND id=$2`,
      [request.principal!.tenantId,params.data.expenseId]
    );
    if (!result.rowCount) return reply.code(404).send({error:"expense_not_found",message:"Expense not found."});
    const r=result.rows[0]!;
    return { expense:{
      id:r.id,expenseNumber:r.expense_number,description:r.description,expenseDate:r.expense_date,
      supplierName:r.supplier_name,category:r.category,amount:r.amount,taxAmount:r.tax_amount,
      totalAmount:r.total_amount,currency:String(r.currency).trim(),paymentMethod:r.payment_method,
      paymentReference:r.payment_reference,status:r.status,expenseAccountId:r.expense_account_id,
      cashAccountId:r.cash_account_id,journalEntryId:r.journal_entry_id,
      createdAt:new Date(r.created_at as string|Date).toISOString(),
      postedAt:r.posted_at ? new Date(r.posted_at as string|Date).toISOString() : null
    }};
  });

  app.post("/v1/expenses", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed=createSchema.safeParse(request.body);
    if(!parsed.success) return reply.code(400).send({error:"invalid_expense",message:"Provide a valid expense number, description, date, category, positive amount and payment method."});
    const principal=request.principal!;
    if(!canCreate(principal.roleKey)) return reply.code(403).send({error:"forbidden",message:"Your role cannot create expenses."});
    const input=parsed.data, requestHash=digest(input);
    try {
      const result=await db.transaction(async(client)=>{
        const inserted=await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'expense.create',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,input.operationId,requestHash]
        );
        if(inserted.rowCount===0){
          const previous=await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior=previous.rows[0] as {request_hash:Buffer;response_status:number|null;response_body:{expenseId?:string}|null}|undefined;
          if(!prior||!Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if(prior.response_status!==201||!prior.response_body?.expenseId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return {...prior.response_body,replayed:true};
        }
        const insertedExpense=await client.query(
          `INSERT INTO expenses (tenant_id,expense_number,description,expense_date,supplier_name,category,amount,tax_amount,currency,payment_method,payment_reference,created_by)
           VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6,$7::numeric,$8::numeric,$9,$10,$11,$12)
           RETURNING id,expense_number,amount::text AS amount,tax_amount::text AS tax_amount,total_amount::text AS total_amount,status,expense_date`,
          [principal.tenantId,input.expenseNumber,input.description,input.expenseDate??null,input.supplierName??null,input.category,input.amount,input.taxAmount,input.currency,input.paymentMethod,input.paymentReference??null,principal.userId]
        );
        const e=insertedExpense.rows[0] as {id:string;expense_number:string;amount:string;tax_amount:string;total_amount:string;status:string;expense_date:string};
        const responseBody={expenseId:e.id,expenseNumber:e.expense_number,status:e.status,expenseDate:e.expense_date,amount:e.amount,taxAmount:e.tax_amount,totalAmount:e.total_amount};
        await client.query("UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'expense.create','expense',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,e.id,JSON.stringify({operationId:input.operationId,expenseNumber:e.expense_number})]);
        return {...responseBody,replayed:false};
      });
      return reply.code(201).send(result);
    } catch(error) {
      if(error instanceof Error){
        if(error.message==="IDEMPOTENCY_CONFLICT") return reply.code(409).send({error:"idempotency_conflict",message:"The operation ID was already used with different content."});
        if(error.message==="IDEMPOTENCY_INCOMPLETE") return reply.code(409).send({error:"idempotency_incomplete",message:"The previous operation did not complete; retry with a new operation ID."});
      }
      throw error;
    }
  });

  app.post("/v1/expenses/:expenseId/post", { preHandler: authenticate(db) }, async (request, reply) => {
    const params=z.object({expenseId:z.string().uuid()}).safeParse(request.params);
    const parsed=postSchema.safeParse(request.body);
    if(!params.success||!parsed.success) return reply.code(400).send({error:"invalid_expense_post",message:"Provide an expense ID, operation ID, journal number and distinct expense/cash accounts."});
    const principal=request.principal!;
    if(!canManage(principal.roleKey)) return reply.code(403).send({error:"forbidden",message:"Only an owner, administrator or accountant can post expenses."});
    const expenseId=params.data.expenseId,input=parsed.data,requestHash=digest({expenseId,...input});
    try {
      const result=await db.transaction(async(client)=>{
        const inserted=await client.query("INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'expense.post',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",[principal.tenantId,input.operationId,requestHash]);
        if(inserted.rowCount===0){
          const previous=await client.query("SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",[principal.tenantId,input.operationId]);
          const prior=previous.rows[0] as {request_hash:Buffer;response_status:number|null;response_body:{expenseId?:string}|null}|undefined;
          if(!prior||!Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if(prior.response_status!==200||!prior.response_body?.expenseId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return {...prior.response_body,replayed:true};
        }
        const selected=await client.query("SELECT id,expense_number,description,expense_date,currency,total_amount::text AS total_amount,status FROM expenses WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,expenseId]);
        const e=selected.rows[0] as {id:string;expense_number:string;description:string;expense_date:string;currency:string;total_amount:string;status:string}|undefined;
        if(!e) throw new Error("EXPENSE_NOT_FOUND");
        if(e.status!=="draft") throw new Error("EXPENSE_NOT_DRAFT");
        const accountResult=await client.query("SELECT id,account_type FROM accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND is_active=true",[principal.tenantId,[input.expenseAccountId,input.cashAccountId]]);
        const accounts=accountResult.rows as Array<{id:string;account_type:string}>;
        if(accounts.length!==2||!accounts.some(a=>a.id===input.expenseAccountId&&a.account_type==="expense")||!accounts.some(a=>a.id===input.cashAccountId&&a.account_type==="asset")) throw new Error("INVALID_EXPENSE_ACCOUNTS");
        const journalResult=await client.query(
          "INSERT INTO journal_entries (tenant_id,journal_number,entry_date,description,status,currency,source_type,source_id) VALUES ($1,$2,$3,$4,'draft',$5,'expense',$6) RETURNING id",
          [principal.tenantId,input.journalNumber,e.expense_date,e.description+" ("+e.expense_number+")",e.currency,expenseId]
        );
        const journalId=String((journalResult.rows[0] as {id:string}).id);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,1,$3,$4::numeric,0,'Expense recorded')",[principal.tenantId,journalId,input.expenseAccountId,e.total_amount]);
        await client.query("INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,2,$3,0,$4::numeric,'Cash or bank paid')",[principal.tenantId,journalId,input.cashAccountId,e.total_amount]);
        await client.query("UPDATE journal_entries SET status='posted',posted_at=now(),posted_by=$3 WHERE tenant_id=$1 AND id=$2",[principal.tenantId,journalId,principal.userId]);
        await client.query("UPDATE expenses SET status='posted',expense_account_id=$3,cash_account_id=$4,journal_entry_id=$5,posted_by=$6,posted_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,expenseId,input.expenseAccountId,input.cashAccountId,journalId,principal.userId]);
        const responseBody={expenseId,expenseNumber:e.expense_number,status:"posted",journalId,totalAmount:e.total_amount};
        await client.query("UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",[principal.tenantId,input.operationId,JSON.stringify(responseBody)]);
        await client.query("INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'expense.post','expense',$3,'success',$4::jsonb)",[principal.tenantId,principal.userId,expenseId,JSON.stringify({operationId:input.operationId,journalId})]);
        return {...responseBody,replayed:false};
      });
      return reply.code(200).send(result);
    } catch(error) {
      if(error instanceof Error){
        if(error.message==="IDEMPOTENCY_CONFLICT") return reply.code(409).send({error:"idempotency_conflict",message:"The operation ID was already used with different content."});
        if(error.message==="IDEMPOTENCY_INCOMPLETE") return reply.code(409).send({error:"idempotency_incomplete",message:"The previous operation did not complete; retry with a new operation ID."});
        if(error.message==="EXPENSE_NOT_FOUND") return reply.code(404).send({error:"expense_not_found",message:"Expense not found."});
        if(error.message==="EXPENSE_NOT_DRAFT") return reply.code(409).send({error:"expense_not_draft",message:"Only a draft expense can be posted."});
        if(error.message==="INVALID_EXPENSE_ACCOUNTS") return reply.code(400).send({error:"invalid_expense_accounts",message:"Choose an active expense account and an active cash/bank asset account."});
      }
      throw error;
    }
  });
}
