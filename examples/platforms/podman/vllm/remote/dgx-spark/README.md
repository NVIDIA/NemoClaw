<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Podman with Remote vLLM on DGX Spark

[remote-vllm.yaml](remote-vllm.yaml) runs OpenClaw on an existing Podman gateway and manages a Qwen3-4B vLLM service through Docker over SSH on a DGX Spark.
The gateway backend determines this folder; Docker runs the remote model service.

Follow the [SSH placement guide](../../../../../../docs/agents-inference/remote-service.md).
Supply the gateway endpoint, SSH alias, runtime and agent images, deployment UID, and an inference address reachable from the gateway.
The model host needs the Spark hardware and memory declared in the YAML.
Use the [shared procedure](../../../../../README.md#prepare-and-run-a-yaml-example) and verify an agent response separately from model readiness.

This placement remains [untested live](../../../../../../docs/resources/limits.md#platforms-models-and-placement). Configuration checks do not establish model loading or successful requests on this combination.
