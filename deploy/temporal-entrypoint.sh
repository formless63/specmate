#!/bin/bash
set -euo pipefail
if (($#)); then exec "$@"; fi
export PGHOST="${POSTGRES_SEEDS:?}" PGPORT="${DB_PORT:-5432}" PGCONNECT_TIMEOUT=5
export SQL_HOST="$PGHOST" SQL_PORT="$PGPORT" SQL_PLUGIN=postgres12
for SPECMATE_TEMPORAL_SCHEMA in temporal visibility; do
  export SPECMATE_TEMPORAL_SCHEMA
  if [[ "$SPECMATE_TEMPORAL_SCHEMA" == temporal ]]; then
    export PGDATABASE="$DBNAME" PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PWD"
  else
    export PGDATABASE="$VISIBILITY_DBNAME" PGUSER="$VISIBILITY_POSTGRES_USER" PGPASSWORD="$VISIBILITY_POSTGRES_PWD"
  fi
  export SQL_DATABASE="$PGDATABASE" SQL_USER="$PGUSER" SQL_PASSWORD="$PGPASSWORD"
  # The parent psql connection owns the session lock while its child applies upstream
  # versioned schemas. Failure in either process makes startup fail, never appear ready.
  psql -X --set ON_ERROR_STOP=1 --set lock_timeout="${SPECMATE_STARTUP_TIMEOUT:-120}s" <<'SQL'
SELECT set_config('lock_timeout', :'lock_timeout', false);
SELECT pg_advisory_lock(6003371201704182096);
\! /opt/specmate/temporal-migrate.sh
\if :SHELL_ERROR
DO $$ BEGIN RAISE EXCEPTION 'Temporal schema initialization failed'; END $$;
\endif
SQL
done
unset PGDATABASE PGUSER PGPASSWORD SQL_DATABASE SQL_USER SQL_PASSWORD
export BIND_ON_IP=0.0.0.0
export TEMPORAL_BROADCAST_ADDRESS="$(hostname -i | awk '{print $1}')"
# Namespace creation belongs to this service's startup. Readiness requires that it exists.
(
  deadline=$((SECONDS + ${SPECMATE_STARTUP_TIMEOUT:-120}))
  export TEMPORAL_ADDRESS=127.0.0.1:7233
  until temporal operator cluster health >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo 'Timed out waiting for Temporal namespace bootstrap.' >&2
      exit 1
    fi
    sleep 1
  done
  if ! temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
    temporal operator namespace create --namespace "$TEMPORAL_NAMESPACE" --retention 72h || \
      temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE"
  fi
) &
exec temporal-server --allow-no-auth start
