import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const money = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/, "Use a non-negative decimal with at most four fractional digits");
const accountType = z.enum(["asset", "liability", "equity", "income", "expense"]);
const accountSchema = z.object({
  code: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(1).max(160),
  type: accountType,
  parentAccountId: z.string().uuid().optional(),
  isControlAccount: z.boolean().default(false)
}).strict();
const journalLineSchema = z.object({
  accountId: z.string().uuid(),
  debit: money.default("0"),
  credit: money.default("0"),
  description: z.string().trim().max(300).optional()
}).strict().refine((line) => {
  const debitPositive = !/^0(?:\.0{1,4})?$/.test(line.debit);
  const creditPositive = !/^0(?:\.0{1,4})?$/.test(line.credit);
  return debitPositive !== creditPositive;
}, "Each journal line must have either a positive debit or a positive credit, not both.");
const journalSchema = z.object({
  operationId: z.string().uuid(),
  journalNumber: z.string().trim().min(1).max(80),
  entryDate: z.string().date().optional(),
  description: z.string().trim().min(1).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/).default("LKR"),
  sourceType: z.string().trim().min(1).max(40).optional(),
  sourceId: z.string().uuid().optional(),
  lines: z.array(journalLineSchema).min(2).max(100)
}).strict();
const postSchema = z.object({ operationId: z.string().uuid() }).strict();

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
function canManageAccounts(role: string): boolean {
  return ["owner", "admin", "accountant"].includes(role);
}
function canPostJournals(role: string): boolean {
  return ["owner", "admin", "accountant"].includes(role);
}

