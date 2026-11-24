<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding

This crate implements the terminal wizard for `nemoclaw onboard`.
For the installed CLI, follow [Authoring Deployment YAML With Onboarding](../../docs/get-started/onboard.md).

## Running From Source

With the [build prerequisites](../../docs/build-deploy/build.md) installed, run the CLI from the repository root to exercise onboarding with target checks:

```sh
cargo run -p nemoclaw-cli -- onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

Run the standalone example to exercise the same questionnaire without reading the target:

```sh
cargo run -p nemoclaw-onboarding -- examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

Both commands require a new output path.

## Design and Backlog

The [authoring domain model](../../internal-docs/design/authoring-domain.md) and [onboarding journeys](../../internal-docs/design/onboarding-journeys.md) define how questions are resolved, when **Ctrl+D** can accept suggestions, and what review requires before saving.
Journeys onboarding does not offer yet are recorded in [`unsupported_onboarding_journeys.rs`](../nemoclaw-authoring/tests/unsupported_onboarding_journeys.rs).
