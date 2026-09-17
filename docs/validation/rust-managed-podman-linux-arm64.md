<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Podman TLS and Lifecycle Qualification

Recorded on 2026-09-17 on Linux ARM64, kernel `6.17.0-1014-nvidia`, on one DGX Spark.
The tested runtime behavior is in NemoClaw `d5cdc50544` (OpenShell pin) and `fecaf60d2e` (managed Podman).
The initial Podman bundle was `0.1.0-dev.e5249ce77bc97c09`.
After rebasing onto `origin/v1` at `c520b615fd`, bundle `0.1.0-dev.19994fefebe6f576` passed the full Podman lifecycle, minimal TLS reproduction, and hosted OpenClaw upgrade gate again.
Fabric remained pinned to `6e155bfbe9e740fb8ce1e1fda900d96f1435a23c`.

[OpenShell #3426](https://github.com/NVIDIA/OpenShell/pull/3426) supplies a writable supervisor TLS directory and a seccomp-listener race correction.
It closes [the reproduced CA failure, #3427](https://github.com/NVIDIA/OpenShell/issues/3427).
The earlier [managed Podman failure](rust-harness-expansion-linux-arm64.md#managed-podman-remains-blocked) remains historical evidence for its named pin.

## Environment and Artifacts

The SDK, gateway, supervisor, sandbox runtime, and CLI used OpenShell `1fe79f53991debf32776853a60f0cbd4e127dcfb`, version `0.0.117-dev.186+g1fe79f539`.
All runtime images were selected by immutable digest:

| Artifact | Reference |
|---|---|
| Gateway | `ghcr.io/nvidia/openshell/gateway@sha256:ec2b0efea84fff198e888e97c85befb9c908acde92e8256f9b527877ed182d66` |
| Supervisor | `ghcr.io/nvidia/openshell/supervisor@sha256:d039ba7f9a0c3e6788cb04c17fc7738f06db42002fcaaef01e0d2dda375938d1` |
| Sandbox runtime | `ghcr.io/nvidia/openshell/sandbox@sha256:5b2131ff985a0ab7b3bb2fd21cba5a18819431134fce9f17ceffde20970ec736` |
| Podman Deep Agents image | `docker.io/library/nc-fabric@sha256:400c54acd0d9792dc8653ab4757473e932ceb1366cf49535a5dc454a22c11c19` |

Podman `5.8.7` ran rootless with `pasta`, `runc`, an isolated image store, and an explicit local Unix API socket.
The managed gateway used port `17750` and its owned `172.30.171.0/24` network.
The existing external vLLM endpoint at `http://172.30.127.1:18905/v1` served real `Qwen/Qwen3-4B`; apply did not create that inference service.
Deep Agents selected a 45-second execution timeout and 128-token output limit.
No provider credential, custom supervisor image, or relaxed egress policy was used.
No packages or images were published.

## Podman Results

| Check | Observed result |
|---|---|
| Initial plan and apply | Succeeded through the bundled CLI, real OpenTofu, production provider, and native OpenShell Podman driver |
| Original minimal reproduction | A separate `/bin/sleep 600` sandbox with no attached providers logged `TLS termination enabled: ephemeral CA generated`; no CA write failure occurred; the sandbox was then deleted |
| Native agent invocation after apply exited | One-shot Fabric SDK invocation inside the agent sandbox returned `status: succeeded`, `completed: true`, and assistant response `FOUR` |
| Provider policy | OpenShell logged an allowed `POST /v1/chat/completions` through the declared provider policy |
| Unchanged plan and apply | Both returned empty `changes` lists |
| Export and reapply | Export succeeded and reapply returned an empty `changes` list |
| Destroy | Removed the managed gateway, sandbox, and provider registrations; retained the gateway storage binding, network, volume, and stopped initializer |
| External service | Existing Qwen inference remained running |

The second Podman inference check completed with assistant response `FIVE`; both runs checked the actual assistant response and successful completion, separately from the echoed prompt.
This qualifies provider connectivity and an agent turn, not instruction-following accuracy.

In the initial run, the retained network ID was `6fa9fc30924aef341eeb932fff0ae843013d5a815db7a2d200062d0ca20d2bb9`.
The retained volume was `nc-bbbf1418704a8a44-gateway-data`.
The native call created a separate one-shot Fabric runtime; it does not qualify conversations through a hosted Deep Agents interface.
Apply reported unsupported Fabric health, consistent with the pinned Fabric contract; inference was checked separately.

## Docker Regression Checks

The [dependency upgrade gate](../testing/live.md#dependency-upgrade-gate) passed with bundle `0.1.0-dev.1a832af12797dc48` and the same independent Qwen service.
It waited for apply to exit, obtained a real reply from the existing hosted OpenClaw runtime, preserved resource and runtime identities through export/reapply, and destroyed its owned workloads.
Its OpenClaw image was `nc-fabric@sha256:a4402fa5dc8b020551f1e3bde409c8079767e53fcba7bd98b32197f82a9355a8`.

A separate Docker Deep Agents attempt lost its supervisor during exec, with `exec relay closed before the command reported an exit status`.
The workload was subsequently stopped by OpenShell; the supervisor exit cause was not established.
Explicit destroy and reapply using the same configuration succeeded, followed by real inference, unchanged operations, export/reapply, and destroy.
Its assistant response was `FIVE`, despite a prompt requesting `FOUR`; this establishes a completed model request, not instruction-following accuracy.
The Deep Agents image was `nc-fabric@sha256:f4a2f7068525f55f1dc25e77dfcc07998a32bd19f44ad75a61e304e255440f56`.
The successful rerun does not explain or rule out the initial supervisor failure.

The upstream release's Docker E2E job also failed while building a fixture image, before its assertions; its [release run](https://github.com/NVIDIA/OpenShell/actions/runs/35272427267) was not wholly green.
The local results above are separate evidence.

## Automated Checks and Limits

The configuration regression failed before the managed Podman implementation and passed afterward.
Formatting, strict workspace Clippy, workspace tests, generated schema checks, and documentation validation passed.
Manual live checks add no jobs or inference services to normal CI.
The preceding [Rust workflow run](https://github.com/NVIDIA/NemoClaw/actions/runs/35257159225) took about 23 minutes on Windows; the ten-minute target was already unmet before this change.
This qualification does not establish that CI wall time meets that target.

This result qualifies the local rootless Linux ARM64 gateway and Deep Agents sandbox path on Podman 5.8.7.
It does not qualify managed Podman inference servers, rootful operation, remote Podman engines, other operating systems, all harnesses, or long-running reliability.
Use [managed Podman setup](../usage.md#use-a-managed-podman-gateway) for prerequisites and retained-resource behavior.
