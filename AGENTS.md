<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working in This Repository

Follow [WRITING.md](WRITING.md) for all prose, including messages and pull requests.

## Scope

- Deliver what was asked, at the intended scope; mention worthwhile additions in your report instead of making them.
- Keep working until the request is done; stop early only when you cannot proceed without the user or before an action that needs confirmation.

## Changes

- For behavior changes and bug fixes, write a behavioral test and observe it fail before implementing; the `test-driven-development` skill routes other work.
- Run `cargo ci` before pushing; `cargo test` alone skips the bundle lifecycle tests.
- Write tooling and tests in Rust; Python belongs only inside images whose workload runs on it.
- Pull requests are squash-merged: use a Conventional Commits title, and explain the failure, decision, and validation in the body.
- Add SPDX Apache-2.0 headers to new files.
  In copied or adapted code, keep the upstream notices and record the source revision and your changes.

## Shared and Irreversible Actions

- Never force-push.
- Preserve other worktrees and live resources; they may hold someone else's unfinished work or running deployments.
- Pushing to the pull request branch you are working on is fine.
  Ask before other actions that others see or that are hard to reverse: pushing to other branches, commenting on issues or pull requests, and changing or destroying deployments.
- Do not publish packages or images, and ask before changing system packages, drivers, or kernel settings.
