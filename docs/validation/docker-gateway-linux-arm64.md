<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker Gateway Provider Qualification

The real managed-gateway runtime-stage test passed on Linux ARM64 on 2026-09-20 UTC in 44.14 seconds.
The tested source is `51c2a7895c53aa22c24251215f1c21992b7bc6b6`, bundled as `0.1.0-dev.8c4b63a0153d1dd6`.
The environment used Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and Docker provider 4.6.0 alongside the production NemoClaw provider.
The gateway image was the SDK pin `ghcr.io/nvidia/openshell/gateway@sha256:ec2b0efea84fff198e888e97c85befb9c908acde92e8256f9b527877ed182d66`.

The [gateway recovery test](../testing/live.md#docker-gateway-recovery) used a fresh deployment UID, state directory, free port, and unused bridge subnet.
It exercised the real gateway and Docker daemon, without a model or sandbox.

| Behavior | Result |
|---|---|
| Initial plan | Created no container or volume |
| Apply and unchanged apply | Created native Docker compute; subsequent apply kept bindings unchanged |
| Stopped and deleted gateway process | Explicit apply restored a running process while preserving retained storage identity |
| Internal listen-port replacement | Replaced the process while preserving the storage binding |
| Same-length encryption-key substitution | Apply failed without changing provider state; restoring the original key allowed recovery |
| Destroy and reapply | Removed process/image bindings, retained database/keys/bridge/initializer, and recreated compute using the same storage identity |

Workspace formatting, Clippy with warnings denied, and workspace tests passed.
The generated schema rejects `Always` for Docker gateways while retaining the Podman policy contract.
The changed documentation received independent review, and the documentation check passed with zero errors and one existing Fern warning.

This qualifies the managed runtime stage, not sandbox creation, agent responses, GPU inference, or a new Podman lifecycle.
The public SDK still rejects retargeting an established gateway endpoint, and gateway images remain pinned by the SDK.
The bridge and initializer remain NemoClaw-owned retained resources; only the Docker gateway process and image acquisition moved to the Docker provider.
State version 5 rejects older intent without mutation; see [state recovery](../state.md).
