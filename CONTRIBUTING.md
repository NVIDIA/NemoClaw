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
- Python 3.11+ (for blueprint and documentation builds)
- Docker (running)
- [uv](https://docs.astral.sh/uv/) (for Python dependency management)
- [hadolint](https://github.com/hadolint/hadolint) (Dockerfile linter — `brew install hadolint` on macOS)

## Getting Started

Install the root dependencies and build the TypeScript plugin:

```bash
# Install root dependencies (OpenClaw + CLI entry point)
npm install

# Install and build the TypeScript plugin
cd nemoclaw && npm install && npm run build && cd ..

# Install Python deps for the blueprint
cd nemoclaw-blueprint && uv sync && cd ..
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

After building, return to the repository root and link the CLI so the `nemoclaw` command is available locally.
If you followed the build step above, you are still inside `nemoclaw/` and must `cd ..` first:

```bash
cd ..                   # back to the repo root (from nemoclaw/ subdirectory)
npm link
nemoclaw --version      # verify the linked version
```

To unlink when you are done: `npm unlink -g nemoclaw`

## Main Tasks

These are the primary `make` and `npm` targets for day-to-day development:

| Task | Purpose |
|------|---------|
| `make check` | Run all linters (TypeScript + Python) |
| `make lint` | Same as `make check` |
| `make format` | Auto-format TypeScript and Python source |
| `npm run typecheck:cli` | Type-check CLI TypeScript using `tsconfig.cli.json` (`bin/`, `scripts/`, `src/`, `test/`, `nemoclaw-blueprint/scripts/`) |
| `npm test` | Run root-level tests (`test/*.test.js`) |
| `cd nemoclaw && npm test` | Run plugin unit tests (Vitest) |
| `npm run docs` | Validate Fern documentation with the pinned Fern CLI version |
| `npm run docs:live` | Serve Fern docs locally with auto-rebuild |
| `npm run docs:preview:watch` | Publish branch-based Fern previews when docs files change |
| `npm run docs:deps` | Print the pinned Fern CLI version used by docs commands |
| `npx prek run --all-files` | Run all hooks from `.pre-commit-config.yaml` — see below |

### Git hooks (prek)

All git hooks are managed by [prek](https://prek.j178.dev/), a fast, single-binary pre-commit hook runner installed as a devDependency (`@j178/prek`). The `npm install` step runs `prek install` automatically via the `prepare` script, which wires up the following hooks from [`.pre-commit-config.yaml`](.pre-commit-config.yaml):

| Hook | What runs |
|------|-----------|
| **pre-commit** | File fixers, formatters, linters, docs-to-skills dry-run validation, Vitest (plugin) |
| **commit-msg** | commitlint (Conventional Commits) |
| **pre-push** | TypeScript type check (`tsc --noEmit` for plugin, JS, and CLI) |

For a full manual check: `npx prek run --all-files`. For scoped runs: `npx prek run --from-ref <base> --to-ref HEAD`.

For TypeScript changes under `src/`, `test/`, `scripts/`, `bin/`, or
`nemoclaw-blueprint/scripts/` (and for `tsconfig.cli.json` updates), also run
`npm run typecheck:cli` before opening a PR. CI runs this unconditionally, and the
pre-push hook runs it with `tsconfig.cli.json` before pushes.

If you still have `core.hooksPath` set from an old Husky setup, Git will ignore `.git/hooks`. Run `git config --unset core.hooksPath` in this repo, then `npm install` so `prek install` (via `prepare`) can register the hooks.

`make check` remains the primary documented linter entry point.

For doc-only changes, you do not need to run the full test suite by default.
Run the docs and hook checks instead:

```bash
npx prek run --all-files
npm run docs
```

Leave `npm test` unchecked in the PR verification checklist unless you actually ran it.
Run `npm test` when the change touches code, generated behavior, or anything that affects runtime behavior.

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
During release prep, run that skill first, make any doc version bumps, regenerate user skills, then open the docs refresh PR.

To build and preview docs locally:

```console
$ npm run docs                 # validate Fern docs with the pinned Fern CLI version
$ npm run docs:live            # serve Fern docs locally with auto-rebuild
$ npm run docs:preview:watch   # publish branch-based Fern previews on file changes
```

Use these npm scripts when validating docs for a PR.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full style guide and writing conventions.

### Doc-to-Skills Pipeline

For user-skill definitions, docs-to-skills validation, release-prep regeneration, and script flags, see [Doc-to-Skills Pipeline](docs/CONTRIBUTING.md#doc-to-skills-pipeline).

## Pull Requests

We welcome contributions. Every PR requires maintainer review before merge. To keep the review queue healthy, limit the number of open PRs you have at any time to fewer than 10.
Maintainers review pull requests according to project priority, security impact, release readiness, and reviewer availability.
PRs that solve issues with Priority set to Urgent or High are more likely to receive earlier review when maintainers have capacity.
For substantial features or behavior changes, start with a GitHub Discussion before opening a large implementation PR.

### DCO Sign-Off

This project requires a [Developer Certificate of Origin (DCO)](https://developercertificate.org/) sign-off on every commit. Add the following trailer to each commit message:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit -s` to add the sign-off automatically. CI will reject commits that are missing it.

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
3. Run the relevant checks. For code changes, run `make check` and `npm test`. For doc-only changes, run `npx prek run --all-files` and `npm run docs`.
4. Open a PR.

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
