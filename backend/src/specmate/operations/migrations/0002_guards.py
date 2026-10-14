"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable record: % on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION specmate_preserve_workspace() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'workspace identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION specmate_project_context() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'project context is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM access_project WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'project context must belong to the record workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

REVERSE = r"""
DROP FUNCTION IF EXISTS specmate_project_context();
DROP FUNCTION IF EXISTS specmate_preserve_workspace();
DROP FUNCTION IF EXISTS specmate_reject_mutation();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0002_projectreference"),
        ("operations", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
