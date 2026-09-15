<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working in This Repository

NemoClaw provides the desired-state SDK and its CLI and OpenTofu provider consumers.
Read the [accepted scope](docs/design/scope.md) before changing boundaries.

Write a behavioral test, observe it fail, implement the behavior, and run the focused tests before committing.
Keep commits green and small; explain the failure, decision, and validation in commit bodies.
Do not maintain a journal.

Use Conventional Commits.
Use SPDX Apache-2.0 headers for original NemoClaw code.
Preserve upstream copyright and license notices in copied, adapted, translated, and generated code.
Do not replace an upstream license with the repository default.
Record the upstream source revision and dated modifications beside derived code; see [Qwen3.8 notices](runtimes/qwen38/NOTICE.md).
Run `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` for the implemented workspace.

Preserve other worktrees and live resources.
Push to `origin/v1`; never force-push.
Do not publish packages or images.

Live tests require explicit configuration and must touch only their owned resources.
Ask before changing system packages, drivers, or kernel settings.

## Documentation

Follow [WRITING.md](WRITING.md) for explanatory text.
Use [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for page ownership, structure, and documentation validation.
