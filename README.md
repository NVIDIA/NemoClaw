<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw

NemoClaw’s SDK manages agent deployments from desired-state YAML.
The CLI delegates `plan`, `apply`, `export`, and `destroy` to the SDK.
OpenTofu owns graph execution and resource state.

The [design decision](docs/design/scope.md) defines implementation boundaries and invariants.
[Validation evidence and limits](docs/validation/README.md) identify tested configurations.

## Start Here

- [Understand NemoClaw](docs/overview.md).
- [Get started with v1](docs/get-started.md).
- [Build a native bundle](docs/build.md).
- [Configure and operate a deployment](docs/usage.md).
- [Move from an earlier version](docs/migration.md).
- [Use the SDK](docs/sdk.md).
- [Browse all documentation](docs/README.md).

## Contribute

Follow [AGENTS.md](AGENTS.md) for repository workflow and required checks.
Follow [WRITING.md](WRITING.md) for explanatory text and the [documentation contributor guide](docs/CONTRIBUTING.md) for documentation changes.

## Licenses

Original NemoClaw code uses [Apache-2.0](LICENSE).
The Qwen3.8 artifact includes AGPL-3.0-or-later recipe code and adaptations.
See [component attribution and license notices](runtimes/qwen38/NOTICE.md) for their scope and retained sources.
