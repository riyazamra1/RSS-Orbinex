import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "./auth.js";
import type { Database } from "./db.js";

const rangeSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional()
}).strict().refine((range) => !range.from || !range.to || range.from <= range.to, {
  message: "The start date must not be after the end date."
});

function parseRange(value: unknown) {
  return rangeSchema.safeParse(value);
}

export function registerFinancialReports(app: FastifyInstance, db: Database) {
  // Profit and loss is period-based. Only posted journals are included.
  app.get("/v1/reports/profit-and-loss", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = parseRange(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_report_range", message: "Provide valid from/to dates; from must not be after to." });
    }

    const tenantId = request.principal!.tenantId;
    const { from = null, to = null } = parsed.data;
    const result = await db.query(
      `SELECT a.id AS account_id, a.account_code, a.name, a.account_type,
              COALESCE(SUM(CASE WHEN a.account_type = 'income' THEN jl.credit - jl.debit
                                WHEN a.account_type = 'expense' THEN jl.debit - jl.credit
                                ELSE 0 END), 0)::text AS amount
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
         AND je.status = 'posted'
         AND ($2::date IS NULL OR je.entry_date >= $2::date)
         AND ($3::date IS NULL OR je.entry_date <= $3::date)
       WHERE a.tenant_id = $1 AND a.is_active = true
         AND a.account_type IN ('income', 'expense')
       GROUP BY a.id, a.account_code, a.name, a.account_type
       ORDER BY a.account_type, a.account_code`,
      [tenantId, from, to]
    );

    const accounts = result.rows.map((row) => ({
      accountId: row.account_id,
      code: row.account_code,
      name: row.name,
      type: row.account_type,
      amount: String(row.amount)
    }));
    const totals = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0)::text AS income,
         COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS expenses,
         COALESCE(SUM(CASE WHEN a.account_type = 'income' THEN jl.credit - jl.debit WHEN a.account_type = 'expense' THEN jl.credit - jl.debit ELSE 0 END), 0)::text AS net_profit
       FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id AND je.status = 'posted'
       JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
       WHERE jl.tenant_id = $1 AND ($2::date IS NULL OR je.entry_date >= $2::date)
         AND ($3::date IS NULL OR je.entry_date <= $3::date)`,
      [tenantId, from, to]
    );
    const total = totals.rows[0] as { income: string; expenses: string; net_profit: string };
    return {
      report: "profit-and-loss",
      from,
      to,
      currencyBasis: "transaction currency amounts as stored; multi-currency consolidation is not implemented",
      accounts,
      totals: {
        income: total.income,
        expenses: total.expenses,
        netProfit: total.net_profit
      }
    };
  });

  // Balance sheet is cumulative through the selected date, not limited to a period.
  app.get("/v1/reports/balance-sheet", { preHandler: authenticate(db) }, async (request, reply) => {
    const parsed = z.object({ asOf: z.string().date().optional() }).strict().safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_report_date", message: "Provide a valid asOf date." });
    }
    const tenantId = request.principal!.tenantId;
    const asOf = parsed.data.asOf ?? null;
    const result = await db.query(
      `SELECT a.id AS account_id, a.account_code, a.name, a.account_type,
              COALESCE(SUM(CASE WHEN a.account_type IN ('asset', 'expense') THEN jl.debit - jl.credit
                                ELSE jl.credit - jl.debit END), 0)::text AS amount
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
         AND je.status = 'posted' AND ($2::date IS NULL OR je.entry_date <= $2::date)
       WHERE a.tenant_id = $1 AND a.is_active = true
         AND a.account_type IN ('asset', 'liability', 'equity')
       GROUP BY a.id, a.account_code, a.name, a.account_type
       ORDER BY a.account_type, a.account_code`,
      [tenantId, asOf]
    );
    const accounts = result.rows.map((row) => ({
      accountId: row.account_id,
      code: row.account_code,
      name: row.name,
      type: row.account_type,
      amount: String(row.amount)
    }));
    const totals = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_type = 'asset' THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS assets,
         COALESCE(SUM(CASE WHEN a.account_type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0)::text AS liabilities,
         COALESCE(SUM(CASE WHEN a.account_type = 'equity' THEN jl.credit - jl.debit ELSE 0 END), 0)::text AS equity,
         COALESCE(SUM(CASE WHEN a.account_type = 'asset' THEN jl.debit - jl.credit WHEN a.account_type IN ('liability', 'equity') THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS balance_difference
       FROM journal_lines jl
       JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id AND je.status = 'posted'
       JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
       WHERE jl.tenant_id = $1 AND ($2::date IS NULL OR je.entry_date <= $2::date)`,
      [tenantId, asOf]
    );
    const total = totals.rows[0] as { assets: string; liabilities: string; equity: string; balance_difference: string };
    return {
      report: "balance-sheet",
      asOf,
      currencyBasis: "transaction currency amounts as stored; multi-currency consolidation is not implemented",
      accounts,
      totals: {
        assets: total.assets,
        liabilities: total.liabilities,
        equity: total.equity,
        balanceDifferenceBeforeCurrentEarnings: total.balance_difference
      },
      note: "Current-period earnings are returned by the profit-and-loss report and are not automatically closed into equity."
    };
  });
}
