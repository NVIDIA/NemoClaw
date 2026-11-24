<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Travel Assistant

The [HCL project](hcl/main.tf) configures one Pi agent with a local Ollama model and a network policy limited to HTTPS GET requests to `travel.example.com`.
Its [instructions](hcl/instructions.md) ask the agent to research travel schedules and prices. The hostname is illustrative; supply a working source and update the policy and instructions together.

Use an existing Docker-backed OpenShell gateway and a Docker engine with NVIDIA GPU access for Ollama. Supply the gateway, images, model digest, and hardware profile through the project's variables; the default profile is DGX Spark.
Follow the [OpenTofu project procedure](../../../docs/build-deploy/opentofu-project.md) with this directory's `hcl/` project, then [invoke the agent](../../../docs/agents-inference/agents.md#running-one-agent-request).
Applying the project configures the agent; it does not request travel options or implement a booking process.

The [travel team](../travel-team/README.md) shows separate research, scheduling, and buying roles. Refer to each example's validation limits before deploying it.
