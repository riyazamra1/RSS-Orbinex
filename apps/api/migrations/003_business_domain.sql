-- RSS Orbinex business-domain foundation.
-- Financial and stock history is modeled as append-only events/movements.
-- Posted invoices are immutable; corrections must use credit notes/reversals.
BEGIN;

CREATE TABLE IF NOT EXISTS customers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  customer_code TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT,
  phone TEXT,
  billing_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  credit_limit NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, customer_code)
);

CREATE TABLE IF NOT EXISTS suppliers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  supplier_code TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT,
  phone TEXT,
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, supplier_code)
);

CREATE TABLE IF NOT EXISTS products (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  unit_code TEXT NOT NULL DEFAULT 'each',
  cost_price NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  sale_price NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  reorder_level NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS invoices (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL,
  customer_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','partially_paid','paid','void')),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  subtotal NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  posted_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CHECK (due_date IS NULL OR due_date >= issue_date),
  CHECK ((status IN ('draft','void') AND posted_at IS NULL) OR (status IN ('posted','partially_paid','paid') AND posted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  product_id UUID,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  quantity NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total NUMERIC(19,4) GENERATED ALWAYS AS (quantity * unit_price - discount_amount + tax_amount) STORED,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_number),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT,
  CHECK (discount_amount <= quantity * unit_price)
);

CREATE TABLE IF NOT EXISTS payments (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  payment_number TEXT NOT NULL,
  customer_id UUID NOT NULL,
  invoice_id UUID,
  direction TEXT NOT NULL DEFAULT 'received' CHECK (direction IN ('received','refunded')),
  amount NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','card','cheque','other')),
  reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, payment_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS stock_movements (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('opening','purchase','sale','customer_return','supplier_return','damage','adjustment_in','adjustment_out','transfer_in','transfer_out','reversal')),
  quantity_delta NUMERIC(19,4) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  source_type TEXT,
  source_id UUID,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS sales_returns (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  return_number TEXT NOT NULL,
  customer_id UUID NOT NULL,
  invoice_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','accepted','rejected','credited')),
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, return_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS stock_damages (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL,
  quantity NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','approved','rejected','written_off')),
  reported_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS accounts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  account_code TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','income','expense')),
  parent_account_id UUID,
  is_control_account BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, account_code),
  FOREIGN KEY (tenant_id, parent_account_id) REFERENCES accounts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS journal_entries (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  journal_number TEXT NOT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  source_type TEXT,
  source_id UUID,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, journal_number),
  CHECK ((status = 'draft' AND posted_at IS NULL) OR (status IN ('posted','reversed') AND posted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  account_id UUID NOT NULL,
  debit NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, journal_entry_id, line_number),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS invoices_tenant_customer_date_idx ON invoices (tenant_id, customer_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS payments_tenant_customer_date_idx ON payments (tenant_id, customer_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_tenant_product_date_idx ON stock_movements (tenant_id, product_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS journal_entries_tenant_date_idx ON journal_entries (tenant_id, entry_date DESC);

COMMIT;
