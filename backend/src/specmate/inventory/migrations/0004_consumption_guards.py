from importlib import import_module

from django.db import migrations

FORWARD = r"""
CREATE OR REPLACE FUNCTION specmate_inventory_reserved(account uuid) RETURNS numeric AS $$
  SELECT coalesce(sum(r.quantity - coalesce((
    SELECT sum(e.before - e.after) FROM inventory_stockentry e
      WHERE e.reservation_id = r.id AND e.kind = 'consumption'
  ), 0)), 0) FROM inventory_reservation r
    LEFT JOIN inventory_reservationrelease release ON release.reservation_id = r.id
    WHERE r.account_id = account AND release.id IS NULL;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION specmate_inventory_entry_guard() RETURNS trigger AS $$
DECLARE dimension text; prior numeric; seq integer; value numeric; next_value numeric;
  projected_reserved numeric; remaining numeric; original inventory_stockentry%ROWTYPE;
  target_project uuid;
BEGIN
  SELECT a.dimension INTO dimension FROM inventory_stockaccount a WHERE a.id = NEW.account_id FOR UPDATE;
  SELECT e.after, e.sequence INTO prior, seq FROM inventory_stockentry e
    WHERE e.account_id = NEW.account_id ORDER BY e.sequence DESC LIMIT 1;
  IF NEW.sequence != coalesce(seq, 0) + 1 OR NEW.before IS DISTINCT FROM prior
    OR NEW.reason = '' OR NEW.assertion_source = '' THEN
    RAISE EXCEPTION 'invalid ledger continuity or assertion' USING ERRCODE = 'check_violation';
  END IF;
  projected_reserved := specmate_inventory_reserved(NEW.account_id);
  IF NEW.kind = 'opening' AND seq IS NULL THEN
    IF NEW.amount IS NULL AND NEW.after IS NULL THEN
      IF NEW.unit != (CASE dimension WHEN 'count' THEN 'ea' WHEN 'length' THEN 'm' ELSE 'kg' END) THEN
        RAISE EXCEPTION 'unknown opening unit mismatch' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE inventory_stockaccount SET state = gen_random_uuid() WHERE id = NEW.account_id;
      RETURN NEW;
    END IF;
    next_value := specmate_inventory_convert(NEW.amount, NEW.unit, dimension);
  ELSIF NEW.kind = 'observation' AND seq IS NOT NULL THEN
    next_value := specmate_inventory_convert(NEW.amount, NEW.unit, dimension);
  ELSIF NEW.kind IN ('receipt', 'adjustment') AND prior IS NOT NULL THEN
    value := specmate_inventory_convert(NEW.amount, NEW.unit, dimension);
    IF (NEW.kind = 'receipt' AND value <= 0) OR (NEW.kind = 'adjustment' AND value = 0) THEN
      RAISE EXCEPTION 'invalid stock change' USING ERRCODE = 'check_violation';
    END IF;
    next_value := prior + value;
  ELSIF NEW.kind IN ('consumption', 'return') AND prior IS NOT NULL THEN
    SELECT d.project_id INTO target_project FROM inventory_workbatch b
      JOIN design_revision r ON r.id = b.revision_id
      JOIN design_definition d ON d.id = r.definition_id
      WHERE b.id = NEW.work_batch_id FOR UPDATE OF b;
    IF target_project IS NULL OR NOT EXISTS (
      SELECT 1 FROM inventory_stockaccount a JOIN inventory_location l ON l.id = a.location_id
      WHERE a.id = NEW.account_id AND l.project_id = target_project
    ) THEN
      RAISE EXCEPTION 'work target and stock scope mismatch' USING ERRCODE = 'check_violation';
    END IF;
    value := specmate_inventory_convert(NEW.amount, NEW.unit, dimension);
    IF value <= 0 THEN
      RAISE EXCEPTION 'usage quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'consumption' THEN
      SELECT r.quantity - coalesce((SELECT sum(e.before - e.after) FROM inventory_stockentry e
        WHERE e.kind = 'consumption' AND e.reservation_id = r.id), 0) INTO remaining
        FROM inventory_reservation r WHERE r.id = NEW.reservation_id AND r.account_id = NEW.account_id
          AND NOT EXISTS (SELECT 1 FROM inventory_reservationrelease release WHERE release.reservation_id = r.id);
      IF remaining IS NULL OR value > remaining THEN
        RAISE EXCEPTION 'consumption exceeds remaining reservation' USING ERRCODE = 'check_violation';
      END IF;
      next_value := prior - value;
      projected_reserved := projected_reserved - value;
    ELSE
      SELECT * INTO original FROM inventory_stockentry WHERE id = NEW.consumption_origin_id;
      IF original.kind IS DISTINCT FROM 'consumption' OR original.account_id IS DISTINCT FROM NEW.account_id
        OR original.work_batch_id IS DISTINCT FROM NEW.work_batch_id THEN
        RAISE EXCEPTION 'return must reference exact same-account work consumption' USING ERRCODE = 'check_violation';
      END IF;
      SELECT original.before - original.after - coalesce(sum(e.after - e.before), 0) INTO remaining
        FROM inventory_stockentry e WHERE e.kind = 'return' AND e.consumption_origin_id = original.id;
      IF value > remaining THEN
        RAISE EXCEPTION 'return exceeds consumed unreturned quantity' USING ERRCODE = 'check_violation';
      END IF;
      next_value := prior + value;
    END IF;
    UPDATE inventory_workbatch SET state = gen_random_uuid() WHERE id = NEW.work_batch_id;
  ELSE
    RAISE EXCEPTION 'invalid ledger transition' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.after IS DISTINCT FROM next_value OR next_value < 0 OR next_value < projected_reserved THEN
    RAISE EXCEPTION 'invalid balance or stock below reservations' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE inventory_stockaccount SET state = gen_random_uuid() WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION specmate_inventory_work_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'work target identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_work_guard BEFORE UPDATE OR DELETE ON inventory_workbatch
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_work_guard();

CREATE FUNCTION specmate_inventory_completion_guard() RETURNS trigger AS $$
DECLARE planned integer; completed bigint; seq integer;
BEGIN
  SELECT b.planned_units INTO planned FROM inventory_workbatch b WHERE b.id = NEW.work_batch_id FOR UPDATE;
  SELECT coalesce(sum(c.units_completed), 0), coalesce(max(c.sequence), 0) INTO completed, seq
    FROM inventory_workcompletion c WHERE c.work_batch_id = NEW.work_batch_id;
  IF NEW.sequence != seq + 1 OR NEW.reason = '' OR NEW.assertion_source = ''
    OR (planned IS NOT NULL AND completed + NEW.units_completed > planned) THEN
    RAISE EXCEPTION 'invalid work completion assertion or planned count exceeded' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE inventory_workbatch SET state = gen_random_uuid() WHERE id = NEW.work_batch_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_completion_guard BEFORE INSERT ON inventory_workcompletion
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_completion_guard();
CREATE TRIGGER inventory_completion_immutable BEFORE UPDATE OR DELETE ON inventory_workcompletion
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""

# Restore the checked-in predecessor functions before removing the added columns/tables.
PREVIOUS = import_module("specmate.inventory.migrations.0002_ledger_guards").FORWARD


def previous_function(name):
    start = PREVIOUS.index(f"CREATE FUNCTION {name}(")
    end = PREVIOUS.index("$$ LANGUAGE", start)
    end = PREVIOUS.index(";", end) + 1
    return PREVIOUS[start:end].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)


REVERSE = (
    """
DROP TRIGGER inventory_completion_immutable ON inventory_workcompletion;
DROP TRIGGER inventory_completion_guard ON inventory_workcompletion;
DROP FUNCTION specmate_inventory_completion_guard();
DROP TRIGGER inventory_work_guard ON inventory_workbatch;
DROP FUNCTION specmate_inventory_work_guard();
"""
    + previous_function("specmate_inventory_reserved")
    + previous_function("specmate_inventory_entry_guard")
)


class Migration(migrations.Migration):
    dependencies = [("inventory", "0003_workbatch_workcompletion_and_more")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
