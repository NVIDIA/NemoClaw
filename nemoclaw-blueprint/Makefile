.PHONY: lint format check

lint:
	ruff check .

format:
	ruff format .
	ruff check --fix .

check:
	ruff check .
	ruff format --check .
	uv run --with pyright pyright .
