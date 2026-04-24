<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

## Hardware

| Resource | Minimum        | Recommended      |
|----------|----------------|------------------|
| CPU      | 4 vCPU         | 4+ vCPU          |
| RAM      | 8 GB           | 16 GB            |
| Disk     | 20 GB free     | 40 GB free       |

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline. The pipeline buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer. If you cannot add memory, configuring at least 8 GB of swap can work around the issue at the cost of slower performance.

## Software

| Dependency | Version                          |
|------------|----------------------------------|
| Node.js    | 22.16 or later |
| npm        | 10 or later |
| Platform   | See [Platforms](#platforms) below |

:::{warning} OpenShell Lifecycle
For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.
:::

## Platforms

The following table lists tested platform and runtime combinations.
Availability is not limited to these entries, but untested configurations can have issues.
The table is generated from [`ci/platform-matrix.json`](https://github.com/NVIDIA/NemoClaw/blob/main/ci/platform-matrix.json), the single source of truth kept in sync by CI and QA.

| OS | Container runtime | Status | Notes |
|----|-------------------|--------|-------|
| Linux | Docker | Tested | Primary tested path. |
| macOS (Apple Silicon) | Colima, Docker Desktop | Tested with limitations | Install Xcode Command Line Tools (`xcode-select --install`) and start the runtime before running the installer. |
| DGX Spark | Docker | Tested | Use the standard installer and `nemoclaw onboard`. For an end-to-end walkthrough with local Ollama inference, see the [NVIDIA Spark playbook](https://build.nvidia.com/spark/nemoclaw). |
| Windows WSL2 | Docker Desktop (WSL backend) | Tested with limitations | Requires WSL2 with Docker Desktop backend. |

## Next Steps

- Prepare Windows for NemoClaw (use the `nemoclaw-user-get-started` skill) if you are using Windows.
- Quickstart (use the `nemoclaw-user-get-started` skill) to install NemoClaw and launch your first sandbox.
