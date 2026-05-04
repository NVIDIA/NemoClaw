.PHONY: check lint format format-biome lint-ts format-ts check-installer-hash docs docs-strict docs-live docs-clean

check:
	npx prek run --all-files
	@echo "All checks passed."

lint: check

# Targeted subproject checks (not part of `make check` — use for focused runs).
lint-ts:
	cd nemoclaw && npm run check

format: format-biome

format-biome:
	npx biome format --write .

format-ts:
	cd nemoclaw && npm run lint:fix && npm run format

# --- Integrity checks ---

check-installer-hash:
	bash scripts/check-installer-hash.sh

# --- Documentation ---

docs:
	uv run --group docs sphinx-build -b html docs docs/_build/html

docs-strict:
	uv run --group docs sphinx-build -W -b html docs docs/_build/html

docs-live:
	uv run --group docs sphinx-autobuild docs docs/_build/html --open-browser

docs-clean:
	rm -rf docs/_build
