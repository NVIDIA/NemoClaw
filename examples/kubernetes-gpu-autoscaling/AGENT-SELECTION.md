<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agent selection

Apply one pairing file in this directory. Each file is one NemoClaw config: a managed OpenShell gateway, Fabric sandboxes, and the GPU chart Service `/v1`. The chart, HPA, and Envoy load balancer are the Helm release in this directory. See the [README quick start](README.md#quick-start).

| | OpenClaw + Ollama | Hermes + vLLM | Hermes + NIM | Deep Agents + NIM |
| --- | --- | --- | --- | --- |
| File | [`openclaw-ollama.yaml`](openclaw-ollama.yaml) | [`hermes-vllm.yaml`](hermes-vllm.yaml) | [`hermes-nim.yaml`](hermes-nim.yaml) | [`deepagents-nim.yaml`](deepagents-nim.yaml) |
| `harness.kind` | `nvidia.fabric.openclaw` | `nvidia.fabric.hermes` | `nvidia.fabric.hermes` | `nvidia.fabric.langchain.deepagents` |
| Chart `INFERENCE_RUNTIME` | `ollama` | `vllm` | `nim` | `nim` |
| Namespace | `nemoclaw-v1-gpu-autoscaling-openclaw` | `nemoclaw-v1-gpu-autoscaling` | `nemoclaw-v1-gpu-autoscaling` | `nemoclaw-v1-gpu-autoscaling-dagent` |
| State directory | `.local/gpu-autoscaling-openclaw` | `.local/gpu-autoscaling` | `.local/gpu-autoscaling` | `.local/gpu-autoscaling-deepagents` |
| Load client | [`client-openclaw.sh`](scripts/client-openclaw.sh) | [`client-hermes.sh`](scripts/client-hermes.sh) | [`client-hermes.sh`](scripts/client-hermes.sh) | [`client-deepagents.sh`](scripts/client-deepagents.sh) |

`hermes-nim.yaml` and `hermes-vllm.yaml` share a namespace and a state directory. Apply only one of them at a time. OpenClaw and Deep Agents use their own namespaces, so either can stay up beside one Hermes deployment.

GPU utilization and LLM latency use the same client. Switch the chart metric with [`set-hpa-metric.sh`](scripts/set-hpa-metric.sh). Recorded Hermes and Deep Agents runs are in [`RESULTS-6b.md`](RESULTS-6b.md) and [`RESULTS-6c.md`](RESULTS-6c.md).
