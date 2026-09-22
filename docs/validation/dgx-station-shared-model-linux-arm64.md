<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Station Shared Qwen3-4B OpenClaw and Pi Test

This 2026-09-20 test exercised one Linux ARM64 DGX Station with one NVIDIA GB300.
It used one managed Qwen3-4B vLLM service and separate OpenClaw and Pi sandboxes.
It qualifies only the recorded sources and environment.

## Candidate and Environment

The run used v1 commit `524f0f260c12d494dc94c45b7f82af3b2aa2ae4c` and the proposed [shared-model example](../../examples/station/shared-model.yaml).
Its bundle version was `0.1.0-dev.2fde7b41db53cbd5`, and the CLI SHA-256 was `de478fbf173e7443af1dca83d59a3522c8dcf059cdbec8ebc80ae49178726ede`.
The run-only configuration replaced the example's image markers, deployment UID, ports, and gateway CIDR.
Its SHA-256 was `16104a83ad8d676d3e27156e73decd518a8621a18834e801a056f761e8ebab36`.

The host ran Ubuntu 24.04 on ARM64 with one NVIDIA GB300, driver 610.43.02, and 256703 MiB of dedicated GPU memory.
Docker used the containerd snapshotter.
An unrelated OpenShell workload remained healthy throughout the run.

The run used these locally built ARM64 images:

- runtime: `nc-prototype-vllm@sha256:9b7a5ddad7d7ecc143efd696ebd8bb914a75f10f02e55670092ca97eb14307c5`
- OpenClaw: `nc-fabric@sha256:934c8ee5c5b87e860b14f4f5ce2fcbea3172eb192a2a88a69f0038c172e00504`
- Pi: `nc-fabric@sha256:5392de6d19cd67ac71b6621fa18ee91d72909fc3a26d31a420518de87acb015f`

## Results

| Check | Result |
|---|---|
| Initial plan | Seven infrastructure creates; OpenShell registration and both sandboxes were deferred until the managed gateway existed |
| Initial apply | Twelve creates: one gateway, one Qwen3-4B service, one provider and profile, one workspace, and two sandboxes |
| Native OpenClaw request | Returned exactly `FOUR`; status `ok`; model `Qwen/Qwen3-4B`; no error, abort, fallback, or reroute |
| Native Pi request | Returned `FOUR`; status `succeeded`; harness `nvidia.fabric.pi`; no error |
| Shared-service identity | One inference service and one provider and profile pair served both separate sandboxes |
| Unchanged plan and apply | Plan reported no changes; apply returned an empty `changes` list |
| Export round trip | Export SHA-256 `9dd97fa025cdc20ab5ad20344c52d3c2958684837f41daa3572a2ab7f66c71f6`; exported plan and apply were unchanged |
| Credential boundary | The generated key had mode `600`, was absent from model storage, and was absent from exported YAML |
| Destroy | Removed eight disposable resources and retained the workspace, model cache, gateway storage, and inference authentication storage |
| Repeated destroy | Returned an empty `changes` list with the same four retained resources |

Apply reported `fabric_health_unsupported` for both sandboxes because the pinned Fabric does not implement `runtime.check_health()`.
The separate native requests established real responses from both agents.

After destroy, both test ports were free and GPU use returned to 22 MiB.
The unrelated OpenShell workload remained running and healthy.

## Qualification Boundary

This run did not test concurrent requests, deliberate process recovery, model-data identity across recovery, performance, reliability, multiple GPUs, multiple Stations, another model, or another inference runtime.
It does not qualify Deep Agents, Hermes, Station Express, or general DGX Station support.
