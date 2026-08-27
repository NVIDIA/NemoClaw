<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Contributing to NVIDIA NemoClaw

Thank you for contributing to NVIDIA NemoClaw. A contribution is ready for review when it makes
the smallest complete change, includes appropriate validation, and follows the pull request
template. Substantive product, architecture, security, integration, or supported-surface work also
requires an accepted scope decision.

All participants must follow our [Code of Conduct](CODE_OF_CONDUCT.md). Report security
vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Choose a Contribution Path

Start with an existing accepted issue when possible. New contributors can browse
[good first issues](https://github.com/NVIDIA/NemoClaw/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22).
Search open issues and pull requests before proposing new work.

Use the path that matches your contribution:

- **Bug or focused improvement:** Open an issue with observable behavior, reproduction evidence, and
  the desired outcome.
- **Larger feature or design:** Start a [GitHub Discussion](https://github.com/NVIDIA/NemoClaw/discussions)
  so the problem and design can settle before implementation.
- **Documentation correction:** Open a focused pull request and follow the
  [documentation contributor guide](docs/CONTRIBUTING.md).
- **Integration, recipe, custom image, or supported solution:** Confirm an accepted product decision
  before implementation. The [product scope gate](AGENTS.md#product-scope-gate) defines this
  requirement and the route for independent community solutions.

Before substantive work begins, a maintainer must record the decision, reason, placement, accountable
maintainer, and validation plan in the issue or linked discussion. Small documentation corrections
and low-risk fixes can proceed directly to a pull request.

Questions also belong in [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions) or on
a related issue.

NemoClaw is under active development. Maintainers review issues, discussions, and pull requests on a
best-effort basis; the project does not guarantee response or review times. See
[Current Priorities](README.md#current-priorities) for planning context, not a delivery commitment.

## Prepare Your Checkout

Install the prerequisites reported by the contributor doctor, then run the supported setup from the
repository root:

```bash
npm run dev:setup
npm run dev:doctor
```

The setup command installs repository-local dependencies, builds and type-checks the CLI and plugin,
and installs Git hooks. It does not install host packages, change accounts or global Git
configuration, accept licenses, create credentials, or create a runtime sandbox. The doctor reports
host, Docker, GitHub authentication, contributor identity, and commit-signing problems without
changing them. Follow its remediation and rerun the doctor until it
passes.

Use `./scripts/dev-setup.sh --with-runtime` only when the change needs runtime validation. Use
`./scripts/dev-setup.sh --expose-cli` only when you need a development `nemoclaw` command. Run
`npm run agent` to launch the repository-pinned coding agent.

The [setup script](scripts/dev-setup.sh) is the source of truth for setup modes. Contributors who use
a compatible coding agent can use the optional
[onboarding skill](.agents/skills/nemoclaw-contributor-onboard/SKILL.md). The
[agent instructions](AGENTS.md#quick-reference) provide a compact command index.

## Make the Change

Translate the accepted issue or proposed change into observable success criteria. Define the change
boundary and record assumptions that affect behavior, security, data safety, or a supported contract.
Get alignment when reasonable interpretations would produce different outcomes.

Keep every changed line within that boundary. Disclose a necessary scope deviation before making it,
and report unrelated debt separately. Then implement the smallest complete change. Follow the active `AGENTS.md` files and README files for every path you
change; the nearest file owns component-specific rules.

Use these guides to find the relevant contract:

| Work | Owning guidance |
|---|---|
| Repository architecture, code conventions, and product scope | [`AGENTS.md`](AGENTS.md) |
| Ordinary and package-contract tests | [`test/README.md`](test/README.md) |
| Live E2E selection, authoring, and evidence | [`test/e2e/README.md`](test/e2e/README.md) |
| E2E logs and artifacts | [`test/e2e/docs/README.md`](test/e2e/docs/README.md) |
| User documentation | [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) |
| Messaging architecture | [`src/lib/messaging/AGENTS.md`](src/lib/messaging/AGENTS.md) |
| Explanatory text and test titles | [`WRITING.md`](WRITING.md) |
| Available npm commands | [`package.json`](package.json) |
| Git-hook configuration | [`.pre-commit-config.yaml`](.pre-commit-config.yaml) |
| Blueprint image pins | [`AGENTS.md`](AGENTS.md#blueprint-image-pins) |

Do not copy detailed component rules into this guide. Update the owning guide when a change alters a
component contract.

## Validate the Change

Run the narrowest tests and checks that prove the outcome. The owning guides above define test
placement and specialized evidence. Common starting points are:

```bash
npm run test:changed
```

Normal Git hooks validate committed changes. If hooks were skipped or unavailable, commit the
changes, run `git fetch origin main`, then run `npm run validate:pr`. This command compares committed
changes with `origin/main`; it does not validate uncommitted changes.

Use the commands defined in [`package.json`](package.json) for component type-checking, builds,
documentation validation, or focused test projects. Use repository-wide validation only when the
change has repository-wide impact or targeted validation cannot prove the outcome:

- `npm test` runs every non-live test project.
- `npm run check` runs the repository-wide pre-commit and coverage baseline.

Most focused changes do not require both. Record only checks that actually ran and their results.

## Submit the Pull Request

Every pull request requires maintainer review. The applicable open-PR limit is defined in
[`.github/pr-limits.json`](.github/pr-limits.json); automation closes a pull request that exceeds it.

Do not add links to unofficial repositories, community collections, wrappers, or templates. Route
independent solutions through [Community Solutions](docs/resources/community-contributions.mdx).

Before publication:

1. Rebase or merge the current target branch as required by the repository workflow.
2. Run the applicable validation and keep the branch focused.
3. Use a Conventional Commit message and ensure each commit appears as `Verified` on GitHub.
4. Complete [the pull request template](.github/PULL_REQUEST_TEMPLATE.md), including the Developer
   Certificate of Origin declaration and completed validation evidence.
5. Confirm the diff contains no secrets, API keys, credentials, or unrelated changes.

Contributors must repair commit-signature failures. If a published unverified commit cannot be
replaced, create a compliant branch and pull request. GitHub documents
[commit verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
and [commit signing](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) is the source of truth for description
content and conditional evidence. The [contributor PR skill](.agents/skills/nemoclaw-contributor-create-pr/SKILL.md)
owns the automated publication and review-follow-up workflow. The root
[PR requirements](AGENTS.md#pr-requirements) own repository-specific exceptions.

After each revision, follow CI and review to completion. Address valid findings with a change, or
explain why they do not apply. Keep the PR description and validation evidence current.
