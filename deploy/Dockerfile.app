FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS build
RUN pip install --no-cache-dir uv==0.13.0
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DJANGO_SETTINGS_MODULE=specmate.settings
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
