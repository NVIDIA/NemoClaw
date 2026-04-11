---
title: "Source: Docs — Contributing"
category: source
created: 2026-04-11
updated: 2026-04-11
tags: [docs, contributing, developer]
---

# Docs — Contributing

**Source:** `CONTRIBUTING.md`, `docs/CONTRIBUTING.md`

## Summary

Developer contribution guide. Covers prerequisites (Node.js 22.16+, Python 3.11+,
Docker, uv, hadolint), build and development workflow, git hooks (prek),
Conventional Commits format, documentation pipeline (`docs-to-skills.py`),
and PR guidelines.

## Key Facts

- Lint: `make check` or `make lint`
- Test: `npm test` + `cd nemoclaw && npm test`
- Build docs: `make docs` or `make docs-live`
- Commit format: `<type>(<scope>): <description>` (Conventional Commits)
- Types: feat, fix, docs, chore, refactor, test, ci, perf
- Max open PRs: <10 per contributor
- No external project links — use only official docs
