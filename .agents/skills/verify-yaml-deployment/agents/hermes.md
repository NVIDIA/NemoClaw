<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: Hermes

`AGENT=hermes`, harness `nvidia.fabric.hermes`, image target `hermes`.
The pinned adapter embeds Hermes in the adapter process, so Fabric invocations are its only interface.

## Proven Pairs

| Target | Inference source | Features | Revision | Date |
|---|---|---|---|---|
| dgx-spark | existing endpoint | deploy-and-answer, export-reapply, exposure-change | `691bf43c51` | 2026-10-30 |

## YAML Edits

None beyond the skill's and the target's.
The adapter's settings are `max_tokens`, `plugins_enabled`, `reasoning_config`, `save_trajectories`, and `terminal_timeout`; check the image's catalog label before relying on others:

```sh
docker image inspect "nc-fabric:hermes" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' | jq -r '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.hermes") | .descriptor.settings_schema.properties | keys[]'
```

## Readiness

[deploy-and-answer](../features/deploy-and-answer.md)'s request returns the reply in `result.output.response`.

## Extra Features

None yet.

## Known Gaps

- **No native interfaces.** Hermes's API server, dashboard, and browser chat need a service shape in Fabric's Hermes adapter ([NVIDIA/NeMo-Fabric#540](https://github.com/NVIDIA/NeMo-Fabric/issues/540), [#13969](https://github.com/NVIDIA/NemoClaw/issues/13969)). The image already carries their assets (#13971); add a feature here when the adapter serves them.
- **Service exposures.** With no listener in the sandbox, [exposure-change](../features/exposure-change.md) checks only that the gateway records the exposure; nothing answers at its URL.
