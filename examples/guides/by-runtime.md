<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Examples by Inference Runtime

Runtime means model-serving software, such as Ollama or vLLM. Docker, Podman, Kubernetes, and OpenShift are gateway backends. Generic endpoint examples do not identify which software operates the endpoint.

Use the linked configuration's family README and the [shared run procedure](../README.md#prepare-and-run-a-yaml-example). Inclusion records what a file configures, not live qualification or compatibility with other combinations.

## Existing Ollama service

- [openclaw-ollama.yaml](../platforms/kubernetes/gpu-autoscaling/openclaw-ollama.yaml)
- [in-cluster-ollama.yaml](../platforms/kubernetes/ollama/in-cluster-ollama.yaml)

## Existing services with multiple runtimes

- [two-runtimes.yaml](../platforms/kubernetes/gpu-autoscaling/two-runtimes.yaml)

## Existing vLLM service

- [in-cluster-vllm.yaml](../platforms/kubernetes/vllm/in-cluster-vllm.yaml)

## Hosted or operator-supplied endpoints

- [multiple-models.yaml](../features/multiple-models.yaml)
- [multiple-providers.yaml](../features/multiple-providers.yaml)
- [openclaw.yaml](../onboarding/openclaw.yaml)
- [hosted-nvidia.yaml](../platforms/kubernetes/hosted-inference/hosted-nvidia.yaml)

## Managed Ollama in HCL

- [features/travel-team/hcl/README.md](../features/travel-team/hcl/README.md)
- [main.tf](../features/travel/hcl/main.tf)

## Managed ollama

- [travel-team.yaml](../features/travel-team/travel-team.yaml)
- [managed-hermes.yaml](../platforms/docker/ollama/dgx-spark/managed-hermes.yaml)
- [managed-ollama-gpu.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama-gpu.yaml)
- [managed-ollama.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama.yaml)

## Managed vllm

- [deepagents-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/deepagents-dgx-spark.yaml)
- [deepagents-team.yaml](../platforms/docker/vllm/dgx-spark/deepagents-team.yaml)
- [hermes-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/hermes-dgx-spark.yaml)
- [local-and-hosted.yaml](../platforms/docker/vllm/dgx-spark/local-and-hosted.yaml)
- [openclaw-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/openclaw-dgx-spark.yaml)
- [pi-small.yaml](../platforms/docker/vllm/dgx-spark/pi-small.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [two-models.yaml](../platforms/docker/vllm/dgx-spark/two-models.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-spark/vllm.yaml)
- [deepagents-dgx-station.yaml](../platforms/docker/vllm/dgx-station/deepagents-dgx-station.yaml)
- [hermes-dgx-station.yaml](../platforms/docker/vllm/dgx-station/hermes-dgx-station.yaml)
- [openclaw-dgx-station.yaml](../platforms/docker/vllm/dgx-station/openclaw-dgx-station.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-station/vllm.yaml)
- [full-featured-openclaw.yaml](../platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml)
- [deepagents-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/deepagents-windows-wsl2-rtx-spark.yaml)
- [hermes-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/hermes-windows-wsl2-rtx-spark.yaml)
- [openclaw-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml)
- [nemotron-amd64.yaml](../platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml)
- [remote-vllm.yaml](../platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml)
