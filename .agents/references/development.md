<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Development Reference

Use this reference when changing source, tests, build tooling, or Git hooks.
It retains the repository architecture, conventions, and validation contracts.

## Architecture

| Path | Language | Purpose |
|------|----------|---------|
| `bin/` | JavaScript (CJS) | CLI launcher (`nemoclaw.js`) and small compatibility helpers |
| `src/lib/` | TypeScript | Core CLI logic: onboard, credentials, inference, policies, preflight, runner |
| `nemoclaw/` | TypeScript | Plugin registering `/nemoclaw` TUI slash commands inside OpenClaw; `openclaw nemoclaw <cmd>` shell subcommand path is descoped |
| `nemoclaw/src/blueprint/` | TypeScript | Runner, snapshot, SSRF validation, state management |
| `nemoclaw/src/commands/` | TypeScript | Slash commands, migration state |
| `nemoclaw/src/onboard/` | TypeScript | Onboarding config |
| `nemoclaw-blueprint/` | YAML | Blueprint definition and network policies |
| `nemoclaw-blueprint/model-specific-setup/` | JSON | Agent-scoped model/provider compatibility registry |
| `scripts/` | Bash/JS/TS | Install helpers, setup, automation, E2E tooling |
| `test/` | JavaScript/TypeScript (ESM) | Integration tests and explicit execution lanes (see `test/README.md`) |
| `test/e2e/` | Bash/JS/TS | End-to-end tests, target registry, and live runner (see `test/e2e/README.md`) |
| `docs/` | MDX/Markdown | User-facing Fern docs and Markdown routes for AI documentation clients |
| `fern/` | YAML/CSS/SVG | Fern site configuration and shared assets |

Package-specific guides:

- Messaging architecture and channel migration guidance: [`src/lib/messaging/AGENTS.md`](../../src/lib/messaging/AGENTS.md)

## Quick Reference

| Task | Command |
|------|---------|
| Set up contributor checkout | `npm run dev:setup` |
| Check contributor environment | `npm run dev:doctor` |
| Expose development CLI | `./scripts/dev-setup.sh --expose-cli` |
| Launch pinned coding agent | `npm run agent` |
| Build plugin | `cd nemoclaw && npm run build` |
| Watch mode | `cd nemoclaw && npm run dev` |
| Run all tests for broad changes | `npm test` |
| Render behavior-oriented test tree | `npm run test:spec` |
| Run fast source tests | `npm run test:fast` |
| Run tests affected by current changes | `npm run test:changed` |
| Watch focused source tests | `npm run test:watch` |
| Shuffle focused tests without coverage | `npm run test:shuffle` |
| Diagnose async leaks or shutdown hangs | `npm run test:diagnose:leaks` |
| Run integration tests | `npm run test:integration` |
| Run package contracts | `npm run test:package` |
| Run E2E support tests | `npx vitest run --project e2e-support` |
| Run live E2E targets | `npm run test:live-e2e` |
| Run plugin tests | `cd nemoclaw && npm test` |
| Validate a routine PR diff with `pre-commit`, `commit-msg`, and `pre-push` checks | `npm run validate:pr` |
| Run the narrow custom repository checks used by lint and hooks | `npm run checks:repository` |
| Run the broad repo-wide pre-commit and coverage baseline | `npm run check` |
| Type-check CLI | `npm run typecheck:cli` |
| Type-check plugin and plugin tests | `npm --prefix nemoclaw run typecheck` |
| Format maintained JavaScript and TypeScript files | `npm run format` |
| Build docs | `npm run docs` |
| Serve docs locally | `npm run docs:live` |

## Key Architecture Decisions

### Dual-Language Stack

- **CLI and plugin**: TypeScript (`src/`, `nemoclaw/src/`) with a small CommonJS launcher in `bin/`; ESM in `test/`
- **Blueprint**: YAML configuration (`nemoclaw-blueprint/`)
- **Docs**: Fern MDX for user-facing pages, with Markdown routes exposed by Fern for AI documentation clients
- **Tooling scripts**: Bash and Python

The `bin/` directory uses CommonJS intentionally for the launcher and a few compatibility helpers so the CLI still has a stable executable entry point. The main CLI implementation lives in `src/` and compiles to `dist/`. The `nemoclaw/` plugin uses TypeScript and requires compilation.

### Testing Strategy

Tests are organized into disjoint Vitest projects defined in `vitest.config.ts`:

1. **`cli`** — `src/**/*.test.ts` — CLI unit tests importing source
2. **`integration`** — `test/**/*.test.{js,ts}` — root integration tests importing source; excludes the explicit lanes below
3. **`installer-integration`** — `test/installer-integration/**/*.test.ts` — installer tests that spawn real `install.sh` processes
4. **`package-contract`** — `test/package-contract/**/*.test.ts` — the only non-live lane that imports compiled CLI/plugin artifacts
5. **`plugin`** — `nemoclaw/src/**/*.test.ts` — plugin unit tests co-located with source
6. **`e2e-support`** — fast tests for the E2E fixture/support layer; this project runs in the
   aggregate checks for code-changing PRs and code-changing pushes to `main`
