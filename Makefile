.PHONY: help check-guidance check-public check-fixtures native-fixture-check dev-db-up dev-db-down backend-sync backend-lint backend-test frontend-install frontend-typecheck frontend-test frontend-build runner-test portable-test
help:
	@printf '%s\n' 'Targets: check-guidance check-public dev-db-up dev-db-down backend-sync backend-lint backend-test' \
	  'frontend-install frontend-typecheck frontend-test frontend-build runner-test portable-test' \
	  'check-fixtures native-fixture-check (requires NATIVE_EVIDENCE_DIR outside checkout)'
check-guidance:
	python3 scripts/check_guidance.py
check-public:
	python3 scripts/check_public_tree.py
check-fixtures:
	python3 scripts/check_native_fixtures.py
	python3 -m unittest discover -s tests/native -v
# Explicit integration checkpoint; the pinned image must already be cached.
native-fixture-check:
	@test -n "$(NATIVE_EVIDENCE_DIR)" || (echo 'Set NATIVE_EVIDENCE_DIR to an external evidence directory' >&2; exit 2)
	python3 scripts/check_native_fixtures.py --real-tools --output "$(NATIVE_EVIDENCE_DIR)"
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
runner-test:
	PYTHONPATH=runner python3 -m unittest discover -s runner/tests -v
portable-test:
	python3 -I -S -m unittest discover -s tests/portable -v
