<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station Qwen3-4B and OpenClaw Test

These tests exercised one Linux ARM64 DGX Station with one NVIDIA GB300, Qwen3-4B, and OpenClaw.
They qualify only the recorded sources and environment, not every DGX Station configuration.

## Current Example Candidate

The final 2026-09-19 run used the proposed [Station example](../../examples/station/README.md) based on v1 commit `ba2e41fbb093f764d07774bb5a920e99e55daedf`.
The candidate included the example, its deterministic test, and documentation changes for NVIDIA/NemoClaw issue #12116.
Its content-derived bundle version was `0.1.0-dev.4e379ff9c2a8ead8`.
The CLI SHA-256 was `fc5a1ef1b0c5b885e8fd65bb5b40fbc2ad8b382d6dd9db985e54b9e869747d3f`, and the checked-in example SHA-256 was `6d156d81b7182e7da9584ed4ca7f290a34be6e1fc65c2f2adc8a0a38d2598f97`.

The host ran Ubuntu 24.04 on ARM64 with one NVIDIA GB300, compute capability 10.3, driver 610.43.02, and 256703 MiB of dedicated GPU memory.
Docker 29.6.1 used the containerd snapshotter with `overlayfs`.
An unrelated OpenShell workload remained healthy throughout the run.

The final run used these locally built ARM64 images:

- runtime: `nc-prototype-vllm@sha256:2db1b3af757d9dac09d80b74e81c9db63053f01c8d196519279d5572a157fb0c`
- OpenClaw: `nc-station-12116@sha256:d7c306660357fa1eee81d7167ea7a51d3854c054620100066738b007cde6be44`

The runtime was rebuilt from the tested source after v1 separated managed authentication storage from the model cache.
The OpenClaw build inputs were unchanged, so the previously built sandbox image was reused.
Both images loaded through Docker's containerd image store.
The runtime build did not reproduce the classic-image-store OCI loading failure tracked by [NVIDIA/NemoClaw#12100](https://github.com/NVIDIA/NemoClaw/issues/12100); this does not resolve that Spark failure.

The run-only configuration replaced the example's image markers, UID, ports, and gateway CIDR.
It retained the example's `dgx-station` profile, pinned Qwen3-4B revision, managed bearer authentication, and isolated sandbox network.
Its SHA-256 was `d20a56c489be7daed0530b2ff4e964a28efe53210cf6098171d5b9d49b86dfa6`.

The full lifecycle passed:

| Check | Result |
|---|---|
| Initial plan | Seven first-stage creates, including separate model-cache and authentication storage plus the provider-owned gateway container and images; OpenShell registration and the sandbox were deferred until the gateway existed |
| Initial apply | Succeeded with the expected managed service, separate storage, provider-owned gateway, provider, workspace, and sandbox resources |
| Native OpenClaw request | Returned `FOUR` from `Qwen/Qwen3-4B`; no error, abort, fallback, or reroute |
| Unchanged plan | `No resource changes planned.` |
| Unchanged apply | Succeeded with an empty `changes` list |
| Export | Succeeded; the exported YAML SHA-256 was `d5d4c0f3d8df6de73984e64bdd69d27d5f03b7ae5e639b7f038c16793178c0ad` and did not contain the generated credential |
| Exported configuration | Plan reported no changes; apply succeeded with an empty `changes` list |
| Destroy | Removed the provider, profile, sandbox, service and gateway containers, and both image bindings; retained the workspace, model cache, gateway storage, and authentication storage |
| Repeated destroy | Succeeded with an empty `changes` list and the same four retained resources |

Apply reported `fabric_health_unsupported` because the pinned Fabric does not implement `runtime.check_health()`.
The separate native request established the agent response.
Managed authentication generated a private bearer key with mode `600` in the separate retained authentication volume.
The model cache did not contain the key, and neither the deployment input nor export contained its value.

After destroy, the gateway, inference, and sandbox workloads were absent.
The gateway initializer, gateway volume, model volume, authentication volume, and deployment network remained as documented.
GPU use returned to 22 MiB, and the unrelated workload was unchanged.

An initial attempt at this source revision reused the runtime image from the earlier revision.
It stopped at readiness with `managed inference credential is missing` because that image wrote the key to the old model-data path while the current SDK mounted separate authentication storage.
Destroy removed the failed attempt's workloads, and a fresh deployment with the runtime rebuilt from the same checkout passed.
This was an artifact/source mismatch, not a v1 defect, and confirms the example's same-checkout build requirement.

The deterministic checks also passed for current schema generation, documentation generation, configuration parsing, compiled topology, explicit image pins, and the `dgx-station` profile.

## Earlier Source Revisions

The prior final-candidate run used base commit `9713ec962d2b2ca8472989b3d827568462ce1b86` with bundle version `0.1.0-dev.fea0bc72b615223b` and CLI SHA-256 `622131a5903f6eeb55a4a5f0898ed830af9c1060c09069f6c126b7521fe8be89`.
Its full lifecycle passed with the earlier combined inference storage shape.

An earlier 2026-09-19 run used the same candidate changes on base commit `af0a87cab0171787ab956eade461400c1536d62c`.
Its bundle version was `0.1.0-dev.c02fc467fa8ad25d`, and its CLI SHA-256 was `35e647640707b84bb9e4192a2e2b66159fe919871fdd4a10b4bf1959bfa91dc4`.
That full lifecycle passed before the gateway's Docker-provider ownership changes landed in v1.

The 2026-09-18 run tested v1 commit `0d6f45606eeb3ce4d07121ea63e6760a03594391` before service-configuration consolidation.
Its bundle version was `0.1.0-dev.75678a825e9b2371`, and its CLI SHA-256 was `8d9264737f576e0bb92ab53eee563291401475072fa7c65fc207f1145e71ae6e`.
It used runtime image `nc-prototype-vllm@sha256:3d866a3725b263f9b52876980ca03f4cada927668d3ef428bbc655cb6fbb1fbc` and OpenClaw image `nc-v1-station-0d6f456@sha256:72c7fd56f3cd49c40daffbc44ecf8d379402c219468c95fb0f4a4c42db9dab4d`.

That full lifecycle also passed: plan/apply, a native `FOUR` response, unchanged apply, export/reapply, destroy with retained storage, and repeated destroy with no additional changes.
The final current-candidate run supersedes the earlier results as evidence for the checked-in service, storage, and gateway ownership shapes while retaining them for history.

## Qualification Boundary

These runs did not test deliberate inference-process recovery, model-data identity across recovery, long-running stability, performance, multiple GPUs, multiple Stations, another model, or another agent.
They do not establish general DGX Station support or release-candidate qualification.
