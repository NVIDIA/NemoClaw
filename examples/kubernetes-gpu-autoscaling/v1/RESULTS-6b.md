<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Step 6b on NemoClaw v1: Hermes + vLLM results

Two runs on one DGX node (`dgx-20`, 8 GPUs, 1 held by other workloads, so the HPA maximum is 7).
The GPU chart served `nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8` on vLLM, and Helm was 4.3.0.
Ten Hermes sandboxes (`user-0000` … `user-0009`) came from [`hermes-vllm.yaml`](hermes-vllm.yaml) expanded with `v1-render-sandboxes.sh`.

| | GPU utilization | LLM latency |
| --- | --- | --- |
| HPA metric | `gpu_utilization_percent`, target 40% | `latency_avg`, target 3000 ms |
| Client | `INFLIGHT=2 MAX_TOKENS=1024` | `INFLIGHT=1`, 2048 tokens |
| Peak GPU replicas | 7 | 7 |
| First poll to first 7 replicas | about 416 s | about 376 s |
| 7 replicas back to 1 | about 166 s | about 166 s |
| Successful chats / errors | 801 / 0 | 418 / 0 |
| Estimated reply tokens | 115,802 | 54,230 |

Both runs stopped new chats at 7 replicas, waited for the HPA to return to 1, and reported `reached_target` and `scale_down_ok` as true.
Times come from the client's HPA poll CSV (`hpa_10users.csv`) and are approximate.
Reply tokens are estimated from reply length (about 4 characters per token), not reported by vLLM.

## What differs from v0

- A v1 sandbox runs Fabric, so [`v1-client-hermes.sh`](scripts/v1-client-hermes.sh) sends each prompt with `kubectl exec … fabric-agent-ctl invoke`, not `hermes -z` through the v0.0.85 gateway.
- The `development` gateway profile gives the operator no token, so `openshell` cannot reach the v1 gateway. The client reads each Fabric runtime id from the nemoclaw state directory.
- The Hermes runtime keeps conversation history across invokes, so each sandbox's context grows during a run.
- The sandbox route sets `maxTokens: 2048`. The client's `MAX_TOKENS` only picks the prompt length.
- [`v1-set-hpa-metric.sh`](scripts/v1-set-hpa-metric.sh) switches the chart between the two metrics without touching the runtime or the sandboxes.

Raw logs (`client.log`, `hpa-watch.log`, `hpa-timeline.jsonl`, `summary_10users.json`) are under `e2e-results/hermes-v1/` and stay out of git.
