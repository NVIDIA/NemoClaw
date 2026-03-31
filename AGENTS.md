# AGENTS.md

## Project Context

NVIDIA NemoClaw runs OpenClaw AI assistants inside hardened OpenShell sandboxes with NVIDIA Nemotron inference. This file provides agent-specific guidance for working on this codebase.

## Quick Reference

| Task | Command |
|------|---------|
| Install all deps | `npm install && cd nemoclaw && npm install && npm run build && cd .. && cd nemoclaw-blueprint && uv sync && cd ..` |
| Run all tests | `npm test` |
| Run plugin tests | `cd nemoclaw && npm test` |
| Run all linters | `make check` |
| Type-check CLI | `npm run typecheck:cli` |
| Build plugin | `cd nemoclaw && npm run build` |
| Build docs | `make docs` |

## Key Architecture Decisions

### Dual-Language Stack

- **CLI and plugin**: JavaScript (CJS in `bin/`, ESM in `test/`) and TypeScript (`nemoclaw/src/`)
- **Blueprint**: YAML configuration (`nemoclaw-blueprint/`)
- **Docs**: Sphinx/MyST Markdown
- **Tooling scripts**: Bash and Python

The `bin/` directory uses CommonJS intentionally — it's the CLI entry point that must work without a build step. The `nemoclaw/` plugin uses TypeScript and requires compilation.

### Testing Strategy

Tests are organized into three Vitest projects defined in `vitest.config.ts`:

1. **`cli`** — `test/**/*.test.{js,ts}` — integration tests for CLI behavior
2. **`plugin`** — `nemoclaw/src/**/*.test.ts` — unit tests co-located with source
3. **`e2e-brev`** — `test/e2e/brev-e2e.test.js` — cloud E2E (requires `BREV_API_TOKEN`)

When writing tests:

- Root-level tests (`test/`) use ESM imports
- Plugin tests use TypeScript and are co-located with their source files
- Mock external dependencies; don't call real NVIDIA APIs in unit tests
- E2E tests run on ephemeral Brev cloud instances

### Security Model

NemoClaw isolates agents inside OpenShell sandboxes with:

- Network policies (`nemoclaw-blueprint/policies/`) controlling egress
- Credential sanitization to prevent leaks
- SSRF validation (`nemoclaw/src/blueprint/ssrf.ts`)
- Docker capability drops and process limits

Security-sensitive code paths require extra test coverage.

## Working with This Repo

### Before Making Changes

1. Read `CONTRIBUTING.md` for the full contributor guide
2. Run `make check` to verify your environment is set up correctly
3. Check that `npm test` passes before starting

### Common Patterns

**Adding a CLI command:**

- Entry point: `bin/nemoclaw.js` (routes to `bin/lib/` modules)
- Keep `bin/lib/` modules as CommonJS
- Add tests in `test/`

**Adding a plugin feature:**

- Source: `nemoclaw/src/`
- Co-locate tests as `*.test.ts`
- Build with `cd nemoclaw && npm run build`

**Adding a network policy preset:**

- Add YAML to `nemoclaw-blueprint/policies/presets/`
- Follow existing preset structure (see `slack.yaml`, `discord.yaml`)

**Updating docs:**

- Edit under `docs/` (never `.agents/skills/docs/`)
- Regenerate skills: `python scripts/docs-to-skills.py docs/ .agents/skills/docs/ --prefix nemoclaw`
- Preview: `make docs-live`

### Gotchas

- `npm install` at root triggers `prek install` which sets up git hooks. If hooks fail, check that `core.hooksPath` is unset: `git config --unset core.hooksPath`
- The `nemoclaw/` subdirectory has its own `package.json`, `node_modules/`, and ESLint config — it's a separate npm project
- SPDX headers are auto-inserted by pre-commit hooks; don't worry about adding them manually
- Coverage thresholds are ratcheted in `ci/coverage-threshold-*.json` — new code should not decrease CLI or plugin coverage
- The `.claude/skills` symlink points to `.agents/skills` — both paths resolve to the same content
