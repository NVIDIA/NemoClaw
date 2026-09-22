<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Spark Example Qualification

These 2026-09-17 checks exercise the [Spark examples](../../examples/spark/README.md) on one Linux ARM64 DGX Spark with 121 GiB of host memory, NVIDIA driver 580.142, kernel 6.17.0-1014-nvidia, and Docker 29.2.1.
They qualify the named requests and lifecycle operations, not model quality, throughput, multimodal input, or other hardware.

The test bundle was `0.1.0-dev.de67e2b003f92bc1`, built from `0329082b69` plus the Spark example and Qwen XML parser changes.
Its CLI SHA-256 was `f7bf42f66dd86b1426a421bfc6dcd8ba8e286d7f6378ec2444b2e7195d923de7`.
It used OpenTofu 1.12.6 and OpenShell `7e7a8d5610f336f5f7f9f60da0951adbf295475d`.
The ordinary vLLM runtime was rebuilt as `nc-prototype-vllm@sha256:a08d7d6542a20cff9a7f5303e100f71a121d241d0e33fc3be5da6ad6d3bc0c31`.
The model revisions and harness image digests are recorded in each YAML.

Each run used a fresh deployment UID, its own state directory, and its declared ports and gateway CIDR.
A successful lifecycle means plan, apply, a native agent request, unchanged plan/apply, export/reapply with no changes, and destroy all succeeded.
The request asked the agent to read a file containing a newly generated value that was absent from the prompt; the returned value had to match.
Deep Agents files used the adapter's workspace-relative filesystem; Pi and OpenClaw used sandbox paths.

| Example | Live result |
|---|---|
| `pi-small.yaml` | Full lifecycle passed; Pi read the file through Qwen3-4B |
| `deepagents-team.yaml` | Full lifecycle passed; researcher and writer each read their own file through Nemotron 3.5 Lightning |
| `shared-model.yaml` | Full lifecycle passed after the cache intervention below; Pi, OpenClaw, and Deep Agents each read a file through Qwen3.6-35B-A3B |
| `two-models.yaml` | Full lifecycle passed; Pi read the file through both `fast` (Qwen3-4B) and `smart` (Qwen3.6-27B) routes, with successful requests recorded by both model services |
| `local-and-oracle.yaml` | A local-only variant passed the full OpenClaw/Qwen3.8-27B lifecycle; the hosted provider and route were removed because no hosted credential was available |

The exact documented [Deep Agents/Pi commands](../agents.md#run-one-deep-agents-or-pi-request) also returned `FOUR` on the shared-model deployment.
The documented [native OpenClaw command](../agents.md#run-one-headless-openclaw-request) returned `FOUR` both with the default selection and with `--model local` on the local-only Qwen3.8 deployment.
The response metadata selected `nemoclaw_assistant_local`; this checks a native local alias, while hosted-oracle requests remain unqualified.

The first shared-model startup failed in CUDA device initialization, before weight loading, while the host reported 97 GiB available and 5.7 GiB free.
File-scoped `POSIX_FADV_DONTNEED` advice on completed model files from owned test volumes raised free memory to 42 GiB; reapplying the same deployment then succeeded.
The operation retained model files and deployment state.
This result includes a manual cache intervention; the CUDA failure’s root cause remains unconfirmed.

An earlier two-model draft assigned Qwen3-4B 4 GiB of KV cache for a 32K context; vLLM rejected startup because that checkpoint needs 4.5 GiB.
The final example uses the same 20 GiB GPU and 6 GiB KV budgets as the passing small-Pi example.

The moved ordinary, inline-recipe, and SSH examples were not rerun as part of these checks.
The external Podman variant retains the [OpenShell TLS initialization blocker](https://github.com/NVIDIA/OpenShell/issues/3427).
Destroy retains managed model downloads and gateway storage; unrelated deployments were preserved.

The candidate also passed `cargo fmt --check`, workspace Clippy with warnings denied, `cargo test --workspace`, and documentation checks after incorporating `origin/v1` through `b8fef781c8`.
The maintained-example tests now recurse into this directory and check parser/schema agreement, editor schema links, compiled resource topology, authored round trips, and maintained adapter contracts.
