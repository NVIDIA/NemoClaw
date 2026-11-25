<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows WSL2 RTX Spark Examples

These files select the ARM64 N1X RTX Spark profile and a managed Nemotron Super vLLM service inside WSL2.
Each creates one managed Docker gateway, one model service, and one agent sandbox.

| Agent | Configuration |
|---|---|
| Hermes | [hermes-windows-wsl2-rtx-spark.yaml](hermes-windows-wsl2-rtx-spark.yaml) |
| OpenClaw | [openclaw-windows-wsl2-rtx-spark.yaml](openclaw-windows-wsl2-rtx-spark.yaml) |
| Deep Agents | [deepagents-windows-wsl2-rtx-spark.yaml](deepagents-windows-wsl2-rtx-spark.yaml) |

Follow the [shared Nemotron Super guide](../../../../guides/nemotron-super.md) for the 128 GB hardware requirement, WSL2 memory limits, GPU driver boundary, image builds, required replacements, lifecycle commands, and explicit agent requests.
Run the Linux ARM64 tools inside WSL2.

All three configurations receive schema, round-trip, and compiler checks.
Live deployment, memory accounting during model loading, and agent responses remain unverified on this target.
