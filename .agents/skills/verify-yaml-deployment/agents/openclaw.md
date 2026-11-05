<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: OpenClaw

`AGENT=openclaw`, harness `nvidia.fabric.openclaw`, image target `openclaw`.
The adapter runs OpenClaw's gateway inside the sandbox; Fabric invocations reach it, and it can serve the Control UI with browser chat.

## Proven Pairs

| Target | Inference source | Features | Revision | Date |
|---|---|---|---|---|
| dgx-spark | existing endpoint | deploy-and-answer, export-reapply, exposure-change, [openclaw-dashboard](../features/openclaw-dashboard.md) | `b5489e5768` | 2026-11-04 |

## YAML Edits

For the [openclaw-dashboard](../features/openclaw-dashboard.md) feature, add to `spec.sandboxes.assistant`:

```yaml
serviceExposures:
  dashboard:
    targetPort: 43000
    authorizationMode: BEARER_PASSTHROUGH
harness:
  settings:
    interfaces:
      dashboard:
        port: 43000
```

Merge `settings` into the example's `harness`; keep its `kind` and `execution`.
The interface's `port` and the exposure's `targetPort` must match.
Check the image's adapter declares the interface before relying on it:

```sh
docker image inspect "nc-fabric:openclaw" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' | jq -c '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.openclaw") | .descriptor.settings_schema.properties.interfaces.properties | keys'
```

Result: `["dashboard"]`.

## Readiness

[deploy-and-answer](../features/deploy-and-answer.md)'s request returns the reply in `result.output.response`.
The first request after apply can take about 30 seconds.

## Extra Features

- [openclaw-dashboard](../features/openclaw-dashboard.md): the Control UI through a service exposure with curl, and in a browser through `openshell forward service`.

## Known Gaps

- **The agent can sign in to itself.** The agent's own tools can read the token file and reach the port ([docs/agents-inference/interfaces.md](../../../../docs/agents-inference/interfaces.md#who-can-use-an-interface)).
- **Origins.** The adapter accepts only loopback browser origins ([NVIDIA/NeMo-Fabric#573](https://github.com/NVIDIA/NeMo-Fabric/pull/573)), so a browser can sign in through the forward but not at the exposure's URL.
