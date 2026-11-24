<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Platform Examples

Choose the environment that will own the gateway and inference service.
Each family documents its required images, credentials, setup, expected results, and verification limits.

| Environment | Starting point |
|---|---|
| Docker with hosted inference, no local GPU | [One OpenClaw agent](docker/README.md) |
| Rootless Linux Podman with existing inference | [One Deep Agents runtime](podman/README.md) |
| DGX Spark | [Local models, shared inference, several models, and hosted routes](dgx-spark/README.md) |
| DGX Station | [OpenClaw and shared inference on a single GB300](dgx-station/README.md) |
| Windows WSL2 RTX Spark | [Nemotron Super hardware variants](windows-wsl2-rtx-spark/README.md) |
| A remote AMD64 GPU host | [SSH-managed Nemotron inference](remote-inference/README.md) |
| Kubernetes | [Managed or external gateways, authentication, storage, and in-cluster inference](kubernetes/README.md) |
| OpenShift | [Managed or external gateways](openshift/README.md) |

The [Nemotron Super guide](nemotron-super.md) shares preparation and memory requirements across its Spark, Station, and WSL2 variants.
The [GTC DC index](../gtc-dc/README.md) links to these canonical files through event aliases.
Hardware variants remain separate because admission checks, memory accounting, and live evidence differ.