7. **`e2e-live`** — opt-in live targets that mutate real external state

When writing tests:

- Tests under `test/` use ESM imports and follow the directory ownership rules in `test/README.md`.
- Plugin tests use TypeScript and are co-located with their source files
- Import CLI source from ordinary tests. Put genuine compiled-artifact assertions under `test/package-contract/`.
- Keep project globs disjoint and exhaustive; `npm run test:projects:check` compares filesystem candidates with Vitest and rejects missing, overlapping, or unexpected membership.
- Follow `test/README.md` for regression evidence, source-shape exceptions, assertion, cleanup, language, and title contracts.
- Use `npm run test:changed` or `npm run test:watch` for focused CLI, plugin, and E2E-support feedback. Add only concrete opaque-input mappings to `test/helpers/vitest-watch-triggers.ts` when the import graph cannot see a YAML, Python, shell, generated, or workflow dependency.
- Use `npm run test:shuffle -- --sequence.seed=<seed>` to replay a printed test-order seed. Use `npm run test:diagnose:leaks` for async-resource or shutdown-hang diagnostics; both commands keep coverage disabled, and leak diagnostics can accompany exit code 0 when assertions pass.
- Mock external dependencies; don't call real NVIDIA APIs in unit tests
- E2E tests run on ephemeral Brev cloud instances

### Security Model

NemoClaw isolates agents inside OpenShell sandboxes with:

- Network policies (`nemoclaw-blueprint/policies/`) controlling egress
- Credential sanitization to prevent leaks
- SSRF validation (`nemoclaw/src/blueprint/ssrf.ts`)
- Docker capability drops and process limits

Security-sensitive code paths require extra test coverage.

## Code Style and Conventions

### Repository metadata

Use Conventional Commit messages. The allowed types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `perf`, and `merge`.

Every source file needs the repository SPDX header; the pre-commit hook inserts it with the correct comment syntax.

### JavaScript

- `bin/` launcher and remaining `scripts/*.js`: **CommonJS** (`require`/`module.exports`), Node.js 22.19+
- `test/`: **ESM** (`import`/`export`)
- Do not add new JavaScript source files. Prefer TypeScript when modifying existing JavaScript. New test files must use TypeScript.
- Oxlint uses `oxlint.config.ts`. Correctness checks are errors; the configuration records rule families awaiting migration.
  Warnings and unused disable comments fail validation. Browser globals are limited to documentation components.
  The same configuration owns ordinary and type-aware rules. Adapter and plugin files run only in their type-aware pass.
  Type-aware checks discover `src/lib/adapters/tsconfig.json` and `nemoclaw/src/tsconfig.json`, which extend the CLI and plugin test projects.
  Adapter checks also reject misused promises, invalid awaits, and incomplete switches.
- Adapter sources and tests require type-only imports and exports, strict equality, and no unused variables or explicit `any`.
  Production adapters also reject non-null assertions and nested ternaries.
- Oxfmt covers all maintained JavaScript and TypeScript files. The formatting hook formats every changed source file.

- Use `eslint-plugin-sonarjs` only for the `oxlint.config.ts` cognitive-complexity rules documented in [`tools/lint/DEPENDENCY-REVIEW.md`](../../tools/lint/DEPENDENCY-REVIEW.md).
- Keep function complexity low; existing complexity hotspots are tracked separately
- Unused vars pattern: prefix with `_`

### TypeScript

- Oxlint lints plugin code in `nemoclaw/src/`. Oxfmt formats all maintained plugin source and test files.
- CLI type-checking via `tsconfig.cli.json`
- Plugin production and test type-checking via `npm --prefix nemoclaw run typecheck`, using
  `nemoclaw/tsconfig.json` and `nemoclaw/tsconfig.test.json`

### Shell Scripts

- ShellCheck enforced (`.shellcheckrc` at root)
- `shfmt` for formatting
- All scripts must have shebangs and be executable

### No External Project Links

Do not add links to third-party code repositories, community collections, or unofficial resources. Links to official tool documentation (Node.js and Python) are acceptable.

## Git Hooks (prek)

All hooks managed by [prek](https://prek.j178.dev/) (installed via `npm install`):

| Hook | What runs |
|------|-----------|
| **pre-commit** | Cheap structural and file-local checks, including fixers, formatters, and linters |
| **commit-msg** | commitlint (Conventional Commits) |
| **pre-push** | Path-scoped incremental CLI/plugin TypeScript checks and checked-JavaScript checks |

`npm run validate:pr` requires a clean committed tree and runs read-only formatting checks.
The repository-check runner reports durations and selects checks from changed paths, including deletions.
Compiler hooks share content-based local result reuse with explicit validation. Changed or unavailable
inputs require execution; reuse does not replace trusted validation or independent CI.
