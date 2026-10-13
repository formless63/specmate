from django.db import migrations

FORWARD = """
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
DECLARE project uuid;
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
  SELECT d.project_id INTO project FROM catalog_physicallot l
    JOIN design_revision r ON r.id = l.revision_id
    JOIN design_definition d ON d.id = r.definition_id WHERE l.id = NEW.lot_id;
  IF NOT EXISTS (SELECT 1 FROM inventory_location WHERE id = NEW.location_id AND project_id = project)
    OR EXISTS (SELECT 1 FROM inventory_stockaccount WHERE lot_id = NEW.lot_id AND dimension != NEW.dimension) THEN
    RAISE EXCEPTION 'inventory scope or lot dimension mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_account_guard BEFORE INSERT OR UPDATE OR DELETE ON inventory_stockaccount
FOR EACH ROW EXECUTE FUNCTION specmate_inventory_account_guard();

CREATE FUNCTION specmate_inventory_reserved(account uuid) RETURNS numeric AS $$
  SELECT coalesce(sum(r.quantity), 0) FROM inventory_reservation r
    LEFT JOIN inventory_reservationrelease release ON release.reservation_id = r.id
    WHERE r.account_id = account AND release.id IS NULL;
$$ LANGUAGE sql;

CREATE FUNCTION specmate_inventory_entry_guard() RETURNS trigger AS $$
DECLARE dimension text; prior numeric; seq integer; value numeric; next_value numeric;
BEGIN
  SELECT a.dimension INTO dimension FROM inventory_stockaccount a WHERE a.id = NEW.account_id FOR UPDATE;
  SELECT e.after, e.sequence INTO prior, seq FROM inventory_stockentry e
    WHERE e.account_id = NEW.account_id ORDER BY e.sequence DESC LIMIT 1;
  IF NEW.sequence != coalesce(seq, 0) + 1 OR NEW.before IS DISTINCT FROM prior
    OR NEW.reason = '' OR NEW.assertion_source = '' THEN
    RAISE EXCEPTION 'invalid ledger continuity or assertion' USING ERRCODE = 'check_violation';
  END IF;
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
  ELSE
    RAISE EXCEPTION 'invalid ledger transition' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.after IS DISTINCT FROM next_value OR next_value < 0
    OR next_value < specmate_inventory_reserved(NEW.account_id) THEN
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
"""

REVERSE = """
DROP TRIGGER inventory_location_immutable ON inventory_location;
DROP TRIGGER inventory_entry_immutable ON inventory_stockentry;
DROP TRIGGER inventory_reservation_immutable ON inventory_reservation;
DROP TRIGGER inventory_release_immutable ON inventory_reservationrelease;
DROP TRIGGER inventory_release_guard ON inventory_reservationrelease;
DROP FUNCTION specmate_inventory_release_guard();
DROP TRIGGER inventory_reservation_guard ON inventory_reservation;
DROP FUNCTION specmate_inventory_reservation_guard();
DROP TRIGGER inventory_entry_guard ON inventory_stockentry;
DROP FUNCTION specmate_inventory_entry_guard();
DROP FUNCTION specmate_inventory_reserved(uuid);
DROP TRIGGER inventory_account_guard ON inventory_stockaccount;
DROP FUNCTION specmate_inventory_account_guard();
DROP FUNCTION specmate_inventory_convert(numeric, text, text);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("inventory", "0001_initial"),
        ("catalog", "0002_identity_invariants"),
        ("operations", "0002_immutable_rows"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
