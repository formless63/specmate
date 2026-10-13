#!/usr/bin/env sh
# Disposable PostgreSQL for local backend tests. Data lives in tmpfs and disappears on
# stop. "down" only removes the container carrying this exact name and disposable label.
set -eu
NAME=specmate-dev-postgres
PORT=${SPECMATE_DEV_DB_PORT:-55432}
IMAGE=$(python3 -c 'import json;i=json.load(open("deploy/images.json"))["images"]["postgres"];print(i["ref"]+"@"+i["digest"])')
case "${1:-}" in
  up)
    if docker container inspect "$NAME" >/dev/null 2>&1; then echo "$NAME already exists"; exit 0; fi
    docker run -d --name "$NAME" --label org.specmate.disposable=true \
      --tmpfs /var/lib/postgresql:rw -p "127.0.0.1:$PORT:5432" \
      -e POSTGRES_USER=specmate -e POSTGRES_PASSWORD=specmate-dev -e POSTGRES_DB=specmate \
      "$IMAGE" >/dev/null
    until docker exec "$NAME" pg_isready -U specmate -d specmate >/dev/null 2>&1; do sleep 1; done
    echo "ready: SPECMATE_DB_HOST=127.0.0.1 SPECMATE_DB_PORT=$PORT SPECMATE_DB_PASSWORD=specmate-dev"
    ;;
  down)
    label=$(docker container inspect -f '{{index .Config.Labels "org.specmate.disposable"}}' "$NAME" 2>/dev/null || true)
    if [ "$label" != "true" ]; then echo "no disposable $NAME container"; exit 0; fi
    docker rm -f "$NAME" >/dev/null && echo "removed $NAME"
    ;;
  *) echo "usage: scripts/dev_postgres.sh up|down" >&2; exit 2 ;;
esac
