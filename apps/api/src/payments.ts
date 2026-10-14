import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const amountSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/)
  .refine((value) => !/^0(?:\.0{1,4})?$/.test(value), "Payment amount must be positive");
const paymentSchema = z.object({
  operationId: z.string().uuid(),
  paymentNumber: z.string().trim().min(1).max(80),
  journalNumber: z.string().trim().min(1).max(80),
  customerId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amount: amountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  method: z.enum(["cash", "bank_transfer", "card", "cheque", "other"]),
  reference: z.string().trim().max(200).optional(),
  paidAt: z.string().datetime().optional(),
  cashAccountId: z.string().uuid(),
  receivableAccountId: z.string().uuid()
}).strict().refine((input) => input.cashAccountId !== input.receivableAccountId, {
  message: "Cash/bank and receivables accounts must be different",
  path: ["receivableAccountId"]
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
function mayRecordPayment(role: string): boolean {
  return ["owner", "admin", "accountant", "sales"].includes(role);
}

export function registerPayments(app: FastifyInstance, db: Database) {
  app.post("/v1/payments", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payment", message: "Provide a valid payment, invoice, journal number, and two distinct accounts." });
    const principal = request.principal!;
    if (!mayRecordPayment(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot record customer payments." });
    const input = parsed.data;
    const requestHash = digest(input);

    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'payment.receive',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,input.operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId,input.operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { paymentId?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 201 || !prior.response_body?.paymentId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }

        const invoiceResult = await client.query(
          "SELECT id,customer_id,status,currency,grand_total::text AS grand_total,invoice_number FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [principal.tenantId,input.invoiceId]
        );
        const invoice = invoiceResult.rows[0] as { id: string; customer_id: string; status: string; currency: string; grand_total: string; invoice_number: string } | undefined;
        if (!invoice) throw new Error("INVOICE_NOT_FOUND");
        if (invoice.customer_id !== input.customerId) throw new Error("PAYMENT_CUSTOMER_MISMATCH");
        if (invoice.currency.trim() !== input.currency) throw new Error("PAYMENT_CURRENCY_MISMATCH");
        if (!["posted", "partially_paid"].includes(invoice.status)) throw new Error("INVOICE_NOT_PAYABLE");

        const accountResult = await client.query(
          "SELECT id,account_type FROM accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND is_active=true",
          [principal.tenantId,[input.cashAccountId,input.receivableAccountId]]
        );
        const accountRows = accountResult.rows as Array<{ id: string; account_type: string }>;
        if (accountRows.length !== 2 || accountRows.some((account) => account.account_type !== "asset")) throw new Error("INVALID_PAYMENT_ACCOUNTS");

        const paidResult = await client.query(
          "SELECT COALESCE(SUM(CASE WHEN direction='received' THEN amount ELSE -amount END),0)::text AS paid_total FROM payments WHERE tenant_id=$1 AND invoice_id=$2",
          [principal.tenantId,input.invoiceId]
        );
        const paidTotal = String((paidResult.rows[0] as { paid_total: string }).paid_total);
        const balanceResult = await client.query(
          "SELECT ($1::numeric - $2::numeric) AS remaining, ($2::numeric + $3::numeric <= $1::numeric) AS within_balance",
          [invoice.grand_total,paidTotal,input.amount]
        );
        const balance = balanceResult.rows[0] as { remaining: string; within_balance: boolean };
        if (!balance.within_balance) throw new Error("PAYMENT_EXCEEDS_BALANCE");

        const paymentResult = await client.query(
          `INSERT INTO payments (tenant_id,payment_number,customer_id,invoice_id,direction,amount,currency,method,reference,paid_at,recorded_by)
           VALUES ($1,$2,$3,$4,'received',$5::numeric,$6,$7,$8,COALESCE($9::timestamptz,now()),$10)
           RETURNING id,payment_number,amount::text AS amount,currency,method,reference,paid_at`,
          [principal.tenantId,input.paymentNumber,input.customerId,input.invoiceId,input.amount,input.currency,input.method,input.reference ?? null,input.paidAt ?? null,principal.userId]
        );
        const payment = paymentResult.rows[0] as { id: string; payment_number: string; amount: string; currency: string; method: string; reference: string | null; paid_at: Date | string };

        const journalResult = await client.query(
          `INSERT INTO journal_entries (tenant_id,journal_number,entry_date,description,status,currency,source_type,source_id)
           VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,'draft',$5,'payment',$6)
           RETURNING id,journal_number`,
          [principal.tenantId,input.journalNumber,input.paidAt ? input.paidAt.slice(0,10) : null,"Customer payment " + payment.payment_number + " for invoice " + invoice.invoice_number,input.currency,payment.id]
        );
        const journal = journalResult.rows[0] as { id: string; journal_number: string };
        await client.query(
          "INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,1,$3,$4::numeric,0,'Cash or bank received')",
          [principal.tenantId,journal.id,input.cashAccountId,input.amount]
        );
        await client.query(
          "INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description) VALUES ($1,$2,2,$3,0,$4::numeric,'Accounts receivable settled')",
          [principal.tenantId,journal.id,input.receivableAccountId,input.amount]
        );
        await client.query(
          "UPDATE journal_entries SET status='posted',posted_at=now(),posted_by=$3 WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId,journal.id,principal.userId]
        );

        const newPaid = await client.query(
          "SELECT COALESCE(SUM(CASE WHEN direction='received' THEN amount ELSE -amount END),0)::text AS paid_total FROM payments WHERE tenant_id=$1 AND invoice_id=$2",
          [principal.tenantId,input.invoiceId]
        );
        const newPaidTotal = String((newPaid.rows[0] as { paid_total: string }).paid_total);
        const statusResult = await client.query(
          "SELECT ($1::numeric >= $2::numeric) AS fully_paid",
          [newPaidTotal,invoice.grand_total]
        );
        const invoiceStatus = (statusResult.rows[0] as { fully_paid: boolean }).fully_paid ? "paid" : "partially_paid";
        await client.query(
          "UPDATE invoices SET status=$3 WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId,input.invoiceId,invoiceStatus]
        );
        const invoiceVersionResult = await client.query(
          "SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='invoice' AND entity_id=$2",
          [principal.tenantId,input.invoiceId]
        );
        const invoiceVersion = Number((invoiceVersionResult.rows[0] as { version: string | number }).version);
        await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'invoice',$2,$3,'upsert',$4::jsonb)",
          [principal.tenantId,input.invoiceId,invoiceVersion,JSON.stringify({ id: input.invoiceId, invoiceNumber: invoice.invoice_number, status: invoiceStatus, grandTotal: invoice.grand_total, paidTotal: newPaidTotal })]
        );

        const paymentEvent = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'payment',$2,1,'upsert',$3::jsonb) RETURNING sequence_id",
          [principal.tenantId,payment.id,JSON.stringify({ id: payment.id, paymentNumber: payment.payment_number, invoiceId: input.invoiceId, customerId: input.customerId, amount: payment.amount, currency: payment.currency, method: payment.method, paidAt: new Date(payment.paid_at).toISOString() })]
        );
        const journalVersion = await client.query(
          "SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='journal_entry' AND entity_id=$2",
          [principal.tenantId,journal.id]
        );
        const version = Number((journalVersion.rows[0] as { version: string | number }).version);
        const journalEvent = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'journal_entry',$2,$3,'upsert',$4::jsonb) RETURNING sequence_id",
          [principal.tenantId,journal.id,version,JSON.stringify({ id: journal.id, journalNumber: journal.journal_number, status: "posted", sourceType: "payment", sourceId: payment.id, amount: payment.amount, currency: payment.currency })]
        );
        const responseBody = {
          paymentId: payment.id, paymentNumber: payment.payment_number, invoiceId: input.invoiceId,
          invoiceNumber: invoice.invoice_number, amount: payment.amount, currency: payment.currency,
          method: payment.method, paidAt: new Date(payment.paid_at).toISOString(), invoiceStatus,
          journalId: journal.id, journalNumber: journal.journal_number,
          paymentSequence: String((paymentEvent.rows[0] as { sequence_id: string | number }).sequence_id),
          journalSequence: String((journalEvent.rows[0] as { sequence_id: string | number }).sequence_id)
        };
        await client.query(
          "UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,input.operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'payment.receive','payment',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,payment.id,JSON.stringify({ operationId: input.operationId, invoiceId: input.invoiceId, amount: payment.amount, journalId: journal.id })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "INVOICE_NOT_FOUND") return reply.code(404).send({ error: "invoice_not_found", message: "The invoice was not found in this tenant." });
        if (error.message === "PAYMENT_CUSTOMER_MISMATCH") return reply.code(400).send({ error: "payment_customer_mismatch", message: "The selected customer does not match the invoice." });
        if (error.message === "PAYMENT_CURRENCY_MISMATCH") return reply.code(400).send({ error: "payment_currency_mismatch", message: "Payment currency must match invoice currency." });
        if (error.message === "INVOICE_NOT_PAYABLE") return reply.code(409).send({ error: "invoice_not_payable", message: "Only posted or partially paid invoices can receive payments." });
        if (error.message === "INVALID_PAYMENT_ACCOUNTS") return reply.code(400).send({ error: "invalid_payment_accounts", message: "Select two distinct active asset accounts from this business." });
        if (error.message === "PAYMENT_EXCEEDS_BALANCE") return reply.code(409).send({ error: "payment_exceeds_balance", message: "The payment cannot exceed the invoice's remaining balance." });
      }
      throw error;
    }
  });
}
