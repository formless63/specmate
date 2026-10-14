"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_inventory_convert(amount numeric, unit text, dimension text)
RETURNS numeric AS $$
DECLARE factor numeric;
BEGIN
  factor := CASE
    WHEN dimension = 'count' AND unit = 'ea' AND amount = trunc(amount) THEN 1
    WHEN dimension = 'length' AND unit = 'm' THEN 1
    WHEN dimension = 'length' AND unit = 'cm' THEN 0.01
    WHEN dimension = 'length' AND unit = 'mm' THEN 0.001
    WHEN dimension = 'mass' AND unit = 'kg' THEN 1
    WHEN dimension = 'mass' AND unit = 'g' THEN 0.001
    ELSE NULL END;
  IF factor IS NULL OR amount IS NULL OR amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR amount * factor != round(amount * factor, 9) THEN
    RAISE EXCEPTION 'invalid inventory quantity dimension or precision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN amount * factor;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION specmate_inventory_account_guard() RETURNS trigger AS $$
DECLARE workspace uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock account is immutable' USING ERRCODE = 'check_violation';
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
      RAISE EXCEPTION 'stock account identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM catalog_physicallot WHERE id = NEW.lot_id FOR UPDATE;
  SELECT d.workspace_id INTO workspace FROM catalog_physicallot l
    JOIN design_revision r ON r.id = l.revision_id
    JOIN design_definition d ON d.id = r.definition_id WHERE l.id = NEW.lot_id;
  IF NOT EXISTS (SELECT 1 FROM inventory_location WHERE id = NEW.location_id AND workspace_id = workspace)
    OR EXISTS (SELECT 1 FROM inventory_stockaccount WHERE lot_id = NEW.lot_id AND dimension != NEW.dimension) THEN
    RAISE EXCEPTION 'inventory scope or lot dimension mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_account_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stockaccount
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_account_guard();

CREATE FUNCTION specmate_inventory_reserved(account uuid) RETURNS numeric AS $$
  SELECT coalesce(sum(r.quantity - coalesce((
    SELECT sum(e.before - e.after) FROM inventory_stockentry e
      WHERE e.reservation_id = r.id AND e.kind = 'consumption'
  ), 0)), 0) FROM inventory_reservation r
    LEFT JOIN inventory_reservationrelease release ON release.reservation_id = r.id
    WHERE r.account_id = account AND release.id IS NULL;
$$ LANGUAGE sql;

CREATE FUNCTION specmate_inventory_entry_guard() RETURNS trigger AS $$
DECLARE dimension text; prior numeric; seq integer; value numeric; next_value numeric;
  projected_reserved numeric; remaining numeric; original inventory_stockentry%ROWTYPE;
  target_workspace uuid;
BEGIN
  SELECT a.dimension INTO dimension FROM inventory_stockaccount a WHERE a.id = NEW.account_id FOR UPDATE;
  SELECT e.after, e.sequence INTO prior, seq FROM inventory_stockentry e
    WHERE e.account_id = NEW.account_id ORDER BY e.sequence DESC LIMIT 1;
  IF NEW.physical_unit_id IS NOT NULL AND NEW.kind NOT IN ('consumption', 'return') THEN
    RAISE EXCEPTION 'unit attribution requires material usage' USING ERRCODE = 'check_violation';
  END IF;
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
    SELECT d.workspace_id INTO target_workspace FROM inventory_workbatch b
      JOIN design_revision r ON r.id = b.revision_id
      JOIN design_definition d ON d.id = r.definition_id
      WHERE b.id = NEW.work_batch_id FOR UPDATE OF b;
    IF target_workspace IS NULL OR NOT EXISTS (
      SELECT 1 FROM inventory_stockaccount a JOIN inventory_location l ON l.id = a.location_id
      WHERE a.id = NEW.account_id AND l.workspace_id = target_workspace
    ) THEN
      RAISE EXCEPTION 'work target and stock scope mismatch' USING ERRCODE = 'check_violation';
    END IF;
    value := specmate_inventory_convert(NEW.amount, NEW.unit, dimension);
    IF value <= 0 THEN
      RAISE EXCEPTION 'usage quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'consumption' THEN
      IF NEW.physical_unit_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM physical_units_workunitlink link
          WHERE link.unit_id = NEW.physical_unit_id AND link.work_batch_id = NEW.work_batch_id
      ) THEN
        RAISE EXCEPTION 'unit usage must match linked work' USING ERRCODE = 'check_violation';
      END IF;
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
      IF NEW.physical_unit_id IS DISTINCT FROM original.physical_unit_id THEN
        RAISE EXCEPTION 'return unit must match consumption' USING ERRCODE = 'check_violation';
      END IF;
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

CREATE TRIGGER inventory_entry_guard BEFORE INSERT ON inventory_stockentry
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_entry_guard();

