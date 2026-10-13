.PHONY: help check-guidance check-public backend-sync backend-lint backend-test frontend-install frontend-typecheck frontend-test frontend-build
help:
	@printf '%s\n' 'Targets: check-guidance check-public backend-sync backend-lint backend-test' \
	  'frontend-install frontend-typecheck frontend-test frontend-build'
check-guidance:
	python3 scripts/check_guidance.py
check-public:
	python3 scripts/check_public_tree.py
backend-sync:
	cd backend && uv sync --frozen
backend-lint:
	cd backend && uv run --frozen ruff check . && uv run --frozen ruff format --check .
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
