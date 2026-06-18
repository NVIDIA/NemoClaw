---
name: nemo-rl-docs
license: Apache-2.0
description: "Documentation conventions for NeMo-RL. Covers docs/index.md updates and docstring format. Do NOT use for: bug fixes, test fixes, dependency bumps, refactoring, CI/CD changes, performance tuning, or any task that does not involve writing or updating documentation."
when_to_use: Adding or updating documentation; adding a new markdown file; reviewing docstrings; 'docs/index.md', 'docstring format', 'Sphinx', 'where do I add docs', during code review.
---

# Documentation Conventions

## Keep docs/index.md Up to Date

When a new markdown doc is added under `docs/**/*.md` or a markdown file is renamed, ensure that @docs/index.md is updated and the document appears in the most appropriate section.

## Docstring Format

Use [Google style](https://google.github.io/styleguide/pyguide.html) docstrings for classes and functions. These are parseable by Sphinx.

For interfaces that may be used outside a file, prefer docstrings over comments. Comments should be reserved for code within a function or interfaces local to a file.

## Document New Features

When a new feature is added, update or create documentation in the `docs/` directory that most closely matches the feature. Look at existing docs to find the best fit — if none exists, create a new doc and add it to @docs/index.md.

Documentation changes are **not required** for bug fixes or CI-related changes.
