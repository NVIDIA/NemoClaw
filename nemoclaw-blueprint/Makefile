.PHONY: lint format check test

lint:
	ruff check .

format:
	ruff format .
	ruff check --fix .

check:
	ruff check .
	ruff format --check .

test:
	python -m pytest tests/ -v
