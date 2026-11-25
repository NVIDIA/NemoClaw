<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Examples by Model

Names are the model IDs written in the YAML, including illustrative IDs that must be replaced. A file can contain several models and harnesses; inspect its routes to identify which agent uses each model. HCL projects accept model variables and are listed with the [features](../features/README.md#hcl-projects).

Use the linked configuration's family README and the [shared run procedure](../README.md#prepare-and-run-a-yaml-example). Inclusion records what a file configures, not live qualification or compatibility with other combinations.

## Qwen/Qwen3-4B

- [pi-small.yaml](../platforms/docker/vllm/dgx-spark/pi-small.yaml)
- [two-models.yaml](../platforms/docker/vllm/dgx-spark/two-models.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-spark/vllm.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-station/vllm.yaml)
- [in-cluster-vllm.yaml](../platforms/kubernetes/vllm/in-cluster-vllm.yaml)
- [remote-vllm.yaml](../platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml)

## example-model

- [external-gateway.yaml](../platforms/kubernetes/external-gateway.yaml)
- [external-gateway.yaml](../platforms/openshift/external-gateway.yaml)

## example-reasoning-model

- [openclaw.yaml](../agents/openclaw.yaml)
- [application-container.yaml](../features/application-container.yaml)
- [inference-tuning.yaml](../features/inference-tuning.yaml)

## fixture-model

- [fabric-claude.yaml](../agents/fabric-claude.yaml)
- [fabric-codex.yaml](../agents/fabric-codex.yaml)
- [fabric-mini-swe-agent.yaml](../agents/fabric-mini-swe-agent.yaml)
- [fabric-nooa-bench.yaml](../agents/fabric-nooa-bench.yaml)
- [fabric-nooa.yaml](../agents/fabric-nooa.yaml)
- [fabric-remote-agent.yaml](../agents/fabric-remote-agent.yaml)

## llama3.2:3b

- [openclaw-ollama.yaml](../platforms/kubernetes/gpu-autoscaling/openclaw-ollama.yaml)
- [two-runtimes.yaml](../platforms/kubernetes/gpu-autoscaling/two-runtimes.yaml)

## moonshotai/kimi-k2.6

- [hermes-auth.yaml](../features/hermes-auth.yaml)

## nemotron-3-nano:30b

- [travel-team.yaml](../features/travel-team/travel-team.yaml)

## nemotron-3-nano:4b

- [managed-hermes.yaml](../platforms/docker/ollama/dgx-spark/managed-hermes.yaml)

## nemotron-3-super

- [deepagents-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/deepagents-dgx-spark.yaml)
- [hermes-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/hermes-dgx-spark.yaml)
- [openclaw-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/openclaw-dgx-spark.yaml)
- [deepagents-dgx-station.yaml](../platforms/docker/vllm/dgx-station/deepagents-dgx-station.yaml)
- [hermes-dgx-station.yaml](../platforms/docker/vllm/dgx-station/hermes-dgx-station.yaml)
- [openclaw-dgx-station.yaml](../platforms/docker/vllm/dgx-station/openclaw-dgx-station.yaml)
- [deepagents-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/deepagents-windows-wsl2-rtx-spark.yaml)
- [hermes-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/hermes-windows-wsl2-rtx-spark.yaml)
- [openclaw-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml)

## nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4

- [full-featured-openclaw.yaml](../platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml)
- [nemotron-amd64.yaml](../platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml)

## nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8

- [two-runtimes.yaml](../platforms/kubernetes/gpu-autoscaling/two-runtimes.yaml)

## nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4

- [deepagents-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/deepagents-dgx-spark.yaml)
- [hermes-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/hermes-dgx-spark.yaml)
- [openclaw-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/openclaw-dgx-spark.yaml)
- [deepagents-dgx-station.yaml](../platforms/docker/vllm/dgx-station/deepagents-dgx-station.yaml)
- [hermes-dgx-station.yaml](../platforms/docker/vllm/dgx-station/hermes-dgx-station.yaml)
- [openclaw-dgx-station.yaml](../platforms/docker/vllm/dgx-station/openclaw-dgx-station.yaml)
- [deepagents-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/deepagents-windows-wsl2-rtx-spark.yaml)
- [hermes-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/hermes-windows-wsl2-rtx-spark.yaml)
- [openclaw-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml)

## nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4

- [deepagents-team.yaml](../platforms/docker/vllm/dgx-spark/deepagents-team.yaml)
- [full-featured-openclaw.yaml](../platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml)
- [nemotron-amd64.yaml](../platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml)

## nvidia/Qwen3.6-27B-NVFP4

- [two-models.yaml](../platforms/docker/vllm/dgx-spark/two-models.yaml)

## nvidia/Qwen3.6-35B-A3B-NVFP4

- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)

## nvidia/Qwen3.8-27B-NVFP4

- [local-and-hosted.yaml](../platforms/docker/vllm/dgx-spark/local-and-hosted.yaml)

## nvidia/nemotron-3-ultra-550b-a55b

- [managed-development.yaml](../platforms/kubernetes/managed-development.yaml)
- [managed-development.yaml](../platforms/openshift/managed-development.yaml)

## nvidia/nemotron-3.5-super-vl-120b-a12b

- [travel-team.yaml](../features/travel-team/travel-team.yaml)
- [openclaw.yaml](../onboarding/openclaw.yaml)
- [hosted-nvidia.yaml](../platforms/kubernetes/hosted-inference/hosted-nvidia.yaml)
- [managed-oidc.yaml](../platforms/kubernetes/managed-oidc.yaml)
- [published-nodeport.yaml](../platforms/kubernetes/published-nodeport.yaml)
- [sandbox-placement.yaml](../platforms/kubernetes/sandbox-placement.yaml)
- [published-route.yaml](../platforms/openshift/published-route.yaml)

## qwen3.5:0.8b

- [local.yaml](../agents/local.yaml)
- [explicit-policy.yaml](../features/explicit-policy.yaml)

## qwen3:0.6b

- [managed-ollama-gpu.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama-gpu.yaml)
- [managed-ollama.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama.yaml)
- [in-cluster-ollama.yaml](../platforms/kubernetes/ollama/in-cluster-ollama.yaml)

## qwen3:1.7b

- [fabric-hermes.yaml](../agents/fabric-hermes.yaml)
- [fabric.yaml](../agents/fabric.yaml)
- [managed-podman.yaml](../platforms/podman/managed-podman.yaml)

## qwen3:32b

- [multiple-models.yaml](../features/multiple-models.yaml)

## qwen3:4b

- [fabric-openclaw.yaml](../agents/fabric-openclaw.yaml)
- [fabric-opencode.yaml](../agents/fabric-opencode.yaml)
- [fabric-pi.yaml](../agents/fabric-pi.yaml)
- [inline-inference.yaml](../features/inline-inference.yaml)
- [multiple-models.yaml](../features/multiple-models.yaml)
- [multiple-providers.yaml](../features/multiple-providers.yaml)
- [multiple-sandboxes.yaml](../features/multiple-sandboxes.yaml)
- [web-search.yaml](../features/web-search.yaml)

## replace-with-supported-model

- [multiple-providers.yaml](../features/multiple-providers.yaml)

## replace-with-your-hosted-model

- [local-and-hosted.yaml](../platforms/docker/vllm/dgx-spark/local-and-hosted.yaml)
