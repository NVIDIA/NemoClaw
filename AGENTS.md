<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working in This Repository

NemoClaw provides the desired-state SDK and its CLI and OpenTofu provider consumers.
Read the [accepted scope](docs/design/scope.md) before changing boundaries.

## Make a Change

1. Write a behavioral test, observe it fail, implement the behavior, and rerun the focused tests.
2. Run `cargo ci` before pushing; it runs this platform's `CI / Native` steps, including the bundle lifecycle tests that `cargo test` skips.
   Image changes also need the [image source checks](docs/testing.md#image-source-checks).
3. Push a branch to `origin`, open a pull request against `v1`, and merge only after CI passes.
   Never force-push.

Pull requests are squash-merged, so the PR title and body become the commit message.
Keep each pull request small, give it a Conventional Commits title, and explain the failure, decision, and validation in its body.
Do not maintain a progress journal; commit messages carry that history.

## Licensing

- Add SPDX Apache-2.0 headers to original NemoClaw code.
- Preserve upstream copyright and license notices in copied, adapted, translated, and generated code; do not replace them with the repository default.
- Record the upstream source revision and dated modifications beside derived code, as in the [Qwen3.8 notices](runtimes/qwen38/NOTICE.md).

## Resources and Safety

- Preserve other worktrees and live resources.
- Run live tests only with explicit configuration, and touch only the resources they own.
- Do not publish packages or images.
- Ask before changing system packages, drivers, or kernel settings.

## Documentation

Follow [WRITING.md](WRITING.md) for explanatory text and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for page ownership, structure, and validation.
