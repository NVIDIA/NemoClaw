<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: OpenClaw

`AGENT=openclaw`, harness `nvidia.fabric.openclaw`, image target `openclaw`.
The adapter runs OpenClaw's gateway inside the sandbox; Fabric invocations reach it, and its own interfaces are the Control UI and an OpenAI-compatible chat endpoint.

## Proven Pairs

| Target | Inference source | Features | Revision | Date |
|---|---|---|---|---|
| dgx-spark | existing endpoint | all, including [openclaw-dashboard](../features/openclaw-dashboard.md) with the patched image | `691bf43c51` | 2026-10-30 |

## YAML Edits

For the [openclaw-dashboard](../features/openclaw-dashboard.md) feature, add to `spec.sandboxes.assistant`:

```yaml
serviceExposures:
  dashboard:
    targetPort: 43000
    authorizationMode: BEARER_PASSTHROUGH
harness:
  settings:
    port_range:
      start: 43000
      end: 43110
```

`port_range` spans exactly 111 ports, so the adapter binds OpenClaw's gateway to 43000, which the exposure targets.
Merge `settings` into the example's `harness`; keep its `kind` and `execution`.

## Readiness

[deploy-and-answer](../features/deploy-and-answer.md)'s request returns the reply in `result.output.response`.
The first request after apply can take about 30 seconds.

## Extra Features

- [openclaw-dashboard](../features/openclaw-dashboard.md): the Control UI and chat endpoint through a service exposure.
  It needs a patched image, built before writing the YAML, which replaces `IMAGE`.
  Cleanup removes it: `docker image rm "nc-fabric:openclaw-ui-$RUN"`.

## Known Gaps

- **Control UI off.** The pinned adapter writes `"controlUi": {"enabled": False}` with no setting ([NVIDIA/NeMo-Fabric#541](https://github.com/NVIDIA/NeMo-Fabric/issues/541), [#13360](https://github.com/NVIDIA/NemoClaw/issues/13360)); the dashboard feature patches one line.
- **Sign-in token.** The token lives only in the OpenClaw gateway process's environment, which `openshell sandbox exec` can't read ([#13973](https://github.com/NVIDIA/NemoClaw/issues/13973)); the dashboard feature reads it from the host's `/proc` with sudo.
- **Service URL.** Apply doesn't print it ([#13996](https://github.com/NVIDIA/NemoClaw/issues/13996)); read it with `openshell service list`.
