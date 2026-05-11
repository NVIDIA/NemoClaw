<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Setup helpers

Scenario-setup dispatchers. Each file owns one setup dimension. The runner
(`run-scenario.sh`) sources the dispatcher and calls the dimension-level
entry point; the dispatcher routes by the profile id from `scenarios.yaml`.

| File | Dimension | Entry point | Routes by |
|---|---|---|---|
| `install.sh` | install method | `e2e_install` | `install.method` (e.g. `repo-checkout`, `curl-install-script`, `brev-launchable`) |
| `onboard.sh` | onboarding path | `e2e_onboard` | `onboarding.agent` + `onboarding.provider` (e.g. `cloud-openclaw`, `cloud-hermes`, `local-ollama-openclaw`) |

All setup helpers honour `E2E_DRY_RUN=1` (short-circuit with a trace line)
and write canonical context keys to `$E2E_CONTEXT_DIR/context.env` via
`lib/context.sh`.

Reuses the existing shell helpers rather than duplicating them:

- `install.sh` sources `lib/install-path-refresh.sh`
- `cleanup.sh` (sibling at `lib/`) sources `lib/sandbox-teardown.sh`
