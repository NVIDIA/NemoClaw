<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working in This Repository

Follow [WRITING.md](WRITING.md) for all prose, including messages and pull requests.

## Scope

- Deliver what was asked, at the intended scope; mention worthwhile additions in your report instead of making them.
- Keep working until the request is done; stop early only when you cannot proceed without the user or before an action that needs confirmation.

## Changes

- For behavior changes and bug fixes, write a behavioral test and observe it fail before implementing; the `test-driven-development` skill routes other work.
- Before pushing, run checks appropriate to the change; see [local validation](docs/contributing/testing.md#choose-local-validation). Use targeted checks for prose, declarative configuration, and isolated code changes; otherwise run `cargo ci`, which selects bundle and lifecycle checks from the changed inputs. When a change affects what runs in images or on Kubernetes, also run `cargo ci live-docker` or `cargo ci live-kind`.
- Rerun checks after merging the base branch. Commit regenerated schemas and fixtures with the change that alters them, and don't skip commit hooks.
- Report which checks ran and which were deferred to CI, with the reason. `cargo test` alone skips the bundle lifecycle tests.
- Make a slow test faster instead of raising its time budget.
- Leave each component's work to it. Before adding a check, workaround, patch, or reimplementation of another component's behavior, apply the [upstream boundaries](docs/design/scope.md#upstream-boundaries) questions, and stop to discuss when they point upstream.
- Write tooling and tests in Rust; Python belongs only inside images whose workload runs on it.
- Pull requests are squash-merged: use a Conventional Commits title and fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md), explaining the failure, decision, and validation. Post the authoring-session report as a separate collapsed comment even when its fields are unavailable. To create or update a PR, use [the PR creation skill](.agents/skills/nemoclaw-contributor-create-pr/SKILL.md).
- Stack dependent pull requests on their parent's branch. Pull requests into `v1` don't close issues; close the issues they resolve after merge.
- File deferred work as `v1` issues, and reference real issue numbers, never placeholders.
- Add SPDX Apache-2.0 headers to new files.
  In copied or adapted code, keep the upstream notices and record the source revision and your changes.

## Shared and Irreversible Actions

- Never force-push.
- Preserve other branches, worktrees, and live resources, and delete only those you created; they may hold someone else's unfinished work or running deployments.
- Pushing to the pull request branch you are working on is fine after confirming the pull request is still open.
  Ask before other actions that others see or that are hard to reverse: pushing to other branches, commenting on issues or pull requests, and changing or destroying deployments.
- Do not publish packages or images, and ask before changing system packages, drivers, or kernel settings.
