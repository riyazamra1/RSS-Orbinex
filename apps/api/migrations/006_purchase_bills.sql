-- Supplier purchase bills and supplier payments for RSS Orbinex.
BEGIN;

CREATE TABLE IF NOT EXISTS purchase_bills (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  supplier_id UUID NOT NULL,
  supplier_invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','partially_paid','paid','void')),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  subtotal NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  posted_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,bill_number),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id) ON DELETE RESTRICT,
  CHECK (due_date IS NULL OR due_date >= bill_date),
  CHECK ((status IN ('draft','void') AND posted_at IS NULL) OR (status IN ('posted','partially_paid','paid') AND posted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS purchase_bill_lines (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  product_id UUID,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  quantity NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(19,4) NOT NULL CHECK (unit_cost >= 0),
  tax_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total NUMERIC(19,4) GENERATED ALWAYS AS (quantity * unit_cost + tax_amount) STORED,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,bill_id,line_number),
  FOREIGN KEY (tenant_id,bill_id) REFERENCES purchase_bills(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  payment_number TEXT NOT NULL,
  supplier_id UUID NOT NULL,
  bill_id UUID NOT NULL,
  amount NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','card','cheque','other')),
  reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,payment_number),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,bill_id) REFERENCES purchase_bills(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS purchase_bills_tenant_supplier_date_idx ON purchase_bills (tenant_id,supplier_id,bill_date DESC);
CREATE INDEX IF NOT EXISTS supplier_payments_tenant_bill_date_idx ON supplier_payments (tenant_id,bill_id,paid_at DESC);

COMMIT;
