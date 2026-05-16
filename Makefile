.PHONY: check lint format format-biome lint-ts format-ts check-installer-hash docs docs-strict docs-live docs-clean

check:
	npm run check

lint:
	npm run check

# Targeted subproject checks (not part of `make check` — use for focused runs).
lint-ts:
	npm run lint:ts

format:
	npm run format

format-biome:
	npm run format

format-ts:
	npm run format:ts

# --- Integrity checks ---

check-installer-hash:
	npm run check:installer-hash

# --- Documentation ---

docs:
	npm run docs

docs-strict:
	npm run docs:strict

docs-live:
	npm run docs:live

docs-clean:
	npm run docs:clean
