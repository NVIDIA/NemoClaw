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
| **Feature proposals** | Proposals that state the problem and desired behavior before implementation |
| **Integrations** | Support for new inference backends, providers, or tools |
| **Examples** | Product-supported examples under `docs/`, or independent solutions routed through [Community Solutions](docs/resources/community-contributions.mdx) |

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) — **not** GitHub issues.

## Where to Start

New contributors should start with issues labeled [`good first issue`](https://github.com/NVIDIA/NemoClaw/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22). These are scoped tasks with clear acceptance criteria that do not require deep project knowledge.

Before starting larger work:

- Search open issues and pull requests to avoid duplicates.
- Start a [GitHub Discussion](https://github.com/NVIDIA/NemoClaw/discussions) before writing code for significant changes.
- Open an issue after the problem, desired behavior, and current constraints are clear enough for maintainer review.
- For questions, open a [GitHub Discussion](https://github.com/NVIDIA/NemoClaw/discussions) or comment on a related issue.
- Confirm whether an integration, recipe, custom image, or end-to-end solution is an approved NemoClaw product surface or belongs in NemoClaw Community.

Before editing, translate the request or issue into observable success criteria and define the intended change boundary.
State assumptions only when they materially affect behavior, security, data safety, or a supported contract.
If reasonable interpretations would produce meaningfully different outcomes, record the alternatives and tradeoffs and get alignment before implementation; use established local patterns for routine, reversible details.

Prefer the existing architecture and the smallest direct change that satisfies those criteria.
Do not introduce speculative features, configuration, extension points, or abstractions for possible future cases.
Add complexity only when the current requirement demonstrates that the simpler design is insufficient.

## Plain Language and Direct Design

Use the shortest familiar term that accurately names the behavior. Prefer words already used by
users, the CLI, and nearby code. Every modifier must distinguish a real case in the current system;
if you cannot answer "as opposed to what?", remove it. Use one name for one concept across issues,
code, workflows, checks, logs, tests, and documentation.

Names shape designs. Do not create states, types, modules, configuration, adapters, aliases,
compatibility paths, or extension points merely to support a label or a possible future use. Add a
layer only when a current requirement, supported contract, repeated current behavior, or demonstrated
trust boundary makes the direct solution insufficient. When a current consumer requires a
compatibility path, name that consumer and protect the contract with a test.

Explain decisions and evidence, not the path taken to reach them. State the problem, the observable
outcome, the smallest change, and how it was verified. Explore alternatives only when they would
change behavior, security, data safety, or a supported contract. Once the smallest safe change is
clear and testable, stop exploring and implement it.

### Writing Guide

Follow the [NemoClaw Writing Guide](WRITING.md) when you add or modify explanatory text.
The guide defines its scope, terms, rules, examples, and review policy.

## Before You Open an Issue

Open an issue when you encounter one of the following situations.

- A real bug that you confirmed and could not fix.
- A feature proposal with a clear problem and desired behavior — not a "please build this" request.
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

- Node.js 22.19+ and npm 10+
- Python 3.11+ (for documentation tooling)
- Docker (running)
- [hadolint](https://github.com/hadolint/hadolint) (Dockerfile linter — `brew install hadolint` on macOS)

## Getting Started

From the repository root, prepare the checkout with one command:

```bash
./scripts/dev-setup.sh
```

The setup command installs repository-local dependencies, verifies the available Python interpreter, builds and type-checks the CLI and plugin, and installs prek hooks.
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
npm run build:cli
npm --prefix nemoclaw run build
npm run typecheck:cli
npm --prefix nemoclaw run typecheck
./node_modules/.bin/prek install
```

## Building

The TypeScript plugin lives in `nemoclaw/` and compiles with `tsc`:

```bash
cd nemoclaw
npm run build        # one-time compile
npm run dev          # watch mode
npm run typecheck    # type-check production and test sources without emitting
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
| `npm --prefix nemoclaw run typecheck` | Type-check plugin production and test sources without emitting files |
| `npm test` | Build package artifacts and run every non-live Vitest project for broad changes |
| `npm run test:spec` | Run every non-live test with hierarchical behavior-oriented output |
| `npm run test:fast` | Clean `dist/` and run source CLI, plugin, and E2E-support tests |
| `npm run test:changed` | Run tests affected by staged, unstaged, or untracked changes in the CLI, plugin, and E2E-support projects |
| `npm run test:watch` | Watch the CLI, plugin, and E2E-support projects and rerun affected tests |
| `npm run test:shuffle` | Shuffle test order in the focused source projects without collecting coverage |
| `npm run test:diagnose:leaks` | Report async-resource leaks and diagnose a Vitest process that hangs during shutdown |
| `npm run test:e2e-phases:check` | Validate semantic phase plans for every live E2E test and workflow-selected credential-free integration test without executing test bodies |
| `npm run test:runtime-audit -- <artifact-dir> [...]` | Rank captured live E2E runs by median, p95, variability, and slowest phase |
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

Every `e2e-live` test, plus every credential-free integration test selected by
the shared E2E workflow planner, must declare its ordered, behavior-specific
phase plan in `meta.e2ePhases`, call
`progress.phase("literal phase label")` at those boundaries, and reach the final
test-declared phase on every passing path. Live tests import the shared
`e2e-test` fixture, which appends `release registered E2E resources` so cleanup
duration and failures have their own phase. Workflow-selected integration tests
import `workflow-e2e-test` and declare their own final release phase. Run
`npm run test:e2e-phases:check` after changing either coverage set or its
workflow selection; collection validates the union without running test bodies. See
[`test/e2e/docs/README.md`](test/e2e/docs/README.md) for the logging and artifact
contract.

Use the shared `ShellProbe` for E2E child processes. The semantic-phase check
also follows shared E2E helpers and rejects new direct asynchronous process
boundaries unless they are explicitly audited for content-free activity and
timestamp-only output reporting. Synchronous process calls must have a positive
timeout shorter than the first heartbeat and use `killSignal: "SIGKILL"` so the
child cannot ignore that bound; write child contents only through the redacted
artifact sink. Pass the auto fixture's frozen, canonical `progress` capability
through unchanged; custom, copied, or no-op progress adapters are rejected at
audited subprocess boundaries.

### Test Declarative Behavior

Do not read a shipped YAML, JSON, manifest, workflow, or E2E runtime file only to assert its keys,
lists, or literal text. Schema tests should use small synthetic fixtures. Behavior tests should pass
the configuration through its consumer or validator and mutate important inputs to prove both the
accepted and rejected outcomes.

A direct read may remain only when it protects a security or compatibility trust boundary that
cannot be observed at a more stable boundary. Put this annotation immediately above that one test
and give the concrete reason:

```ts
// source-shape-contract: security -- Cross-field digest equality protects the shipped trust anchor
it("keeps both immutable image digests aligned", () => {
  // ...
});
```

`npm run source-shape:check` rejects unsupported categories, short or misplaced reasons, and any
exception whose file, test title, and category are not in the reviewed allowlist. It also
rejects unused allowlist entries, so one exception cannot silently replace another. Its output and
metrics list every accepted exception so these contracts remain visible during review.

### Focused Vitest Feedback

Use `npm run test:changed` for the staged, unstaged, and untracked changes in the current checkout,
or keep `npm run test:watch` running while editing. Both commands select only the source-backed
`cli`, `plugin`, and `e2e-support` projects. Watch mode also maps the repository's current opaque
YAML, Python, shell, generated, and workflow inputs to the concrete contract tests that read or
execute them outside Vitest's import graph. Add a narrow mapping in
`test/helpers/vitest-watch-triggers.ts` when a new opaque input needs the same treatment.

Use `npm run test:shuffle` to expose order dependencies in those focused projects. The command
shuffles tests within files and leaves coverage disabled. Vitest prints the chosen seed at the
start of the run. Replay that order by appending the printed value:

```bash
npm run test:shuffle -- --sequence.seed=6692
```

Use `npm run test:diagnose:leaks` when a test file leaves an async resource active or Vitest hangs
during shutdown. It enables Vitest's async-leak detector and hanging-process reporter while
keeping coverage disabled. This is a diagnostic command: inspect its leak output even when all
assertions pass, because reported async leaks do not independently change a successful test exit
code.

Vitest chooses the environment-appropriate reporter for ordinary local runs. In CI, console logs
from passing tests stay hidden while logs attached to failures are replayed; GitHub Actions still
receives test annotations.

### Test State Isolation

The `cli`, `integration`, `installer-integration`, `package-contract`, `plugin`, and `e2e-support`
projects clear mock call history, restore `vi.spyOn` descriptors, and undo `vi.stubEnv` and
`vi.stubGlobal` before each test.
Create those spies and stubs in `beforeEach` or the test body. A documented import-time stub may
remain at module scope when the imported module must capture it during evaluation.
These projects do not enable `mockReset`, and Vitest does not track direct `process.env` or global
assignments, so reset mock implementations and restore raw mutations in the test that owns them.
Live E2E projects do not enable this automatic cleanup because their stateful targets require
explicit, validated teardown.

Plugin tests also require each test to execute at least one Vitest `expect` assertion. This check
is scoped to the plugin project; root projects may continue using Node `assert` where that is the
existing contract.

### Test Titles as Behavioral Documentation

Write `describe` and `it` titles so the Vitest tree reads as behavioral documentation. Start test
titles with behavior or context rather than issue numbers, flags, or scenario labels, and put local
issue references in a final suffix such as `(#1234)`. Prefer
`it("reticulates splines for valid control points (#1234)")` over
`it("#1234 fixes spline reticulation")`.

Apply the [NemoClaw Writing Guide](WRITING.md) to each added or modified test title.
The title checker enforces objective title shape only. A language finding can block when ambiguity
changes the test meaning. Other findings are suggestions. Reviewers must not request unrelated title
cleanup.

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
Full coverage enforces the aggregate ratchets in `ci/coverage-threshold-*.json` and per-file floors
for security-sensitive SSRF, credential filtering and redaction, policy mutation, and state-lock
modules. CLI coverage shards defer the per-file checks until their reports are merged. Pull requests
also upload CLI and plugin Cobertura reports for advisory changed-file coverage feedback.

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
| `nemoclaw-blueprint/` | Blueprint definition and network policies |
| `bin/` | CLI entry point (`nemoclaw.js`) |
| `scripts/` | Install helpers and automation scripts |
| `test/` | Root-level integration tests |
| `docs/` | User-facing Fern MDX documentation |
| `fern/` | Fern site configuration, theme, and assets |

## Language Policy

All new source files must be TypeScript. Do not add new `.js` files to the project. When modifying an existing JavaScript file, prefer migrating it to TypeScript in the same PR.

Only a small CommonJS launcher/compatibility layer remains in `bin/`, while the main CLI implementation now lives in `src/lib/` and compiles to `dist/`. Tests in `test/` may remain ESM JavaScript for now but new test files should use TypeScript where practical.

Shell scripts (`scripts/*.sh`) must pass ShellCheck and use `shfmt` formatting.

## Documentation

If your change affects user-facing behavior (new commands, changed defaults, new features, bug fixes that contradict existing docs), update the relevant pages under `docs/` in the same PR.

If you use an AI coding agent (Cursor, Claude Code, Codex, etc.), the repo includes the `nemoclaw-contributor-update-docs` skill that drafts doc updates. Use it before writing from scratch and follow the style guide in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
During release prep, run that skill first, make any doc version bumps, then open the docs refresh PR.

### Documentation Writer Review Receipt

After you complete a code or documentation change, a documentation writer subagent must review the completed changes.
For a documentation-only change, the subagent must verify the changed pages against [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and [WRITING.md](WRITING.md).
The review must cover terminology, structure, voice, and code-sample presentation.
Complete the Documentation Writer Review section in the PR description after that review.
Keep one review completion checkbox and one instance of each visible or hidden field.

Record one result:

- `docs-updated` when the reviewed pull request changes documentation.
  List the changed documentation paths as evidence.
  For a documentation-only change, state that the subagent reviewed the writing rules and documentation style.
- `no-docs-needed` when a code change does not require documentation and the evidence explains why.
- `blocked` when a named decision, dependency, access problem, or input prevents the review.

Record the product and surface that ran the review, such as `Codex Desktop`, `Codex CLI`, `Claude Code`, or `Cursor`.
Use the same name for the same surface across PRs so the report groups its data correctly.

Commit all changes from the final review.
Then run these commands and put their values in the receipt's hidden HTML metadata comments:

```bash
git rev-parse --short HEAD
git rev-parse --short HEAD:AGENTS.md
```

GitHub supplies the pull-request identity to the workflow and report.
The hidden head SHA identifies the pull-request revision that the review covered.
Rerun the review after any new commit changes the pull-request head.
Pushing a new commit runs the receipt check again and reports the review as stale until the hidden metadata is refreshed.
The Documentation Writer Review check reports an advisory finding when the receipt is missing, incomplete, or stale.
The check compares the hidden head SHA with the current PR head and the hidden `AGENTS.md` blob SHA with the current PR's file.

Maintainers can export receipt data from PR descriptions:

```bash
npm run docs-review:report -- --since 2026-06-12 --format csv > /tmp/nemoclaw-docs-review.csv
```

The report uses the authenticated GitHub CLI session and returns JSON by default.
It measures receipt coverage, head-revision freshness, review results, and agent-surface counts.
The `eligiblePrs` JSON metric reports the total eligible pull requests.
The `eligibleCodePrs` and `eligibleDocsOnlyPrs` metrics report the code and documentation-only counts.
It records the `AGENTS.md` blob SHA, but only the PR check compares that SHA with the current PR's file.
It does not prove that an agent loaded `AGENTS.md`; it records observable workflow compliance.
The retrospective report classifies code and documentation changes from the checked Type of Change field.
It reports a PR as unclassified when that field is incomplete or contradictory.
Use `--format summary` to print only aggregate metrics.
Use `--until YYYY-MM-DD` to set the end of the reporting period.

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

### Product Scope Approval

Technical correctness and green CI are necessary, but they do not establish product approval.
A pull request must not define a new supported integration, solution workflow, custom image, third-party stack, or documentation surface without prior maintainer alignment on product scope.

Before opening or approving such a PR, confirm that an accepted issue or design decision defines the intended product behavior, ownership, compatibility and upgrade expectations, security review, lifecycle support, and validation boundary.
If that decision is missing, stop implementation or review and request maintainer direction.
Route independent solutions, complete use-case examples, and third-party integrations through [Community Solutions](docs/resources/community-contributions.mdx).

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

Links to official documentation for tools we depend on (e.g., Node.js and Python) and industry standards (e.g., Conventional Commits) are acceptable.

The project-owned NVIDIA NemoClaw Community repository is the designated destination for independent solutions.
Use the canonical [Community Solutions](docs/resources/community-contributions.mdx) page to route contributors there instead of adding direct repository links throughout the docs.

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
