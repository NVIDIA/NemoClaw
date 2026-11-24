<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Examples by Harness

An example can appear under several harnesses because it configures several sandboxes. OpenClaw includes configurations that use the default harness. The [agent index](../agents/README.md) lists the basic starters.

Use the linked configuration's family README and the [shared run procedure](../README.md#prepare-and-run-a-yaml-example). Inclusion records what a file configures, not live qualification or compatibility with other combinations.

## claude

- [fabric-claude.yaml](../agents/fabric-claude.yaml)

## codex

- [fabric-codex.yaml](../agents/fabric-codex.yaml)

## hermes

- [fabric-hermes.yaml](../agents/fabric-hermes.yaml)
- [hermes-auth.yaml](../features/hermes-auth.yaml)
- [travel-team.yaml](../features/travel-team/travel-team.yaml)
- [web-search.yaml](../features/web-search.yaml)
- [managed-hermes.yaml](../platforms/docker/ollama/dgx-spark/managed-hermes.yaml)
- [hermes-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/hermes-dgx-spark.yaml)
- [hermes-dgx-station.yaml](../platforms/docker/vllm/dgx-station/hermes-dgx-station.yaml)
- [hermes-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/hermes-windows-wsl2-rtx-spark.yaml)
- [two-runtimes.yaml](../platforms/kubernetes/gpu-autoscaling/two-runtimes.yaml)
- [hosted-nvidia.yaml](../platforms/kubernetes/hosted-inference/hosted-nvidia.yaml)
- [managed-oidc.yaml](../platforms/kubernetes/managed-oidc.yaml)

## langchain.deepagents

- [fabric.yaml](../agents/fabric.yaml)
- [multiple-sandboxes.yaml](../features/multiple-sandboxes.yaml)
- [deepagents-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/deepagents-dgx-spark.yaml)
- [deepagents-team.yaml](../platforms/docker/vllm/dgx-spark/deepagents-team.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [deepagents-dgx-station.yaml](../platforms/docker/vllm/dgx-station/deepagents-dgx-station.yaml)
- [deepagents-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/deepagents-windows-wsl2-rtx-spark.yaml)
- [managed-podman.yaml](../platforms/podman/managed-podman.yaml)

## mini-swe-agent

- [fabric-mini-swe-agent.yaml](../agents/fabric-mini-swe-agent.yaml)

## nooa

- [fabric-nooa.yaml](../agents/fabric-nooa.yaml)

## nooa.bench-agent

- [fabric-nooa-bench.yaml](../agents/fabric-nooa-bench.yaml)

## openclaw

- [fabric-openclaw.yaml](../agents/fabric-openclaw.yaml)
- [local.yaml](../agents/local.yaml)
- [openclaw.yaml](../agents/openclaw.yaml)
- [application-container.yaml](../features/application-container.yaml)
- [explicit-policy.yaml](../features/explicit-policy.yaml)
- [inference-tuning.yaml](../features/inference-tuning.yaml)
- [inline-inference.yaml](../features/inline-inference.yaml)
- [multiple-models.yaml](../features/multiple-models.yaml)
- [multiple-providers.yaml](../features/multiple-providers.yaml)
- [multiple-sandboxes.yaml](../features/multiple-sandboxes.yaml)
- [openclaw.yaml](../onboarding/openclaw.yaml)
- [managed-ollama-gpu.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama-gpu.yaml)
- [managed-ollama.yaml](../platforms/docker/ollama/dgx-spark/managed-ollama.yaml)
- [local-and-hosted.yaml](../platforms/docker/vllm/dgx-spark/local-and-hosted.yaml)
- [openclaw-dgx-spark.yaml](../platforms/docker/vllm/dgx-spark/openclaw-dgx-spark.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-spark/vllm.yaml)
- [openclaw-dgx-station.yaml](../platforms/docker/vllm/dgx-station/openclaw-dgx-station.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)
- [vllm.yaml](../platforms/docker/vllm/dgx-station/vllm.yaml)
- [full-featured-openclaw.yaml](../platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml)
- [openclaw-windows-wsl2-rtx-spark.yaml](../platforms/docker/vllm/rtx-spark-wsl2/openclaw-windows-wsl2-rtx-spark.yaml)
- [external-gateway.yaml](../platforms/kubernetes/external-gateway.yaml)
- [openclaw-ollama.yaml](../platforms/kubernetes/gpu-autoscaling/openclaw-ollama.yaml)
- [two-runtimes.yaml](../platforms/kubernetes/gpu-autoscaling/two-runtimes.yaml)
- [hosted-nvidia.yaml](../platforms/kubernetes/hosted-inference/hosted-nvidia.yaml)
- [managed-development.yaml](../platforms/kubernetes/managed-development.yaml)
- [managed-oidc.yaml](../platforms/kubernetes/managed-oidc.yaml)
- [in-cluster-ollama.yaml](../platforms/kubernetes/ollama/in-cluster-ollama.yaml)
- [published-nodeport.yaml](../platforms/kubernetes/published-nodeport.yaml)
- [sandbox-placement.yaml](../platforms/kubernetes/sandbox-placement.yaml)
- [in-cluster-vllm.yaml](../platforms/kubernetes/vllm/in-cluster-vllm.yaml)
- [external-gateway.yaml](../platforms/openshift/external-gateway.yaml)
- [managed-development.yaml](../platforms/openshift/managed-development.yaml)
- [published-route.yaml](../platforms/openshift/published-route.yaml)
- [nemotron-amd64.yaml](../platforms/podman/vllm/remote/amd64/nemotron-amd64.yaml)
- [remote-vllm.yaml](../platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml)

## opencode

- [fabric-opencode.yaml](../agents/fabric-opencode.yaml)

## pi

- [fabric-pi.yaml](../agents/fabric-pi.yaml)
- [multiple-sandboxes.yaml](../features/multiple-sandboxes.yaml)
- [pi-small.yaml](../platforms/docker/vllm/dgx-spark/pi-small.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-spark/shared-model.yaml)
- [two-models.yaml](../platforms/docker/vllm/dgx-spark/two-models.yaml)
- [shared-model.yaml](../platforms/docker/vllm/dgx-station/shared-model.yaml)

## remote-agent

- [fabric-remote-agent.yaml](../agents/fabric-remote-agent.yaml)
