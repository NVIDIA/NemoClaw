<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GTC DC Readiness Index

This directory preserves the GTC DC configuration names as relative symlinks.
The owning YAML and HCL files live under [platforms](../platforms/README.md).
Edit those canonical files so event and general deployment paths stay aligned.
On Windows without Git symlink support, use the canonical paths linked from the platform index.

## Choose a Target

| Agent | DGX Spark | DGX Station | Windows WSL2 RTX Spark |
|---|---|---|---|
| Hermes | [YAML](hermes-dgx-spark.yaml) | [YAML](hermes-dgx-station.yaml) | [YAML](hermes-windows-wsl2-rtx-spark.yaml) |
| OpenClaw | [YAML](openclaw-dgx-spark.yaml) | [YAML](openclaw-dgx-station.yaml) | [YAML](openclaw-windows-wsl2-rtx-spark.yaml) |
| Deep Agents | [YAML](deepagents-dgx-spark.yaml) | [YAML](deepagents-dgx-station.yaml) | [YAML](deepagents-windows-wsl2-rtx-spark.yaml) |

For prerequisites, memory budgets, image preparation, plan/apply, agent requests, retained teardown, and verification evidence, follow the [Nemotron Super deployment profiles](../platforms/nemotron-super.md).
The recorded Spark runs cover Hermes and Deep Agents; they do not establish readiness for the other combinations.
Check the guide's qualification boundary before selecting an event target.

## AMD64 Kubernetes with NVIDIA Cloud Inference

The [YAML](kubernetes-amd64.yaml) and [HCL](kubernetes-amd64.tf) aliases select the canonical Kubernetes hosted-inference configurations.
Follow their [setup and verification instructions](../platforms/nemotron-super.md#amd64-kubernetes-with-nvidia-cloud-inference).
This profile requires live validation.
