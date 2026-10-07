<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working in This Repository

Follow [WRITING.md](WRITING.md) for all prose, including messages and pull requests.

- Write a behavioral test and observe it fail before implementing.
- Run `cargo ci` before pushing; `cargo test` alone skips the bundle lifecycle tests.
- Write tooling and tests in Rust; Python belongs only inside images whose workload runs on it.
- Never force-push.
- Pull requests are squash-merged: use a Conventional Commits title, and explain the failure, decision, and validation in the body.
- Add SPDX Apache-2.0 headers to new files.
  In copied or adapted code, keep the upstream notices and record the source revision and your changes.
- Preserve other worktrees and live resources.
- Do not publish packages or images, and ask before changing system packages, drivers, or kernel settings.
