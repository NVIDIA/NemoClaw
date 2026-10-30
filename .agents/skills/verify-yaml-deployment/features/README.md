<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# YAML Deployment Feature Map

## Baseline Preconditions

- The [launch](../SKILL.md#launch) completed for this run with the chosen agent and target files, and the [doctor](../SKILL.md#doctor) passes.
- The inference source the target file chose answers its `/models` request.
- The OpenShell CLI matching `versions.json` on `PATH`, with `OPENSHELL_GATEWAY_ENDPOINT` and `OPENSHELL_WORKSPACE` set by the doctor.
- `jq` and `curl` on the host.

## Driving Conventions

- Use the shell variables the launch sets: `AGENT`, `TARGET`, `RUN`, `RUN_DIR`, `EVIDENCE`, `STATE`, `BUNDLE`, `UID_`, `WORKSPACE`, `GATEWAY_PORT`, `IMAGE`, `PROVIDER_KEY_ENV`, `SANDBOX_CONTAINER`, and the `nc` function.
- Drive through the author's entry points: the YAML file, the `nemoclaw` CLI, the OpenShell CLI, and the agent's own interfaces.
- Each prompt asks for an exact word unique to the step, so a reply can't come from an earlier turn.
- Read any interface credential into a shell variable just before a request and unset it after.

## Proof Rules

- A feature passes only on its observable result, saved in the named evidence file.
- Plan or apply success alone proves no reply; `Model and agent responses were not tested.` says so.
- A proof through one entry point doesn't cover the others the feature lists.
- A missing precondition fails the journey, with the reason in its `Gotchas`.
- A feature proven for one agent or target doesn't cover another; the agent file's proof table records each pair.

## Features

| File | Applies to | Feature |
|---|---|---|
| [deploy-and-answer.md](deploy-and-answer.md) | every agent | The agent answers one request through the declared inference |
| [export-reapply.md](export-reapply.md) | every agent | The deployment exports without secrets and reapplies with no changes |
| [exposure-change.md](exposure-change.md) | every agent | A changed service exposure replaces the sandbox and reaches the gateway |
| [openclaw-dashboard.md](openclaw-dashboard.md) | `openclaw` | The Control UI and chat endpoint through a service exposure |