CREATE FUNCTION specmate_inventory_reservation_guard() RETURNS trigger AS $$
DECLARE dimension text; physical numeric;
BEGIN
  SELECT a.dimension INTO dimension FROM inventory_stockaccount a WHERE a.id = NEW.account_id FOR UPDATE;
  SELECT e.after INTO physical FROM inventory_stockentry e WHERE e.account_id = NEW.account_id
    ORDER BY e.sequence DESC LIMIT 1;
  IF NEW.quantity IS DISTINCT FROM specmate_inventory_convert(NEW.amount, NEW.unit, dimension)
    OR NEW.purpose = '' OR physical IS NULL
    OR NEW.quantity + specmate_inventory_reserved(NEW.account_id) > physical THEN
    RAISE EXCEPTION 'invalid reservation or insufficient stock' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE inventory_stockaccount SET state = gen_random_uuid() WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_reservation_guard BEFORE INSERT ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_reservation_guard();

CREATE FUNCTION specmate_inventory_release_guard() RETURNS trigger AS $$
DECLARE account uuid;
BEGIN
  SELECT r.account_id INTO account FROM inventory_reservation r WHERE r.id = NEW.reservation_id;
  PERFORM 1 FROM inventory_stockaccount WHERE id = account FOR UPDATE;
  IF NEW.reason = '' THEN
    RAISE EXCEPTION 'release requires reason' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE inventory_stockaccount SET state = gen_random_uuid() WHERE id = account;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_release_guard BEFORE INSERT ON inventory_reservationrelease
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_release_guard();

CREATE TRIGGER inventory_location_immutable BEFORE UPDATE OR DELETE ON inventory_location
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER inventory_entry_immutable BEFORE UPDATE OR DELETE ON inventory_stockentry
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER inventory_reservation_immutable BEFORE UPDATE OR DELETE ON inventory_reservation
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER inventory_release_immutable BEFORE UPDATE OR DELETE ON inventory_reservationrelease
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

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

CREATE FUNCTION specmate_inventory_project_context() RETURNS trigger AS $$
DECLARE target uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'project context is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'inventory_reservation' THEN
    SELECT l.workspace_id INTO target FROM inventory_stockaccount a
      JOIN inventory_location l ON l.id = a.location_id WHERE a.id = NEW.account_id;
  ELSE
    SELECT d.workspace_id INTO target FROM design_revision r
      JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM access_project WHERE id = NEW.project_id AND workspace_id = target)
  THEN
    RAISE EXCEPTION 'project context must belong to the record workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_reservation_project_context BEFORE INSERT OR UPDATE
ON inventory_reservation FOR EACH ROW EXECUTE FUNCTION specmate_inventory_project_context();

CREATE TRIGGER inventory_workbatch_project_context BEFORE INSERT OR UPDATE
ON inventory_workbatch FOR EACH ROW EXECUTE FUNCTION specmate_inventory_project_context();

CREATE TRIGGER inventory_location_workspace_fixed BEFORE UPDATE ON inventory_location
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS inventory_location_workspace_fixed ON inventory_location;
DROP TRIGGER IF EXISTS inventory_workbatch_project_context ON inventory_workbatch;
DROP TRIGGER IF EXISTS inventory_reservation_project_context ON inventory_reservation;
DROP FUNCTION IF EXISTS specmate_inventory_project_context();
DROP TRIGGER IF EXISTS inventory_completion_immutable ON inventory_workcompletion;
DROP TRIGGER IF EXISTS inventory_completion_guard ON inventory_workcompletion;
DROP FUNCTION IF EXISTS specmate_inventory_completion_guard();
DROP TRIGGER IF EXISTS inventory_work_guard ON inventory_workbatch;
DROP FUNCTION IF EXISTS specmate_inventory_work_guard();
DROP TRIGGER IF EXISTS inventory_release_immutable ON inventory_reservationrelease;
DROP TRIGGER IF EXISTS inventory_reservation_immutable ON inventory_reservation;
DROP TRIGGER IF EXISTS inventory_entry_immutable ON inventory_stockentry;
DROP TRIGGER IF EXISTS inventory_location_immutable ON inventory_location;
DROP TRIGGER IF EXISTS inventory_release_guard ON inventory_reservationrelease;
DROP FUNCTION IF EXISTS specmate_inventory_release_guard();
DROP TRIGGER IF EXISTS inventory_reservation_guard ON inventory_reservation;
DROP FUNCTION IF EXISTS specmate_inventory_reservation_guard();
DROP TRIGGER IF EXISTS inventory_entry_guard ON inventory_stockentry;
DROP FUNCTION IF EXISTS specmate_inventory_entry_guard();
DROP FUNCTION IF EXISTS specmate_inventory_reserved();
DROP TRIGGER IF EXISTS inventory_account_guard ON inventory_stockaccount;
DROP FUNCTION IF EXISTS specmate_inventory_account_guard();
DROP FUNCTION IF EXISTS specmate_inventory_convert();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0002_projectreference"),
        ("catalog", "0001_initial"),
        ("design", "0001_initial"),
        ("inventory", "0002_stockentry_physical_unit"),
        ("operations", "0002_guards"),
        ("physical_units", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
