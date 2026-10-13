#!/bin/bash
set -euo pipefail
temporal-sql-tool setup-schema --version 0.0
temporal-sql-tool update-schema --schema-dir "/etc/temporal/schema/postgresql/v12/${SPECMATE_TEMPORAL_SCHEMA}/versioned"
