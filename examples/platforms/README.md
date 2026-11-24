<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Platform Examples

Choose the gateway/sandbox backend: Docker, Kubernetes, OpenShift, or Podman.
Within each backend, examples are grouped by runtime or scenario, with hardware variants where needed.
The model server can run on a different engine or host; its placement does not change the gateway's backend folder.
Each family documents its required images, credentials, setup, expected results, and verification limits.

| Backend | Starting point |
|---|---|
| Docker | [Hosted inference, Ollama, local vLLM, and remote model services](docker/README.md) |
| Podman | [Managed gateways and remote model services](podman/README.md) |
| Kubernetes | [Managed or external gateways, authentication, storage, and in-cluster inference](kubernetes/README.md) |
| OpenShift | [Managed or external gateways](openshift/README.md) |

To start with a machine or model, use the [hardware](../guides/by-hardware.md) or [model](../guides/by-model.md) guide.
The [Nemotron Super guide](../guides/nemotron-super.md) shares preparation and memory requirements across its Spark, Station, and WSL2 variants.
The [GTC DC index](../gtc-dc/README.md) links to these canonical files through event aliases.
Hardware variants remain separate because admission checks, memory accounting, and live evidence differ.
