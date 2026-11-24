<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Podman Examples

| Configuration | Gateway and inference |
|---|---|
| [managed-podman.yaml](managed-podman.yaml) | Managed rootless Podman gateway and an existing model endpoint |
| [Remote AMD64 vLLM](vllm/remote/amd64/README.md) | Existing Podman gateway and SSH-managed Docker inference |
| [Remote Spark vLLM](vllm/remote/dgx-spark/README.md) | Existing Podman gateway and Qwen on a remote Docker Spark host |

## Managed Gateway

[managed-podman.yaml](managed-podman.yaml) creates a managed rootless Podman gateway and one Deep Agents runtime using an existing inference endpoint.

Prepare a local Linux Podman API socket, an agent image in that engine's image store, and inference reachable from the gateway.
Follow the [Podman prerequisites](../../../docs/build-deploy/usage.md#using-a-managed-podman-gateway), then replace the socket, image digest, deployment UID, endpoint, and model in a private copy.
Use the [shared run procedure](../../README.md#prepare-and-run-a-yaml-example).
Expect a managed gateway and one ready agent; send an explicit request to establish a response, then check unchanged apply and retained teardown.

The file receives schema, round-trip, and compiler checks.
The [platform limits](../../../docs/resources/limits.md#platforms-models-and-placement) apply; no new live Podman or inference evidence is claimed.
