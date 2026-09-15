<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw

NemoClaw’s experimental Rust SDK manages agent deployments from desired-state YAML.
The CLI delegates `plan`, `apply`, `export`, and `destroy` to the SDK.
OpenTofu owns graph execution and resource state.

This independent `v1` branch follows the [accepted experiment](DESIGN.md).
Project adoption remains a separate decision.
[Validation evidence and limits](docs/validation/README.md) identify tested configurations and the pinned Go comparison.

## Start Here

- [Build a native bundle](docs/build.md).
- [Configure and operate a deployment](docs/usage.md).
- [Use the SDK](docs/sdk.md).
- [Browse all documentation](docs/README.md).

## Contribute

Read [AGENTS.md](AGENTS.md) and [DESIGN.md](DESIGN.md) before implementation changes.
Follow [WRITING.md](WRITING.md) for explanatory text and the [documentation contributor guide](docs/CONTRIBUTING.md) for documentation changes.
[Run the workspace checks](docs/testing.md) before committing.
