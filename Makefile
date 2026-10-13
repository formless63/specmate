.PHONY: help check-guidance check-public dev-db-up dev-db-down backend-sync backend-lint backend-test frontend-install frontend-typecheck frontend-test frontend-build
help:
	@printf '%s\n' 'Targets: check-guidance check-public dev-db-up dev-db-down backend-sync backend-lint backend-test' \
	  'frontend-install frontend-typecheck frontend-test frontend-build'
check-guidance:
	python3 scripts/check_guidance.py
check-public:
	python3 scripts/check_public_tree.py
dev-db-up:
	scripts/dev_postgres.sh up
dev-db-down:
	scripts/dev_postgres.sh down
backend-sync:
	cd backend && uv sync --frozen
backend-lint:
	cd backend && uv run --frozen ruff check . && uv run --frozen ruff format --check .
# Needs PostgreSQL: `make dev-db-up` and the SPECMATE_DB_* values it prints.
backend-test:
	cd backend && uv run --frozen pytest
frontend-install:
	bun install --frozen-lockfile
frontend-typecheck:
	bun run typecheck
frontend-test:
	bun run test
frontend-build:
	bun run build
