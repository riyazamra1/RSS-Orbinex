-- Guard immutable financial history and enforce balanced posted journals.
BEGIN;

CREATE OR REPLACE FUNCTION rss_orbinex_guard_invoice_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted', 'partially_paid', 'paid', 'void') THEN
    IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RAISE EXCEPTION 'Posted invoice fields are immutable; use a credit note or reversal';
    END IF;
    IF NEW.status NOT IN (OLD.status,
      CASE WHEN OLD.status = 'posted' THEN 'partially_paid' ELSE OLD.status END,
      CASE WHEN OLD.status IN ('posted','partially_paid') THEN 'paid' ELSE OLD.status END) THEN
      RAISE EXCEPTION 'Invalid posted invoice status transition';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_guard_update ON invoices;
CREATE TRIGGER invoices_guard_update BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_guard_invoice_update();

CREATE OR REPLACE FUNCTION rss_orbinex_guard_posted_invoice_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant UUID;
  target_invoice UUID;
  invoice_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_invoice := OLD.invoice_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_invoice := NEW.invoice_id;
  END IF;
  SELECT status INTO invoice_status FROM invoices
    WHERE tenant_id = target_tenant AND id = target_invoice FOR UPDATE;
  IF invoice_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Invoice lines can only change while invoice is draft';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS invoice_lines_guard_mutation ON invoice_lines;
CREATE TRIGGER invoice_lines_guard_mutation BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_guard_posted_invoice_lines();

CREATE OR REPLACE FUNCTION rss_orbinex_append_only_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Financial and stock history is append-only; use a reversal entry';
END;
$$;

DROP TRIGGER IF EXISTS payments_append_only ON payments;
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_append_only_ledger();

DROP TRIGGER IF EXISTS stock_movements_append_only ON stock_movements;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_append_only_ledger();

CREATE OR REPLACE FUNCTION rss_orbinex_guard_posted_journal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant UUID;
  target_journal UUID;
  journal_status TEXT;
  total_debit NUMERIC(19,4);
  total_credit NUMERIC(19,4);
  line_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    IF TG_OP = 'UPDATE' AND OLD.status IN ('posted','reversed') THEN
      IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
        RAISE EXCEPTION 'Posted journal fields are immutable; use a reversal';
      END IF;
      IF NEW.status NOT IN (OLD.status, CASE WHEN OLD.status = 'posted' THEN 'reversed' ELSE OLD.status END) THEN
        RAISE EXCEPTION 'Invalid posted journal status transition';
      END IF;
    END IF;
    IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
      SELECT COUNT(*), COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
        INTO line_count, total_debit, total_credit
        FROM journal_lines WHERE tenant_id = NEW.tenant_id AND journal_entry_id = NEW.id;
      IF line_count < 2 OR total_debit <= 0 OR total_debit <> total_credit THEN
        RAISE EXCEPTION 'A journal entry must contain at least two lines and balance debits to credits';
      END IF;
      NEW.posted_at := COALESCE(NEW.posted_at, now());
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_journal := OLD.journal_entry_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_journal := NEW.journal_entry_id;
  END IF;
  SELECT status INTO journal_status FROM journal_entries
    WHERE tenant_id = target_tenant AND id = target_journal FOR UPDATE;
  IF journal_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Journal lines can only change while journal is draft';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS journal_entries_guard_mutation ON journal_entries;
CREATE TRIGGER journal_entries_guard_mutation BEFORE UPDATE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_guard_posted_journal();

DROP TRIGGER IF EXISTS journal_lines_guard_mutation ON journal_lines;
CREATE TRIGGER journal_lines_guard_mutation BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION rss_orbinex_guard_posted_journal();

COMMIT;
