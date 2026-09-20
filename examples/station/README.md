<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station vLLM Example

Use [vllm.yaml](vllm.yaml) to run OpenClaw with a managed Qwen3-4B vLLM service on one Linux ARM64 DGX Station with one GB300 GPU.
This example covers that exact combination and does not qualify other DGX Station models, GPU counts, agents, models, or container engines.

## Check the Host

The host must provide Ubuntu 24.04, ARM64, one NVIDIA GB300 with compute capability 10.3, driver major 580 or newer, and Docker with the containerd image store enabled.
The `dgx-station` profile requires observable dedicated GPU-memory counters and rejects additional visible GPUs.
Confirm that ports 17696 and 18899 are unused and that `172.30.131.0/24` does not overlap a host route or Docker network.
Stop or resize only workloads you own before reserving GPU capacity.

The [hardware profile reference](../../docs/models.md#choose-a-hardware-profile) defines the admission checks.
The [retained validation record](../../docs/validation/dgx-station-qwen3-openclaw-linux-arm64.md) identifies the exact revisions and environments tested.

## Build the ARM64 Artifacts

Run these commands from the repository root on the Station:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/vllm/build.json
IMAGE_PREFIX=nc-fabric AGENT_PLATFORM=linux/arm64 docker buildx bake openclaw --load
cargo run -p nemoclaw-build -- bundle
```

The runtime build reports its immutable image reference.
Use `docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'` to identify the loaded OpenClaw image digest.
Do not apply the committed zero digests; they are required replacement markers, not runnable images.

## Create an Owned Deployment

Copy the example into a deployment directory:

```sh
mkdir -p .local/station-demo
cp examples/station/vllm.yaml .local/station-demo/deployment.yaml
```

Edit the copy before running NemoClaw:

1. Assign a fresh `metadata.uid`.
2. Replace both zero image digests with the immutable runtime and OpenClaw image references built from the same checkout.
3. Select unused gateway and inference ports when the defaults are occupied.
4. Select a nonoverlapping gateway `/24` when the default CIDR conflicts with the host.

Keep the Qwen3-4B repository revision pinned.
Do not embed credentials, hostnames, or host addresses in the deployment file.
The service generates and retains its private key under the [managed bearer-authentication contract](../../docs/inference.md#authenticate-a-managed-vllm-service).

## Run and Verify the Lifecycle

Run the current Linux ARM64 bundle from the repository root:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/station-demo/state .local/station-demo/deployment.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/station-demo/state .local/station-demo/deployment.yaml
```

Planning performs the hardware, image, network, and capacity checks without creating runtime resources.
Applying downloads the pinned model snapshot, starts managed vLLM and OpenClaw, and may take several minutes.
Apply verifies readiness but does not request an agent response.
Use the [headless OpenClaw request procedure](../../docs/agents.md#run-one-headless-openclaw-request) to verify inference separately.

Check convergence and the export round trip:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/station-demo/state .local/station-demo/deployment.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/station-demo/state .local/station-demo/deployment.yaml
dist/linux_arm64/bin/nemoclaw export --state-dir .local/station-demo/state --output .local/station-demo/exported.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/station-demo/state .local/station-demo/exported.yaml
```

The unchanged plan reports no resource changes, and both unchanged applies report an empty change list.
If apply fails, retain the state directory and follow the [runtime diagnostic procedure](../../docs/models.md#diagnose-and-recover-a-stopped-runtime) before retrying the original configuration.

Destroy the test-owned workloads when validation is complete:

```sh
dist/linux_arm64/bin/nemoclaw destroy --state-dir .local/station-demo/state
```

Destroy retains model downloads, generated inference authentication, and gateway storage under the [retention contract](../../docs/state.md#deletion-and-retention).
Verify the recorded resource identities before removing retained data manually.

## Qualification Boundary

Parser, schema, compiled topology, explicit image pins, and `dgx-station` profile selection are checked by the Rust tests.
The retained live run based on v1 commit `ba2e41fbb093f764d07774bb5a920e99e55daedf` exercised this service configuration and full lifecycle on 2026-09-19.
A release candidate still requires its own run because that result covers only the recorded source and environment.
