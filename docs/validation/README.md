<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validation Evidence

These records qualify specific behaviors, revisions, and environments of NemoClaw.
They do not establish that every backend works on every host.
Commit bodies retain the test-first implementation decisions.

The [hosted NVIDIA OpenClaw Linux/Docker scenario](scenarios/openclaw-nvidia-hosted-linux-docker.md) defines the first comparison for NVIDIA/NemoClaw issue #11810 as strict v0-export-to-v1 desired-state translation followed by a new v1 lifecycle.
It is explicitly live-gated and is not qualification evidence until the pinned v0 target captures its export before cleanup and both lifecycle proofs are run, redacted, reviewed, and retained here.

| Contract | Evidence |
|---|---|
| SDK and CLI plan/apply/export/destroy; ownership, identity, drift, partial creation, failed observations, interrupted destroy | Workspace behavioral tests and real OpenTofu protocol/lifecycle tests in [native platform qualification](rust-native-platforms.json) |
| Strict schema, defaults, resource addresses, digests and agent launch contracts | Checked-in fixtures in `crates/nemoclaw-sdk/tests/fixtures` and behavioral tests for maintained YAML examples |
| Managed gateway and retained signing/encryption identity | [Gateway lifecycle](rust-managed-gateway-linux-arm64.json), [gateway storage](rust-gateway-storage-linux-arm64.json) |
| Fresh Spark download/preparation, real OpenClaw response, no-op, export/reapply, capacity rejection, watchdog stop/recovery, image-only replacement | [Spark lifecycle](rust-spark-linux-arm64.json) |
| Model-specific runtime sources, licenses, and repeatable local artifact build | [Final runtime reproduction](rust-runtime-memory-fix-linux-arm64.json) |
| Fabric native harness protocols and native OpenClaw settings | [Ten-harness SDK fixtures](rust-native-platforms.json), [seven native harness fixtures](rust-fabric-adapters-linux-arm64.json), [native OpenClaw](rust-native-openclaw-linux-arm64.json) |
| Managed Ollama initial apply, no-op, export/reapply | [Real Docker/Ollama lifecycle](rust-ollama-linux-arm64.json) |
| Ollama stopped-service recovery, independent retained storage, interrupted destroy and reapply | [Real provider/OpenTofu with deterministic fixtures](rust-ollama-recovery-linux-arm64.json) |
| Deep Agents, Hermes and Fabric OpenClaw native responses, stable hosted runtime, no-op, export/reapply and teardown | [Live Fabric qualification](rust-fabric-live-linux-arm64.json) |
| Runtime/recipe/backend/hardware separation, renamed executable, image upgrade and offline reproduction | [Runtime boundaries](rust-runtime-boundaries-linux-arm64.json) |
| Config-selected public model, generic runtime, no-op/export, failed startup recovery and watchdog lifecycle | [Selected-model qualification](rust-selected-model-linux-arm64.json) |
| Engine connection isolation, target identity, typed capacity and inference failure recovery | [Preparatory fixtures and read-only Docker checks](rust-engine-preparation-linux-arm64.json); [rootless Podman proof](rust-podman-rootless-linux-arm64.json) qualifies the external gateway/sandbox path |
| Linux ARM64/x64, macOS ARM64/Intel, Windows x64 bundles | [Five native jobs](rust-native-platforms.json); real OpenTofu and production provider execution on each target |

These records describe their named revisions, including earlier schemas and runtime images.
They do not assert that the current checkout reran each live test.

The retained platform and live records identify the separate execution gates; ignored tests are not counted as passes.

The Ollama recovery change adds independent storage and permits destroy with retained model data.
Older deployments must apply their original YAML to establish that storage binding before destroy.
Refer to [destroy behavior](../usage.md#destroy).

Native channel credentials and persistent sandbox mounts are not provisioned by this schema.
Invocation replay and conversation recovery are not provided.
Native bundle tests do not establish Podman or GPU compatibility across all operating systems.

The selected-model validation additionally qualifies Fabric OpenClaw with a managed gateway and managed vLLM inference.
It does not extend that live result to every Fabric harness or model.

[SSH engine transport evidence](rust-ssh-linux-arm64.json) covers real loopback SSH identity, failure classification and artifact transfers.
It does not qualify remote managed deployment.

[Remote service evidence](rust-remote-service-linux-arm64.json) records the bundled SSH model lifecycle fixtures and real read-only host collector.
A separate-host GPU apply and agent reply remain an explicit qualification gate.

[Live two-daemon qualification](rust-dual-daemon-linux-arm64.json) exercises an SSH-managed Qwen3-4B service with native rootless Podman OpenClaw, real replies, policy denial, retained downloads, protection-trip recovery, engine retarget rejection, no-op/export and destroy.
Both daemons share the same DGX Spark.

[Inline recipe qualification](rust-inline-recipes-linux-arm64.json) covers a declared Qwen3.8 PLE recipe and ordinary Qwen3-4B using the same runtime source: actual Fabric OpenClaw replies, unchanged apply, export/reapply, verified cache import, safe capacity rejection, and teardown with retained storage.
It also records the deterministic verification and provider failure boundaries.

[Built-in recipe removal](rust-recipe-removal-linux-arm64.json) records rebuilt runtime artifacts, rejected compatibility paths, and agent replies from both the inline recipe and ordinary vLLM.
The record identifies the tested source revision and retained-data checks.

The [initial runtime artifact build](rust-runtime-artifact-linux-arm64.json) records an intermediate build without superseding the lifecycle evidence above.
