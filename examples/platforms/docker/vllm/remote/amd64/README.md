<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker with Remote AMD64 vLLM

[full-featured-openclaw.yaml](full-featured-openclaw.yaml) creates a local Docker gateway and three OpenClaw sandboxes that share a policy and a Nemotron model served by remote Docker over SSH.
The remote AMD64 GPU host must satisfy the YAML's compute, driver, and memory requirements, including at least 96,000,000,000 bytes of GPU memory.

Follow the [SSH placement guide](../../../../../../docs/agents-inference/remote-service.md).
Replace the SSH alias, inference publication address, gateway and model images, and deployment UID. Configure the proxy and network addresses declared by the example for your environment.
Build each image for the architecture of its host and retain the model revision.
Use the [shared run procedure](../../../../../README.md#prepare-and-run-a-yaml-example), then invoke each agent to verify its model route and tool restrictions.

This is a combined configuration example. It does not implement communication between the sandboxes. No new live qualification is claimed for this placement.
