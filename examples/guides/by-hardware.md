<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Examples by Hardware

Hardware here describes the managed model host. The gateway can run elsewhere. Files using hosted or existing inference do not establish the hardware behind that endpoint; refer to the [platform index](../platforms/README.md) for those deployments.

Use the linked configuration's family README and the [shared run procedure](../README.md#prepare-and-run-a-yaml-example). Inclusion records what a file configures, not live qualification or compatibility with other combinations.

## Configurable hardware in HCL

- [features/travel-team/hcl/README.md](../features/travel-team/hcl/README.md)
- [main.tf](../features/travel/hcl/main.tf)

## amd64 GPU host (explicit requirements)

- [full-featured-openclaw.yaml](../platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml)
- [nemotron-amd64.yaml](../platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml)

## dgx-spark

- [travel-team.yaml](../features/travel-team/travel-team.yaml)
- [managed-hermes.yaml](../platforms/docker/ollama/dgx-spark/managed-hermes.yaml)
- [managed-ollama-gpu.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama-gpu.yaml)
- [managed-ollama.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama.yaml)
- [deepagents-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/deepagents-dgx-spark.yaml)
- [deepagents-team.yaml](../platforms/docker/vllm/dgx-spark/deepagents-team.yaml)
- [hermes-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/hermes-dgx-spark.yaml)
- [local-and-hosted.yaml](../platforms/docker/vllm/dgx-spark/local-and-hosted.yaml)
- [openclaw-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/openclaw-dgx-spark.yaml)
- [pi-small.yaml](../platforms/docker/vllm/dgx-spark/pi-small.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [two-models.yaml](../platforms/docker/vllm/dgx-spark/two-models.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-spark/vllm.yaml)
- [remote-vllm.yaml](../platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml)

## dgx-station

- [deepagents-dgx-station.yaml](../platforms/docker/vllm/dgx-station/deepagents-dgx-station.yaml)
- [hermes-dgx-station.yaml](../platforms/docker/vllm/dgx-station/hermes-dgx-station.yaml)
- [openclaw-dgx-station.yaml](../platforms/docker/vllm/dgx-station/openclaw-dgx-station.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-station/vllm.yaml)

## rtx-spark

- [deepagents-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/deepagents-windows-wsl2-rtx-spark.yaml)
- [hermes-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/hermes-windows-wsl2-rtx-spark.yaml)
- [openclaw-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml)