export function registerAccounting(app: FastifyInstance, db: Database) {
  app.get("/v1/accounting/accounts", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({ type: accountType.optional(), includeInactive: z.coerce.boolean().default(false) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_account_filter", message: "Account filters are invalid." });
    const principal = request.principal!;
    const result = await db.query(
      `SELECT id, account_code, name, account_type, parent_account_id, is_control_account, is_active, created_at
       FROM accounts
       WHERE tenant_id=$1 AND ($2::text IS NULL OR account_type=$2)
         AND ($3::boolean OR is_active=true)
       ORDER BY account_code ASC`,
      [principal.tenantId, query.data.type ?? null, query.data.includeInactive]
    );
    return { accounts: result.rows.map((row) => ({
      id: row.id, code: row.account_code, name: row.name, type: row.account_type,
      parentAccountId: row.parent_account_id, isControlAccount: row.is_control_account,
      active: row.is_active, createdAt: new Date(row.created_at as string | Date).toISOString()
    })) };
  });

  app.post("/v1/accounting/accounts", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_account", message: "Provide a valid account code, name, type, and optional parent." });
    const principal = request.principal!;
    if (!canManageAccounts(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot manage accounts." });
    const input = parsed.data;
    try {
      const result = await db.transaction(async (client) => {
        if (input.parentAccountId) {
          const parent = await client.query(
            "SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 AND is_active=true",
            [principal.tenantId, input.parentAccountId]
          );
          if (parent.rowCount !== 1) throw new Error("PARENT_ACCOUNT_NOT_FOUND");
        }
        const inserted = await client.query(
          `INSERT INTO accounts (tenant_id,account_code,name,account_type,parent_account_id,is_control_account)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id,account_code,name,account_type,parent_account_id,is_control_account,is_active,created_at`,
          [principal.tenantId,input.code,input.name,input.type,input.parentAccountId ?? null,input.isControlAccount]
        );
        const row = inserted.rows[0] as Record<string, unknown>;
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'account.create','account',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,String(row.id),JSON.stringify({ code: row.account_code, type: row.account_type })]
        );
        return row;
      });
      return reply.code(201).send({ account: {
        id: result.id, code: result.account_code, name: result.name, type: result.account_type,
        parentAccountId: result.parent_account_id, isControlAccount: result.is_control_account,
        active: result.is_active, createdAt: new Date(result.created_at as string | Date).toISOString()
      } });
    } catch (error) {
      if (error instanceof Error && error.message === "PARENT_ACCOUNT_NOT_FOUND") {
        return reply.code(404).send({ error: "parent_account_not_found", message: "The parent account was not found or is inactive." });
      }
      throw error;
    }
  });

  app.post("/v1/accounting/journals", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = journalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_journal", message: "Provide a valid journal header and at least two valid debit/credit lines." });
    const principal = request.principal!;
    if (!canPostJournals(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot create journal entries." });
    const input = parsed.data;
    const requestHash = digest(input);
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'journal.create',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,input.operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId,input.operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { journalId?: string; journalNumber?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 201 || !prior.response_body?.journalId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }
        const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
        const accounts = await client.query(
          "SELECT id FROM accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND is_active=true",
          [principal.tenantId,accountIds]
        );
        if (accounts.rowCount !== accountIds.length) throw new Error("ACCOUNT_NOT_FOUND");
        const entryResult = await client.query(
          `INSERT INTO journal_entries (tenant_id,journal_number,entry_date,description,status,currency,source_type,source_id)
           VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,'draft',$5,$6,$7)
           RETURNING id,journal_number,entry_date,status,currency,description`,
          [principal.tenantId,input.journalNumber,input.entryDate ?? null,input.description,input.currency,input.sourceType ?? null,input.sourceId ?? null]
        );
        const entry = entryResult.rows[0] as { id: string; journal_number: string; entry_date: string; status: string; currency: string; description: string };
        for (let index = 0; index < input.lines.length; index++) {
          const line = input.lines[index]!;
          await client.query(
            `INSERT INTO journal_lines (tenant_id,journal_entry_id,line_number,account_id,debit,credit,description)
             VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7)`,
            [principal.tenantId,entry.id,index+1,line.accountId,line.debit,line.credit,line.description ?? null]
          );
        }
        const totals = await client.query(
          "SELECT COUNT(*)::int AS line_count,COALESCE(SUM(debit),0)::text AS debit_total,COALESCE(SUM(credit),0)::text AS credit_total FROM journal_lines WHERE tenant_id=$1 AND journal_entry_id=$2",
          [principal.tenantId,entry.id]
        );
        const sums = totals.rows[0] as { line_count: number; debit_total: string; credit_total: string };
        const responseBody = {
          journalId: entry.id, journalNumber: entry.journal_number, status: entry.status,
          entryDate: entry.entry_date, currency: entry.currency, description: entry.description,
          lineCount: sums.line_count, debitTotal: sums.debit_total, creditTotal: sums.credit_total
        };
        const event = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'journal_entry',$2,1,'upsert',$3::jsonb) RETURNING sequence_id",
          [principal.tenantId,entry.id,JSON.stringify(responseBody)]
        );
        (responseBody as typeof responseBody & { sequence?: string }).sequence = String((event.rows[0] as { sequence_id: string | number }).sequence_id);
        await client.query(
          "UPDATE idempotency_records SET response_status=201,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,input.operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'journal.create','journal_entry',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,entry.id,JSON.stringify({ operationId: input.operationId, lineCount: sums.line_count })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "ACCOUNT_NOT_FOUND") return reply.code(400).send({ error: "account_not_found", message: "Every journal line must reference an active account in this tenant." });
      }
      throw error;
    }
  });

  app.post("/v1/accounting/journals/:journalId/post", { preHandler: authenticate(db) }, async (request, reply) => {
    const params = z.object({ journalId: z.string().uuid() }).safeParse(request.params);
    const parsed = postSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_journal_post", message: "A valid journal ID and operation ID are required." });
    const principal = request.principal!;
    if (!canPostJournals(principal.roleKey)) return reply.code(403).send({ error: "forbidden", message: "Your role cannot post journal entries." });
    const journalId = params.data.journalId;
    const operationId = parsed.data.operationId;
    const requestHash = digest({ journalId, operationId });
    try {
      const result = await db.transaction(async (client) => {
        const inserted = await client.query(
          "INSERT INTO idempotency_records (tenant_id,operation_id,operation_type,request_hash) VALUES ($1,$2,'journal.post',$3) ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id",
          [principal.tenantId,operationId,requestHash]
        );
        if (inserted.rowCount === 0) {
          const priorResult = await client.query(
            "SELECT request_hash,response_status,response_body FROM idempotency_records WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE",
            [principal.tenantId,operationId]
          );
          const prior = priorResult.rows[0] as { request_hash: Buffer; response_status: number | null; response_body: { journalId?: string; status?: string } | null } | undefined;
          if (!prior || !Buffer.from(prior.request_hash).equals(requestHash)) throw new Error("IDEMPOTENCY_CONFLICT");
          if (prior.response_status !== 200 || !prior.response_body?.journalId) throw new Error("IDEMPOTENCY_INCOMPLETE");
          return { ...prior.response_body, replayed: true };
        }
        const entryResult = await client.query(
          "SELECT id,journal_number,status,entry_date,currency FROM journal_entries WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [principal.tenantId,journalId]
        );
        const entry = entryResult.rows[0] as { id: string; journal_number: string; status: string; entry_date: string; currency: string } | undefined;
        if (!entry) throw new Error("JOURNAL_NOT_FOUND");
        if (entry.status !== "draft") throw new Error("JOURNAL_NOT_DRAFT");
        const totalsResult = await client.query(
          "SELECT COUNT(*)::int AS line_count,COALESCE(SUM(debit),0)::text AS debit_total,COALESCE(SUM(credit),0)::text AS credit_total FROM journal_lines WHERE tenant_id=$1 AND journal_entry_id=$2",
          [principal.tenantId,journalId]
        );
        const totals = totalsResult.rows[0] as { line_count: number; debit_total: string; credit_total: string };
        const balanced = await client.query(
          "SELECT $1::numeric > 0 AND $2::numeric = $3::numeric AS is_balanced",
          [totals.line_count >= 2 ? totals.debit_total : "0",totals.debit_total,totals.credit_total]
        );
        if (!(balanced.rows[0] as { is_balanced: boolean }).is_balanced) throw new Error("JOURNAL_UNBALANCED");
        const updated = await client.query(
          "UPDATE journal_entries SET status='posted',posted_at=now(),posted_by=$3 WHERE tenant_id=$1 AND id=$2 RETURNING posted_at",
          [principal.tenantId,journalId,principal.userId]
        );
        const eventVersion = await client.query(
          "SELECT COALESCE(MAX(entity_version),0)+1 AS version FROM change_events WHERE tenant_id=$1 AND entity_type='journal_entry' AND entity_id=$2",
          [principal.tenantId,journalId]
        );
        const version = Number((eventVersion.rows[0] as { version: string | number }).version);
        const event = await client.query(
          "INSERT INTO change_events (tenant_id,entity_type,entity_id,entity_version,change_type,payload) VALUES ($1,'journal_entry',$2,$3,'upsert',$4::jsonb) RETURNING sequence_id",
          [principal.tenantId,journalId,version,JSON.stringify({ id: journalId, journalNumber: entry.journal_number, status: "posted", entryDate: entry.entry_date, currency: entry.currency, debitTotal: totals.debit_total, creditTotal: totals.credit_total, postedAt: new Date((updated.rows[0] as { posted_at: Date | string }).posted_at).toISOString() })]
        );
        const responseBody = { journalId, journalNumber: entry.journal_number, status: "posted", debitTotal: totals.debit_total, creditTotal: totals.credit_total, sequence: String((event.rows[0] as { sequence_id: string | number }).sequence_id) };
        await client.query(
          "UPDATE idempotency_records SET response_status=200,response_body=$3::jsonb,completed_at=now() WHERE tenant_id=$1 AND operation_id=$2",
          [principal.tenantId,operationId,JSON.stringify(responseBody)]
        );
        await client.query(
          "INSERT INTO audit_events (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,metadata) VALUES ($1,$2,'journal.post','journal_entry',$3,'success',$4::jsonb)",
          [principal.tenantId,principal.userId,journalId,JSON.stringify({ operationId, debitTotal: totals.debit_total, creditTotal: totals.credit_total })]
        );
        return { ...responseBody, replayed: false };
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ error: "idempotency_conflict", message: "The operation ID was already used with different content." });
        if (error.message === "JOURNAL_NOT_FOUND") return reply.code(404).send({ error: "journal_not_found", message: "The journal was not found in this tenant." });
        if (error.message === "JOURNAL_NOT_DRAFT") return reply.code(409).send({ error: "journal_not_draft", message: "Only draft journals can be posted." });
        if (error.message === "JOURNAL_UNBALANCED") return reply.code(409).send({ error: "journal_unbalanced", message: "A journal must have at least two lines and equal debit and credit totals." });
      }
      throw error;
    }
  });

  app.get("/v1/accounting/trial-balance", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).strict().safeParse(request.query);
    if (!query.success || (query.data?.from && query.data?.to && query.data.from > query.data.to)) {
      return reply.code(400).send({ error: "invalid_trial_balance_range", message: "Provide a valid date range." });
    }
    const principal = request.principal!;
    const result = await db.query(
      `SELECT a.id,a.account_code,a.name,a.account_type,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END),0)::text AS debit_total,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END),0)::text AS credit_total
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.tenant_id=a.tenant_id AND jl.account_id=a.id
       LEFT JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
         AND je.status='posted' AND ($2::date IS NULL OR je.entry_date >= $2::date)
         AND ($3::date IS NULL OR je.entry_date <= $3::date)
       WHERE a.tenant_id=$1 AND a.is_active=true
       GROUP BY a.id,a.account_code,a.name,a.account_type
       ORDER BY a.account_code`,
      [principal.tenantId,query.data.from ?? null,query.data.to ?? null]
    );
    const accounts = result.rows.map((row) => ({
      accountId: row.id, code: row.account_code, name: row.name, type: row.account_type,
      debit: String(row.debit_total), credit: String(row.credit_total)
    }));
    const totalsResult = await db.query(
      `SELECT COALESCE(SUM(jl.debit),0)::text AS debit_total,COALESCE(SUM(jl.credit),0)::text AS credit_total
       FROM journal_lines jl JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
       WHERE jl.tenant_id=$1 AND je.status='posted' AND ($2::date IS NULL OR je.entry_date >= $2::date)
         AND ($3::date IS NULL OR je.entry_date <= $3::date)`,
      [principal.tenantId,query.data.from ?? null,query.data.to ?? null]
    );
    const totals = totalsResult.rows[0] as { debit_total: string; credit_total: string };
    return { from: query.data.from ?? null, to: query.data.to ?? null, accounts, totals: { debit: totals.debit_total, credit: totals.credit_total } };
  });

  app.get("/v1/accounting/profit-and-loss", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({ from: z.string().date(), to: z.string().date() }).strict().safeParse(request.query);
    if (!query.success || query.data.from > query.data.to) {
      return reply.code(400).send({ error: "invalid_profit_and_loss_range", message: "Provide valid from and to dates, with from not after to." });
    }
    const principal = request.principal!;
    const result = await db.query(
      `SELECT a.id,a.account_code,a.name,a.account_type,
              COALESCE(SUM(jl.debit),0)::text AS debit_total,
              COALESCE(SUM(jl.credit),0)::text AS credit_total,
              COALESCE(SUM(CASE WHEN a.account_type='income' THEN jl.credit-jl.debit
                                ELSE jl.debit-jl.credit END),0)::text AS amount
       FROM accounts a
       JOIN journal_lines jl ON jl.tenant_id=a.tenant_id AND jl.account_id=a.id
       JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
       WHERE a.tenant_id=$1 AND a.is_active=true
         AND a.account_type IN ('income','expense') AND je.status='posted'
         AND je.entry_date >= $2::date AND je.entry_date <= $3::date
       GROUP BY a.id,a.account_code,a.name,a.account_type
       ORDER BY a.account_type,a.account_code`,
      [principal.tenantId, query.data.from, query.data.to]
    );
    const lines = result.rows.map((row) => ({
      accountId: row.id, code: row.account_code, name: row.name, type: row.account_type,
      debit: String(row.debit_total), credit: String(row.credit_total), amount: String(row.amount)
    }));
    const totals = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_type='income' THEN jl.credit-jl.debit ELSE 0 END),0)::text AS income,
         COALESCE(SUM(CASE WHEN a.account_type='expense' THEN jl.debit-jl.credit ELSE 0 END),0)::text AS expenses
       FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
       JOIN accounts a ON a.tenant_id=jl.tenant_id AND a.id=jl.account_id
       WHERE jl.tenant_id=$1 AND je.status='posted' AND je.entry_date >= $2::date AND je.entry_date <= $3::date
         AND a.account_type IN ('income','expense')`,
      [principal.tenantId, query.data.from, query.data.to]
    );
    const totalsRow = totals.rows[0] as { income: string; expenses: string };
    const income = String(totalsRow.income);
    const expenses = String(totalsRow.expenses);
    const net = await db.query(
      "SELECT ($1::numeric-$2::numeric)::text AS net_profit",
      [income, expenses]
    );
    return {
      from: query.data.from, to: query.data.to,
      currencyPolicy: "Amounts are reported in account currency without cross-currency conversion.",
      income, expenses, netProfit: String((net.rows[0] as { net_profit: string }).net_profit), lines
    };
  });

  app.get("/v1/accounting/balance-sheet", { preHandler: authenticate(db) }, async (request, reply) => {
    const query = z.object({ asOf: z.string().date() }).strict().safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_balance_sheet_date", message: "Provide a valid asOf date." });
    }
    const principal = request.principal!;
    const result = await db.query(
      `SELECT a.id,a.account_code,a.name,a.account_type,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END),0)::text AS debit_total,
              COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END),0)::text AS credit_total,
              COALESCE(SUM(CASE
                WHEN je.id IS NULL THEN 0
                WHEN a.account_type='asset' THEN jl.debit-jl.credit
                ELSE jl.credit-jl.debit
              END),0)::text AS balance
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.tenant_id=a.tenant_id AND jl.account_id=a.id
       LEFT JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
         AND je.status='posted' AND je.entry_date <= $2::date
       WHERE a.tenant_id=$1 AND a.is_active=true
         AND a.account_type IN ('asset','liability','equity')
       GROUP BY a.id,a.account_code,a.name,a.account_type
       ORDER BY a.account_type,a.account_code`,
      [principal.tenantId, query.data.asOf]
    );
    const lines = result.rows.map((row) => ({
      accountId: row.id, code: row.account_code, name: row.name,
      type: row.account_type, balance: String(row.balance)
    }));
    const totalsResult = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_type='asset' THEN jl.debit-jl.credit ELSE 0 END),0)::text AS assets,
         COALESCE(SUM(CASE WHEN a.account_type='liability' THEN jl.credit-jl.debit ELSE 0 END),0)::text AS liabilities,
         COALESCE(SUM(CASE WHEN a.account_type='equity' THEN jl.credit-jl.debit ELSE 0 END),0)::text AS equity,
         COALESCE(SUM(CASE WHEN a.account_type='income' THEN jl.credit-jl.debit
                           WHEN a.account_type='expense' THEN jl.debit-jl.credit ELSE 0 END),0)::text AS retained_earnings
       FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id=jl.tenant_id AND je.id=jl.journal_entry_id
       JOIN accounts a ON a.tenant_id=jl.tenant_id AND a.id=jl.account_id
       WHERE jl.tenant_id=$1 AND je.status='posted' AND je.entry_date <= $2::date
         AND a.account_type IN ('asset','liability','equity','income','expense')`,
      [principal.tenantId, query.data.asOf]
    );
    const totals = totalsResult.rows[0] as {
      assets: string; liabilities: string; equity: string; retained_earnings: string;
    };
    const combined = await db.query(
      `SELECT ($1::numeric+$2::numeric+$3::numeric)::text AS liabilities_and_equity,
              ($4::numeric-$1::numeric-$2::numeric-$3::numeric)::text AS difference`,
      [totals.liabilities, totals.equity, totals.retained_earnings, totals.assets]
    );
    const combinedRow = combined.rows[0] as { liabilities_and_equity: string; difference: string };
    const toUnits = (value: string): bigint => {
      const match = /^(-?)(\\d+)(?:\\.(\\d*))?$/.exec(value);
      if (!match) throw new Error("Unexpected decimal returned by PostgreSQL.");
      const fraction = (match[3] ?? "").padEnd(4, "0").slice(0, 4);
      const units = BigInt(match[2]!) * 10000n + BigInt(fraction || "0");
      return match[1] === "-" ? -units : units;
    };
    return {
      asOf: query.data.asOf, assets: String(totals.assets), liabilities: String(totals.liabilities),
      equity: String((await db.query("SELECT ($1::numeric+$2::numeric)::text AS equity", [totals.equity, totals.retained_earnings])).rows[0]!.equity),
      retainedEarnings: String(totals.retained_earnings),
      liabilitiesAndEquity: String(combinedRow.liabilities_and_equity),
      balanced: toUnits(String(combinedRow.difference)) === 0n,
      lines
    };
  });
}
