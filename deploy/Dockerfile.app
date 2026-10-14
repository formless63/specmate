# Source of the version-matched PostgreSQL client tools (backup/restore) and the signing
# key for their pinned client library; not a running service.
FROM postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 AS pgclient

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS build
RUN pip install --no-cache-dir uv==0.13.0
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DJANGO_SETTINGS_MODULE=specmate.settings \
    SPECMATE_PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump SPECMATE_PG_RESTORE=/usr/lib/postgresql/18/bin/pg_restore
# pg_dump/pg_restore must match the server major. The binaries come from the pinned server
# image; libpq is pinned to the same build from the signed PostgreSQL archive repository.
COPY --from=pgclient /usr/local/share/keyrings/postgres.gpg.asc /usr/local/share/keyrings/postgres.gpg.asc
ARG PG_CLIENT_VERSION=18.6-1.pgdg13+2
RUN set -eux; \
    echo "deb [ signed-by=/usr/local/share/keyrings/postgres.gpg.asc ] http://apt-archive.postgresql.org/pub/repos/apt trixie-pgdg-archive main" \
      > /etc/apt/sources.list.d/pgdg-archive.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "libpq5=${PG_CLIENT_VERSION}" liblz4-1 libzstd1 zlib1g; \
    rm -rf /var/lib/apt/lists/*
COPY --from=pgclient /usr/lib/postgresql/18/bin/pg_dump /usr/lib/postgresql/18/bin/pg_restore /usr/lib/postgresql/18/bin/
COPY --from=pgclient /usr/share/doc/postgresql-client-18/copyright /usr/share/doc/postgresql-client-18/copyright
RUN "$SPECMATE_PG_DUMP" --version && "$SPECMATE_PG_RESTORE" --version
RUN groupadd --gid 10001 specmate && useradd --uid 10001 --gid 10001 --no-create-home specmate \
    && mkdir -p /var/lib/specmate/artifacts && chown -R specmate:specmate /var/lib/specmate
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY backend/manage.py ./manage.py
COPY LICENSE NOTICE /usr/share/doc/specmate/
COPY --chmod=755 deploy/app-entrypoint.sh /usr/local/bin/specmate-entrypoint
USER specmate
ENTRYPOINT ["specmate-entrypoint"]
CMD ["app"]
