<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Instructions

## Project Overview

NVIDIA NemoClaw is an open-source reference stack for running always-on AI agents such as [OpenClaw](https://openclaw.ai) and [Hermes](https://get-hermes.ai/) inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes more safely. It provides CLI tooling, a blueprint for sandbox orchestration, and security hardening.

Status: Active development. Interfaces may change without notice.

## Product Scope Gate

Technical correctness, passing tests, and green CI do not establish product approval.
Before implementing or approving a change that creates a supported integration, solution recipe, custom image, third-party stack, or other product surface, confirm that an accepted issue or design decision establishes the scope and that ownership, lifecycle, compatibility, security, and validation expectations are defined.
If the product decision is missing, do not approve or document the contribution as canonical NemoClaw behavior.
Stop and request maintainer direction, or route an independent solution through [Community Solutions](docs/resources/community-contributions.mdx).

## Agent Skills

This repo ships agent skills under `.agents/skills/`.
Use `nemoclaw-user-guide` for end-user documentation routing, `nemoclaw-contributor-*` for contributor workflows, and `nemoclaw-maintainer-*` for maintainer workflows.
The contributor lifecycle has one owner for each stage: `nemoclaw-contributor-onboard` for checkout setup, `nemoclaw-contributor-plan-issue` for planning, `nemoclaw-contributor-implement-issue` for implementation and its tests, and `nemoclaw-contributor-create-pr` for publication and review follow-up.
Component-specific guidance belongs in the `AGENTS.md` file of the package it describes, not in a skill.
Load the `nemoclaw-skills-guide` skill for a full catalog and quick decision guide mapping tasks to skills.
Skills that write or review explanatory text must follow the shared [Documentation Writing and Review](.agents/skills/_shared/documentation-writing-review.md) contract.

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

- Messaging architecture and channel migration guidance: [`src/lib/messaging/AGENTS.md`](src/lib/messaging/AGENTS.md)

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
| Auto-format added JavaScript and TypeScript files that Oxfmt does not exclude | `npm run format` |
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
- Deterministic projects clear mock calls, restore `vi.spyOn`, and undo `vi.stubEnv` and `vi.stubGlobal` before each test. Create those spies and stubs in `beforeEach` or the test body unless a documented import-time stub must run before module evaluation. Restore direct environment or global mutations yourself, and reset mock implementations explicitly when needed. Live E2E and automatic `mockReset` are intentionally excluded.
- Use `npm run test:changed` or `npm run test:watch` for focused CLI, plugin, and E2E-support feedback. Add only concrete opaque-input mappings to `test/helpers/vitest-watch-triggers.ts` when the import graph cannot see a YAML, Python, shell, generated, or workflow dependency.
- Use `npm run test:shuffle -- --sequence.seed=<seed>` to replay a printed test-order seed. Use `npm run test:diagnose:leaks` for async-resource or shutdown-hang diagnostics; both commands keep coverage disabled, and leak diagnostics can accompany exit code 0 when assertions pass.
- Write behavior-oriented titles, put local issue references in a final `(#1234)` suffix, and use `npm run test:spec` for the hierarchical specification view.
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

### Commit Messages

Conventional Commits required. Enforced by commitlint via prek `commit-msg` hook.

```text
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `perf`, `merge`

### SPDX Headers

Every source file must include an SPDX license header. The pre-commit hook auto-inserts them:

```javascript
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
```

For shell scripts use `#` comments. For Markdown use HTML comments.

### JavaScript

- `bin/` launcher and remaining `scripts/*.js`: **CommonJS** (`require`/`module.exports`), Node.js 22.19+
- `test/`: **ESM** (`import`/`export`)
- Oxlint uses `oxlint.config.ts`. The isolated `oxlint.type-aware.config.ts` configuration enforces `typescript/no-floating-promises` for plugin sources.

- Use `eslint-plugin-sonarjs` only for the `oxlint.config.ts` cognitive-complexity rules documented in [`tools/lint/DEPENDENCY-REVIEW.md`](tools/lint/DEPENDENCY-REVIEW.md).
- Keep function complexity low; existing complexity hotspots are tracked separately
- Unused vars pattern: prefix with `_`

### TypeScript

- Oxlint lints plugin code in `nemoclaw/src/`. Oxfmt formats added plugin files that it does not exclude.
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

## Working with This Repo

### Before Making Changes

1. Read `CONTRIBUTING.md` for the full contributor guide
2. Before coding, state what success looks like. Ask only when a choice changes behavior, security, data safety, or a supported contract. Then make the smallest change that works. For a QA-escaped defect, also add the test or diagnostic that should have caught it.
3. Apply the product scope gate above before implementing or approving a new supported surface
4. For a first-time checkout, use `.agents/skills/nemoclaw-contributor-onboard/SKILL.md` or run `npm run dev:setup`
5. Run `npm run dev:doctor` to verify the contributor environment without changing it
6. Use `./scripts/dev-setup.sh --expose-cli` only with explicit approval for host-visible CLI exposure
7. Run the tests targeted to the behavior you change once per relevant change set; rerun them after later edits or hook autofixes that can affect that behavior

### E2E Selection and Authoring

Use live E2E only for behavior that needs a real shell, installer, process,
Docker, OpenShell, `/proc`, sandbox, external service, or GitHub Actions
boundary. Put deterministic code, parser, registry, workflow-planner, and
fixture logic in unit, integration, package-contract, or `e2e-support` tests
instead. Do not add a live E2E target for a check that can be observed through a
stable local boundary.

Before adding or extending E2E coverage, name the semantic coverage dimension
that is missing. Existing migrated examples show the intended granularity:
catalogue targets pair environment, onboarding profile, expected state, optional
lifecycle, and `suiteIds`; `dashboard-remote-bind` owns install, onboard,
artifacts, and terminal cleanup; `credential-sanitization`,
`telegram-injection`, `messaging-providers`, `messaging-compatible-endpoint`,
and `gpu-e2e` are separate behavior contracts rather than one broad "full" run.
Extend matrix metadata only when it selects an already-defined behavior
dimension. Do not duplicate behavior logic in a second registry, workflow list,
or hand-maintained catalogue; use the typed registry and shared E2E workflow
planner documented in [`test/e2e/README.md`](test/e2e/README.md) and
[`test/e2e/docs/README.md`](test/e2e/docs/README.md).

If a gap is real but not ready for a test, record it as a combinatorial gap
instead of adding speculative coverage. State the missing dimension, the
existing nearest coverage, why a new test would duplicate or overreach current
behavior, and the issue or PR that will make it testable. A gap note must not
change release judgment by itself.

Assert outcomes, state, artifacts, and redacted diagnostics. Do not assert
incidental terminal output, progress wording, spinner frames, ANSI escape
sequences, timing text, or prompt layout unless that text is the product
contract under review. Terminal traces are evidence; they are not stable
behavior unless the issue explicitly makes them the behavior.

Retries require a checked-in bounded policy with a narrow transient signature,
owner, idempotence or reconciliation basis, attempt evidence, and an entry in
[`test/e2e/RETRY_INVENTORY.md`](test/e2e/RETRY_INVENTORY.md). Do not add
unproven retries, ambiguous mutation retries, or broad failed-job reruns. A
mutation retry is allowed only after the test reconciles the external state and
proves repeating the same desired operation is safe. Keep bounded operation
retries separate from complete workflow reruns: `E2E / Main Retry Evidence` records
attempts and does not request a broad rerun, while `Automation / Platform CI Runner` owns
at most one full rerun only for authenticated GitHub-hosted runner-loss
evidence.

### Plain Language and Direct Design

- Use existing repository vocabulary and name what a thing does.
- Remove modifiers that do not distinguish a real current case.
- Use one name for one concept across issues, code, workflows, checks, logs, tests, and docs.
- Follow the [NemoClaw Writing Guide](WRITING.md) for every agent response, progress update, tool-call label or description, text published on GitHub, and changed explanatory text.
  An agent must correct its text before it sends a message, publishes GitHub text, or starts a tool call with a visible label or description. The guide's review policy defines which findings can block changes to existing text.
- Use the [NemoClaw Controlled Word List](.agents/skills/_shared/controlled-words.md) for approved project terms and exact product names.
- Do not turn one case into a system of categories or a new abstraction.
- Do not add configuration, fallback, migration, compatibility, or extension layers without a current requirement. Name the current consumer and the test that protects the contract.
- Report conclusions and evidence, not an analysis transcript.
- Stop exploring once the smallest safe solution is clear.

### Git and GitHub Access Failures

Follow `.agents/skills/_shared/git-github-hard-stop.md`: if SSH, `gh`, authentication, authorization, remote access, or push permission fails, stop and ask the user instead of working around access. Do not stop for ordinary merge conflicts or dirty-worktree state; resolve mechanical conflicts in the relevant workflow and ask the user only when resolution would change behavior or contributor intent.

### Pull Request Follow-Up

Follow `.agents/skills/_shared/pr-follow-up.md`: after opening or pushing to a PR, monitor required CI and automated review comments, address valid CodeRabbit and PR Review Advisor findings, and consult the user when feedback is ambiguous or design-changing.

Reviewer routing is repository-owned.
Reviewer selection can come from these sources:

- `CODEOWNERS` loaded from the PR base SHA in `NVIDIA/NemoClaw`.
- Rulesets configured for `NVIDIA/NemoClaw`.
- NemoClaw workflow definitions loaded from the PR base SHA in `NVIDIA/NemoClaw`.
- NemoClaw skills loaded from the PR base SHA in `NVIDIA/NemoClaw`.

Before you use a reviewer-request write, confirm that one of these conditions is true:

- The current user names the exact reviewer.
- You loaded a NemoClaw workflow definition from the PR base SHA in `NVIDIA/NemoClaw`, and it requires the exact reviewer-request write.

Otherwise, do not use any of these reviewer-request writes:

- Add a reviewer.
- Remove a reviewer.
- Re-request a review.

GitHub can create an automatic review-request event when a contributor or agent pushes.
GitHub can attribute the event to the pushing account.
If the command trace contains no reviewer-request write, report the event as an automatic review-request event.

### Common Patterns

**Adding a CLI command:**

- Entry point: `bin/nemoclaw.js` (launches the compiled CLI in `dist/`)
- Main CLI implementation lives in `src/lib/` and compiles to `dist/lib/`
- Add tests in `test/`

**Adding a plugin feature:**

- Source: `nemoclaw/src/`
- Co-locate tests as `*.test.ts`
- Build with `cd nemoclaw && npm run build`

**Adding a network policy preset:**

- Add YAML to `nemoclaw-blueprint/policies/presets/`
- Follow existing preset structure (see `github.yaml`, `brave.yaml`)

**Adding model-specific sandbox compatibility:**

- Add a declarative manifest under `nemoclaw-blueprint/model-specific-setup/<agent>/`
- Use one `agent` per manifest (`openclaw`, `hermes`, etc.); do not make shared multi-agent manifests
- Put OpenClaw executable wrappers under `nemoclaw-blueprint/openclaw-plugins/`
- Put Hermes executable wrappers under `agents/hermes/`
- Keep `agents/hermes/generate-config.ts` as a thin build-time entrypoint; add Hermes env parsing, config construction, registry handling, and serialization under `agents/hermes/config/`
- Do not add Hermes behavior for an OpenClaw issue without a Hermes-specific repro or acceptance test

### Gotchas

- `npm install` at root triggers `prek install` which sets up git hooks. If hooks fail, check that `core.hooksPath` is unset: `git config --unset core.hooksPath`
- The `nemoclaw/` subdirectory has its own `package.json` and `node_modules`.
  It is a separate npm project that shares the root Oxlint and Oxfmt configuration files.
- SPDX headers are auto-inserted by pre-commit hooks; don't worry about adding them manually
- Coverage thresholds are ratcheted in `ci/coverage-threshold-*.json` — new code should not decrease CLI or plugin coverage
- The `.claude/skills` symlink points to `.agents/skills` — both paths resolve to the same content

## Documentation

- Treat `docs/` as the source of truth for public-facing documentation. Follow the [Documentation Agent Guide](docs/AGENTS.md) for the documentation-agent workflow, including DORI routing.
- Ordinary code PRs may defer only `docs/**`, `fern/docs.yml`, and `fern/assets/**` changes to `Docs / Post-Merge Catch-Up`.
  Keep all other owning repository guidance in the same PR, including active `AGENTS.md` files, `.agents/skills/**`, and `test/e2e/**/README.md`.
- Direct documentation-only changes follow `docs/AGENTS.md`, the shared [Documentation Writing and Review](.agents/skills/_shared/documentation-writing-review.md) contract, documented validation, and independent review.

## PR Requirements

- Create feature branch from `main`
- Let normal `pre-commit`, `commit-msg`, and `pre-push` hooks provide hook verification before submitting
- Contributor-owned PRs must self-serve the DCO declaration and GitHub commit verification before opening a PR
- Every contributor-owned PR description must include a valid `Signed-off-by:` declaration for the contributor, and every commit in the PR must appear as `Verified` in GitHub
- Contributor agents must stop before `gh pr create` if the PR body will not include the DCO declaration or any commit is missing GitHub verification; tell the contributor to fix the issue before opening a PR
- If force-push is not allowed and an already-published branch contains an unverified commit, require a fresh branch and fresh PR with a clean compliant history
- Run targeted tests once per relevant change set, rerunning after later behavior-affecting edits or hook autofixes, and run `npm run docs` for doc changes
- Count successful normal hooks as verification; if hooks were skipped or unavailable, refresh `origin/main` and use `npm run validate:pr`
- Direct PRs follow `.github/PULL_REQUEST_TEMPLATE.md`; the managed documentation workflow uses its generated body
- PRs that change `scripts/prepare-dgx-station-host.sh` must include reviewable DGX Station test evidence identifying the tested commit, Station profile or scenario, result, and a supporting link. Any maintainer may review the evidence; without acceptable evidence, the PR is not ready to approve or merge. Treat the evidence as human-reviewed, not authenticated hardware provenance. Exceptional bypasses use existing repository governance and must document the reason on the PR.
- No secrets, API keys, or credentials committed
- Check `.github/pr-limits.json` for the contributor's open PR limit.
