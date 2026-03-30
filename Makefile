.PHONY: check lint format lint-ts format-ts docs docs-strict docs-live docs-clean

check:
	npx prek run --all-files
	@echo "All checks passed."

lint: check

# Targeted subproject checks (not part of `make check` — use for focused runs).
lint-ts:
	cd nemoclaw && npm run check

format: format-ts

format-ts:
	cd nemoclaw && npm run lint:fix && npm run format

# --- Documentation ---

docs:
	uv run --group docs sphinx-build -b html docs docs/_build/html

docs-strict:
	uv run --group docs sphinx-build -W -b html docs docs/_build/html

docs-live:
	uv run --group docs sphinx-autobuild docs docs/_build/html --open-browser

docs-clean:
	rm -rf docs/_build
