-- Expense records and immutable posted expense history.
BEGIN;

CREATE TABLE IF NOT EXISTS expenses (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  expense_number TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_name TEXT,
  category TEXT NOT NULL,
  amount NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  tax_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(19,4) GENERATED ALWAYS AS (amount + tax_amount) STORED,
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank_transfer','card','cheque','other')),
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','void')),
  expense_account_id UUID,
  cash_account_id UUID,
  journal_entry_id UUID,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  posted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,expense_number),
  FOREIGN KEY (tenant_id,expense_account_id) REFERENCES accounts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,cash_account_id) REFERENCES accounts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,journal_entry_id) REFERENCES journal_entries(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND posted_at IS NULL AND journal_entry_id IS NULL) OR
         (status IN ('posted','void') AND posted_at IS NOT NULL AND journal_entry_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS expenses_tenant_date_idx ON expenses (tenant_id,expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_tenant_status_date_idx ON expenses (tenant_id,status,expense_date DESC);

CREATE OR REPLACE FUNCTION rss_orbinex_guard_expense_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted','void') THEN
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'Posted expenses are immutable; use a reversal';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_guard_update ON expenses;
CREATE TRIGGER expenses_guard_update BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_guard_expense_update();

COMMIT;
