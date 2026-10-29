<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Step 6c on NemoClaw v1: Deep Agents + NIM results

Same node and method as [`RESULTS-6b.md`](RESULTS-6b.md): `dgx-20`, HPA maximum 7, Helm 4.3.0, ten sandboxes.
The GPU chart served `nvidia/nemotron-3-nano` on NIM.
The sandboxes came from [`deepagents-nim.yaml`](deepagents-nim.yaml) expanded to ten users, in their own namespace (`nemoclaw-v1-gpu-autoscaling-dagent`) so the 6b deployment stayed up.

| | GPU util, 1 chat in flight | GPU util, 3 in flight | LLM latency, 1 in flight |
| --- | --- | --- | --- |
| HPA metric | `gpu_utilization_percent`, 40% | `gpu_utilization_percent`, 40% | `latency_avg`, 3000 ms |
| Peak GPU replicas | 5 (target not reached) | 7 | 7 |
| First poll to first 7 replicas | not reached | about 380 s | about 395 s |
| 7 replicas back to 1 | not reached | about 151 s | about 377 s |
| Successful chats / errors | 940 / 0 | 381 / 0 | 297 / 0 |
| Estimated reply tokens | 937,995 | 373,428 | 288,730 |

With one chat in flight per user the GPU-utilization run stayed at 5 replicas until the 900 s send ceiling, then scaled back to 1.
Three chats in flight per user reached 7.
Times come from the client's HPA poll CSV and are approximate.
Reply tokens are estimated from reply length (about 4 characters per token).

## Notes

- Deep Agents returns its answer in `result.output.response`, like Hermes, and also reports token usage. The client estimates tokens from reply length for both agents.
- The Deep Agents image builds from the v1 checkout with `cargo images build --platform linux/amd64 deepagents`, and the node pulls it from a local registry at `127.0.0.1:5000`.
- NIM's pod used the existing Secrets `nim-ngc-key` and `ngc-registry`, so no NGC key was written to this folder.
- Raw logs are under `e2e-results/deepagents-v1/` and stay out of git.
