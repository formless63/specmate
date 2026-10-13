#!/bin/bash
set -euo pipefail
# psql variables quote both identifiers and values; passwords never become shell/SQL code.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set app_password="$SPECMATE_DB_PASSWORD" \
  --set temporal_password="$TEMPORAL_DB_PASSWORD" \
  --set visibility_password="$TEMPORAL_VISIBILITY_DB_PASSWORD" <<'SQL'
CREATE ROLE specmate LOGIN PASSWORD :'app_password';
CREATE ROLE temporal LOGIN PASSWORD :'temporal_password';
CREATE ROLE temporal_visibility LOGIN PASSWORD :'visibility_password';
CREATE DATABASE specmate OWNER specmate;
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal_visibility;
REVOKE ALL ON DATABASE specmate FROM PUBLIC;
REVOKE ALL ON DATABASE temporal FROM PUBLIC;
REVOKE ALL ON DATABASE temporal_visibility FROM PUBLIC;
\connect specmate
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
