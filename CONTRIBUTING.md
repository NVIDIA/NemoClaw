<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Contributing to NVIDIA NemoClaw

Thank you for your interest in contributing to NVIDIA NemoClaw. This guide covers how to set up your development environment, run tests, and submit changes.

All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Types of Contributions

We welcome many types of contributions:

| Contribution type | Description |
|---|---|
| **Bug reports** | Confirmed bugs with reproduction steps — see [Before You Open an Issue](#before-you-open-an-issue) |
| **Documentation fixes** | Typos, clarifications, and missing information in `docs/` |
| **Tests** | New or improved test coverage in `test/` or `nemoclaw/test/` |
| **Feature proposals** | Design-first proposals opened as issues before any implementation |
| **Integrations** | Support for new inference backends, providers, or tools |
| **Examples** | Worked usage examples added under `docs/` |

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) — **not** GitHub issues.

## Where to Start

New contributors should start with issues labeled [`good first issue`](https://github.com/NVIDIA/NemoClaw/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22). These are scoped tasks with clear acceptance criteria that do not require deep project knowledge.

Before starting larger work:

- Search open issues and pull requests to avoid duplicates.
- Start a [GitHub Discussion](https://github.com/NVIDIA/NemoClaw/discussions) before writing code for significant changes.
- Open an issue after the proposal has enough scope and design detail for maintainer review.
- For questions, open a [GitHub Discussion](https://github.com/NVIDIA/NemoClaw/discussions) or comment on a related issue.

Before editing, translate the request or issue into observable success criteria and define the intended change boundary.
State assumptions only when they materially affect behavior, security, compatibility, or a public contract.
If reasonable interpretations would produce meaningfully different outcomes, record the alternatives and tradeoffs and get alignment before implementation; use established local patterns for routine, reversible details.

Prefer the existing architecture and the smallest direct change that satisfies those criteria.
Do not introduce speculative features, configuration, extension points, or abstractions for possible future cases.
Add complexity only when the current requirement demonstrates that the simpler design is insufficient.

## Before You Open an Issue

Open an issue when you encounter one of the following situations.

- A real bug that you confirmed and could not fix.
- A feature proposal with a design — not a "please build this" request.
- Security vulnerabilities must follow [SECURITY.md](SECURITY.md) — **not** GitHub issues.

Use [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions) for questions, design exploration, and larger feature proposals before implementation.
Maintainers may ask you to move broad or still-forming proposals from an issue to a discussion so the design can settle before code review.

## Community Response Expectations

NemoClaw is an alpha project, and maintainer availability varies with release, security, and stability work.
Issues, discussions, and pull requests are reviewed on a best-effort basis.
The project does not publish guaranteed response or review timelines.

Maintainers prioritize work using severity, security impact, release readiness, reproducibility, maintainer capacity, and community impact.
For public roadmap context and current priorities, see [Current Priorities](README.md#current-priorities).
That section is a planning aid, not a commitment that a specific issue or feature will ship in a specific release.

## Prerequisites

Install the following before you begin.

- Node.js 22.16+ and npm 10+
- Python 3.11+ (for documentation tooling)
- Docker (running)
- [uv](https://docs.astral.sh/uv/) (for Python dependency management — install with `curl -LsSf https://astral.sh/uv/install.sh | sh`, or `brew install uv` on macOS)
- [hadolint](https://github.com/hadolint/hadolint) (Dockerfile linter — `brew install hadolint` on macOS)

## Getting Started

From the repository root, prepare the checkout with one command:

```bash
./scripts/dev-setup.sh
```

The setup command installs repository-local dependencies, synchronizes the root Python environment, builds and type-checks the CLI and plugin, and installs prek hooks.
It is safe to rerun and does not install host packages, change accounts or global Git configuration, accept licenses, manage credentials, or create a runtime sandbox.
Use `./scripts/dev-setup.sh --repair` to explicitly rerun the same repository-local repairs.

The command finishes with the read-only contributor doctor.
Follow each remediation it reports for host tools, Docker, GitHub authentication, contributor identity, or commit signing, then rerun `npm run dev:doctor` or `./scripts/dev-setup.sh --doctor`.
Reserve setup and `--repair` for repository-local dependency, build, or hook repair.
You can run the doctor independently in human-readable or JSON form:

```bash
npm run dev:doctor
./scripts/dev-setup.sh --doctor --json
```

Before your first commit, make sure the doctor reports a configured signing key and `commit.gpgsign=true`.
Every commit in a contributor PR must appear as `Verified` on GitHub, and the PR description must include your `Signed-off-by:` DCO declaration.

To drive the same workflow through a compatible coding agent, ask:

> Set up this machine as a NemoClaw contributor and prepare it for a first PR.

The `nemoclaw-contributor-onboard` skill invokes the setup script, pauses for user-controlled account or privileged changes, and explains the first-PR workflow.
Expose the development `nemoclaw` command only when you want an npm link or user-local shim:

```bash
./scripts/dev-setup.sh --expose-cli
```

When you specifically want the repository-pinned Pi coding agent, launch it with:

```bash
npm run agent
```

Do not install or invoke a global Pi binary.

Runtime onboarding is separate because many documentation and unit-test changes do not need a sandbox.
Run `./scripts/dev-setup.sh --with-runtime` only when the intended issue requires runtime validation.
That mode also opts into CLI exposure, then delegates to the interactive `nemoclaw onboard` workflow so you retain control of software acceptance, inference, credentials, sandbox resources, messaging, and network policy.

### Manual and Advanced Setup

Use these commands when troubleshooting an individual setup step:

```bash
npm install --include=dev --ignore-scripts
npm --prefix nemoclaw install --include=dev --ignore-scripts
uv sync --python /path/to/python3.11-or-newer --no-python-downloads
npm run build:cli
npm --prefix nemoclaw run build
npm run typecheck:cli
./nemoclaw/node_modules/.bin/tsc --noEmit -p nemoclaw/tsconfig.json
./node_modules/.bin/prek install
```

## Building

The TypeScript plugin lives in `nemoclaw/` and compiles with `tsc`:

```bash
cd nemoclaw
npm run build        # one-time compile
npm run dev          # watch mode
```

The CLI (`bin/`, `scripts/`) is type-checked separately:

```bash
npm run typecheck:cli   # or: npx tsc -p tsconfig.cli.json
```

### Local Development Testing

After building, return to the repository root and explicitly expose the development CLI through the setup helper.
If you followed the build step above, you are still inside `nemoclaw/` and must `cd ..` first:

```bash
cd ..                                   # back to the repo root
./scripts/dev-setup.sh --expose-cli
command -v nemoclaw                     # verify which executable is active
nemoclaw --version                      # verify the development CLI runs
```

The exposure command prefers `npm link` and falls back to a managed `~/.local/bin/nemoclaw` shim; follow any PATH guidance it prints. To remove an npm link when you are done, first verify the active executable with `command -v nemoclaw`, then run `npm unlink -g nemoclaw`.

## Main Tasks

These are the primary npm scripts for day-to-day development:

| Task | Purpose |
|------|---------|
| `npm run dev:setup` | Install or repair repository-local contributor tooling |
| `npm run dev:doctor` | Run read-only contributor environment readiness checks |
| `npm run agent` | Launch the repository-pinned Pi coding agent |
| `npm run check` | Run repo-wide pre-commit and full CLI/plugin coverage checks |
| `npm run check:diff` | Reproduce `pre-commit`, `commit-msg`, and `pre-push` checks for the diff from `origin/main` |
| `npm run format` | Auto-format Biome-supported source files |
| `npm run typecheck:cli` | Type-check the root TypeScript project using `tsconfig.cli.json` |
| `npm test` | Build package artifacts and run every non-live Vitest project for broad changes |
| `npm run test:spec` | Run every non-live test with hierarchical behavior-oriented output |
| `npm run test:fast` | Clean `dist/` and run source CLI, plugin, and E2E-support tests |
| `npm run test:integration` | Clean-build the CLI and run root integration and installer tests |
| `npm run test:package` | Clean-build CLI/plugin artifacts and run compiled-package contracts |
| `npm run test:live-e2e` | Opt into live E2E scenarios (mutates real external state) |
| [`npm run bench`](scripts/bench/README.md) | Run the advisory inference and trace-backed value benchmark |
| `cd nemoclaw && npm test` | Run plugin unit tests (Vitest) |
| `npm run docs` | Validate Fern documentation with the pinned Fern CLI version |
| `npm run docs:live` | Serve Fern docs locally with auto-rebuild |
| `npm run docs:preview:watch` | Publish branch-based Fern previews when docs files change |
| `npm run docs:deps` | Print the pinned Fern CLI version used by docs commands |

The `e2e-support` Vitest project is part of the aggregate checks for code-changing pull requests
and code-changing pushes to `main`. Run it directly when you change E2E fixtures, support helpers,
registries, or workflow boundary checks:

```bash
npx vitest run --project e2e-support
```

This project is fast and does not run live targets. Live E2E remains opt-in through
`npm run test:live-e2e` or the applicable GitHub Actions workflow.

### Test Titles as Behavioral Documentation

Write `describe` and `it` titles so the Vitest tree reads as behavioral documentation. Start test
titles with behavior or context rather than issue numbers, flags, or scenario labels, and put local
issue references in a final suffix such as `(#1234)`. Prefer
`it("reticulates splines correctly (#1234)")` over
`it("#1234 fixes spline reticulation")`.

Run `npm run test:spec` to render the suite with Vitest's hierarchical tree reporter. Run
`npm run test:titles:check` to enforce the objective title-shape conventions without attempting to
lint subjective English grammar.

### Git hooks (prek)

All git hooks are managed by [prek](https://prek.j178.dev/), a fast, single-binary pre-commit hook runner installed as a devDependency (`@j178/prek`). The `npm install` step runs `prek install` automatically via the `prepare` script, which wires up the following hooks from [`.pre-commit-config.yaml`](.pre-commit-config.yaml):

| Hook | What runs |
|------|-----------|
| **pre-commit** | Cheap structural and file-local checks, including fixers, formatters, linters, and skill frontmatter validation |
| **commit-msg** | commitlint (Conventional Commits) |
| **pre-push** | Path-scoped incremental CLI/plugin TypeScript checks and checked-JavaScript checks |

For PR preparation, normal `pre-commit`, `commit-msg`, and `pre-push` hooks are valid verification when they pass and were not bypassed with `--no-verify`.
If hooks were skipped, missing, failed, or uncertain, run `npm run check:diff` once to reproduce those checks for the diff from `origin/main`.
Refresh that remote-tracking base with `git fetch origin main` before relying on the fallback.

Pre-push selects the root TypeScript, checked-JavaScript, and plugin type checks from the paths changed relative to the push base, and uses incremental compilation for the TypeScript projects.
The `check:diff` fallback applies the same path selection, so do not rerun type checks separately solely to prepare a PR.
CI runs the complete type-check gates independently; local path selection is a fast-feedback optimization, not the authoritative trust boundary.

If you still have `core.hooksPath` set from an old Husky setup, Git will ignore `.git/hooks`. Run `git config --unset core.hooksPath` in this repo, then `npm install` so `prek install` (via `prepare`) can register the hooks.

`npm run check` is the whole-repository pre-commit and full CLI/plugin coverage baseline for broad changes to hooks, formatters, generated checks, or shared validation behavior.
It is not part of routine PR preparation for a focused change.

For doc-only changes, you do not need to run the full test suite by default.
Commit and push normally so the hooks run, then run the docs build:

```bash
npm run docs
```

Leave the broad-gate verification item unchecked unless you actually ran the applicable command.
If hooks were skipped or unavailable, run `npm run check:diff` before opening the PR.
For code changes, map each success criterion to the narrowest stable test or other evidence that proves it, then run those targeted checks once per relevant change set and record the commands as evidence.
Reproduce defects before fixing them when feasible; when reproduction is not feasible, record why and preserve the strongest available pre-fix evidence.
Add regression coverage at the earliest stable behavior boundary that could have caught the defect, and add higher-level coverage only when it protects a distinct integration boundary.
Include relevant negative and state-safety evidence when the acceptance criteria or risk require it.
Do not rerun targeted checks solely because hooks passed, but do rerun them after later edits or hook autofixes that can affect the tested behavior.
Reserve `npm test` for broad runtime changes, test harness changes, or cases where targeted coverage is hard to justify.
Reserve `npm run check` for repo-wide hook, formatter, generated-check, or coverage-baseline changes.

## Project Structure

The repository is organized as follows.

| Path | Purpose |
|------|---------|
| `nemoclaw/` | TypeScript plugin (Commander CLI, OpenClaw extension) |
| `nemoclaw-blueprint/` | Python blueprint for sandbox orchestration |
| `bin/` | CLI entry point (`nemoclaw.js`) |
| `scripts/` | Install helpers and automation scripts |
| `test/` | Root-level integration tests |
| `docs/` | User-facing documentation (Fern MDX plus legacy MyST source during migration) |
| `fern/` | Fern site configuration, theme, and assets |

## Language Policy

All new source files must be TypeScript. Do not add new `.js` files to the project. When modifying an existing JavaScript file, prefer migrating it to TypeScript in the same PR.

Only a small CommonJS launcher/compatibility layer remains in `bin/`, while the main CLI implementation now lives in `src/lib/` and compiles to `dist/`. Tests in `test/` may remain ESM JavaScript for now but new test files should use TypeScript where practical.

Shell scripts (`scripts/*.sh`) must pass ShellCheck and use `shfmt` formatting.

## Documentation

If your change affects user-facing behavior (new commands, changed defaults, new features, bug fixes that contradict existing docs), update the relevant pages under `docs/` in the same PR.

If you use an AI coding agent (Cursor, Claude Code, Codex, etc.), the repo includes the `nemoclaw-contributor-update-docs` skill that drafts doc updates. Use it before writing from scratch and follow the style guide in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
During release prep, run that skill first, make any doc version bumps, then open the docs refresh PR.

To build and preview docs locally:

```console
$ npm run docs                 # validate Fern docs with the pinned Fern CLI version
$ npm run docs:live            # serve Fern docs locally with auto-rebuild
$ npm run docs:preview:watch   # publish branch-based Fern previews on file changes
```

Use these npm scripts when validating docs for a PR.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full style guide and writing conventions.

### Markdown Docs for AI Agents

For Markdown docs routing, user-skill guidance, and release-prep documentation workflow, see [Markdown Docs for AI Agents](docs/CONTRIBUTING.md#markdown-docs-for-ai-agents).

## Pull Requests

We welcome contributions. Every PR requires maintainer review before merge. To keep the review queue healthy, limit the number of open PRs you have at any time to fewer than 10.
Maintainers review pull requests according to project priority, security impact, release readiness, and reviewer availability.
PRs that solve issues with Priority set to Urgent or High are more likely to receive earlier review when maintainers have capacity.
For substantial features or behavior changes, start with a GitHub Discussion before opening a large implementation PR.

Keep each pull request issue-scoped: every changed line should support the problem, its observable success criteria, or the evidence required to verify them.
Remove code made obsolete by the change, but keep drive-by refactoring, formatting, comment rewrites, and unrelated cleanup out of the diff.
Report unrelated debt separately, and disclose a necessary scope deviation before implementing it so reviewers can assess the tradeoff.

When QA finds a defect that escaped normal engineering controls, treat it as both a product failure and a detection gap.
In the issue or pull-request narrative, record the product root cause, why the existing implementation, tests, review, CI, environment, or diagnostics did not catch it, and the smallest durable prevention evidence.
Search adjacent code paths for the same failure class within a bounded scope; fix adjacent instances only when they share the root cause and fit the current change, otherwise report them separately.
Keep the analysis proportionate to the escaped defect and avoid assigning individual blame; ordinary defects do not require a heavyweight RCA.

### DCO Sign-Off

This project requires a [Developer Certificate of Origin (DCO)](https://developercertificate.org/) sign-off declaration in every pull request description.
Add the following trailer at the bottom of the PR description:

```text
Signed-off-by: Your Name <your.email@example.com>
```

CI will reject PRs whose descriptions are missing this declaration.

### Verified Commit Signatures

This project also requires every PR commit to appear as `Verified` in GitHub.
Configure your local Git client or GitHub web editor to create verified signed commits before you open a pull request.
Maintainers do not repair contributor signature failures.

Use GitHub's official documentation to set this up:

- [About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
- [Signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)

If the PR description is missing the DCO declaration, update the PR description before requesting review.
If any commit is missing GitHub verification, fix the branch before opening a PR.
If force-push is not allowed after an unverified commit is published, open a fresh branch and fresh PR with a clean compliant history.

> [!WARNING]
> Accounts that repeatedly exceed this limit or submit automated bulk PRs may have their PRs closed or their access restricted.

### No External Project Links

Do not add links to third-party code repositories, community collections, or unofficial resources in documentation, README files, or code. This includes "awesome lists," community template repositories, wrapper projects, and similar community-maintained resources — regardless of popularity or utility.

Links to official documentation for tools we depend on (e.g., Node.js, Python, uv) and industry standards (e.g., Conventional Commits) are acceptable.

**Why:** External repositories are outside our control. They can change ownership, inject malicious content, or misrepresent an endorsement by NVIDIA. Keeping references within our own repo avoids these risks entirely.

If you believe an external resource belongs in our docs, open an issue to discuss it with maintainers first.

### Submitting a Pull Request

Follow these steps to submit a pull request.

1. Create a feature branch from `main`.
2. Make your changes with tests.
3. Run the relevant checks.
   Run targeted tests once per relevant change set, let normal hooks provide verification, and run `npm run docs` for doc changes.
   Rerun targeted tests after later behavior-affecting edits or hook autofixes. If hooks were skipped or unavailable, run `npm run check:diff` once instead of reproducing the checks separately.
4. Confirm the PR description includes the DCO declaration and every commit appears as `Verified` in GitHub.
5. Open a PR.

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). All commit messages must follow the format:

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `chore` - Maintenance tasks (dependencies, build config)
- `refactor` - Code change that neither fixes a bug nor adds a feature
- `test` - Adding or updating tests
- `ci` - CI/CD changes
- `perf` - Performance improvements

**Examples:**

```text
feat(cli): add --profile flag to nemoclaw onboard
fix(blueprint): handle missing API key gracefully
docs: update quickstart for new install wizard
chore(deps): bump commander to 13.2
```
