<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: Hermes

`AGENT=hermes`, harness `nvidia.fabric.hermes`, image target `hermes`.
The adapter runs Hermes in the sandbox, keeps its state across runtimes in `/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/assistant`, and can serve its API server and dashboard.

## Proven Pairs

| Target | Inference source | Features | Revision | Date |
|---|---|---|---|---|
| dgx-spark | existing endpoint | deploy-and-answer, export-reapply, exposure-change, [hermes-interfaces](../features/hermes-interfaces.md) | `b5489e5768` | 2026-11-04 |

## YAML Edits

For the [hermes-interfaces](../features/hermes-interfaces.md) feature, add to `spec.sandboxes.assistant.harness`:

```yaml
settings:
  interfaces:
    api:
      port: 8642
    dashboard:
      port: 9119
```

Merge `settings` into the example's `harness`; keep its `kind` and `execution`.
Declare no service exposure: with none, [exposure-change](../features/exposure-change.md) adds a `probe` exposure instead of switching a mode.
Check the image's adapter declares the interfaces before relying on them:

```sh
docker image inspect "nc-fabric:hermes" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' | jq -c '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.hermes") | .descriptor.settings_schema.properties.interfaces.properties | keys'
```

Result: `["api","dashboard"]`.

## Readiness

[deploy-and-answer](../features/deploy-and-answer.md)'s request returns the reply in `result.output.response`.

## Extra Features

- [hermes-interfaces](../features/hermes-interfaces.md): the API server and dashboard through `openshell forward service`.

## Known Gaps

- **Dashboard without sign-in.** Anyone who reaches its forward can use it, including browser chat without approvals ([docs/agents-inference/interfaces.md](../../../../docs/agents-inference/interfaces.md#who-can-use-an-interface)).
- **Interface failures stay silent.** A Hermes interface process that exits leaves the agent running and plan unchanged until the next runtime start.
