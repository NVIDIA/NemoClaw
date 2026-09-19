<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Select a Managed Model

Declare a named service under `spec.services` with `kind: vllm` for a public Hugging Face model that the pinned vLLM image can load natively.
Set its `model.repository` and an exact 40-character commit in `model.revision`.
Select it from an inference provider with `serviceRef: <name>`.
The fields below belong to that named service.
There is no repository allowlist.

## Choose a Model and Capacity

| Decision | Check before apply |
|---|---|
| Request API and agent | The [harness/API combination](inference.md#choose-the-request-api) accepts the model's serving protocol |
| Weights and format | Public repository, immutable revision, and files accepted by the resolver described below |
| Runtime compatibility | The pinned vLLM image can load the model without unsupported repository code or format conversion |
| Hardware and placement | The selected engine host satisfies the declared hardware contract; use [SSH placement](remote-service.md) when needed |
| Capacity and context | Weight size, runtime memory, KV cache, context length, and concurrency fit the configured host/GPU budget |
| Agent limits and tools | Native agent context/output/reasoning settings agree with the server and model; parser acceptance is not a tool-use qualification |

Start with a model/configuration covered by [recorded test results](validation/README.md), then verify it against your current images and host.
Older test results do not establish support across an entire release.
For an external endpoint, its operator owns installation and capacity; use [external inference configuration](inference.md#prepare-an-external-endpoint) instead of the managed-model fields below.

## Pin and Serve the Model

Mutable branches and tags are rejected so a later apply cannot silently change weights.
The OpenShell route's model must match `serving.modelName` when declared, or the repository name when it is omitted.

Choose a scenario from the [DGX Spark examples](../examples/spark/README.md), including small Pi, multiple agents, shared inference, two local models, and a hosted model.
The original ordinary-vLLM configuration is [examples/spark/vllm.yaml](../examples/spark/vllm.yaml).
Its image digest refers to a locally built artifact, not a published registry image.
Build the runtime locally and use the digest reported by your build.

Follow [the runtime image build procedure](build.md#build-a-runtime-image) and use the immutable OCI manifest digest from the build output.
This image contains the shared supervisor and unpatched vLLM, with retained source and license notices.
It contains no model weights or model-specific preparation tools.

The resolver reads the commit's inventory and verifies small files against Git blob hashes.
Weight downloads use the inventory's LFS SHA-256 hashes.
The native safetensors, configuration, tokenizer, license and notice files at the repository root form the inference snapshot.

Python repository code is not executed.
Gated repositories, custom remote-code models, GGUF, and nested checkpoint layouts are outside this first generic backend.

`memory.gpuMemoryGiB` budgets the model, runtime and KV cache together; its default is 16 GiB.
`kvCacheGiB` is part of that budget.
Capacity checks reject snapshots whose weights cannot fit the declared budget.
Declare exactly one of `hardware` or `recipe`; there is no implicit hardware profile.
For ordinary models on DGX Spark, select the existing Linux ARM64 contract explicitly:

```yaml
# Under spec.services.<name>:
hardware:
  profile: dgx-spark
```

This profile requires one NVIDIA GB10 with observed compute capability at least 12.1, at least 118 GiB host RAM, and driver major 580 or newer.
For other hardware, select a [named profile](#choose-a-hardware-profile) or declare [dedicated GPU requirements](#configure-nemotron-on-an-amd64-gpu-host).
An inline recipe supplies its own compatibility requirements and excludes `hardware`.

Older YAML that omitted both fields or used `profile: spark` is rejected; use `profile: dgx-spark` when preserving that configuration's hardware contract.
Retained intent is not migrated by editing input YAML; keep the matching previous bundle for existing deployments' export or teardown.

Backend startup still establishes actual model compatibility.

Optional `serving.toolParser` and `serving.reasoningParser` select native vLLM parsers.
Unsupported names are rejected.
`serving.mambaBackend: flashinfer` selects the native FlashInfer Mamba backend.
`serving.enforceEager: false` leaves compilation and CUDA graphs at vLLM's native defaults; omission retains eager execution.
Inline recipes supply their own model name and execution settings and reject these ordinary-service overrides.
There are no shell hooks, extra command arguments, or implicit model-specific settings.

### Retained Model Files

Snapshot directories include both repository and revision in their identity.
Each directory stores one `.nemoclaw-manifest.json` with format `version: 1`, repository, revision, and expected files.
Each file entry contains its name, size, SHA-256, and a `modified` timestamp after verification; `null` means unfinished.
Download progress does not change the model's identity.

The runtime saves the manifest atomically after each file passes checksum verification.
Interrupted downloads retain partial files for explicit apply to resume.
If a file was renamed before its manifest update was saved, apply verifies its checksum again without downloading it.
There are no separate per-file verification records or completion files.

Unchanged apply and export check the manifest and file metadata without fetching the inventory or weights again.
These size and timestamp checks reuse earlier verification; they do not rehash all model data.
A missing or changed verified file stops the operation without downloading a replacement or rewriting its manifest entry.

The model and recipe metadata formats require a matching CLI/provider bundle and runtime image built from this checkout.
Use a fresh deployment for these formats; older model manifests without a version and recipe `complete.json` files are not migrated automatically.
Keep the original bundle, runtime image, and state for existing deployments; do not delete metadata to bypass a format error.

Model changes replace the inference process while preserving its storage volume and previous snapshots.
Failed observation stops planning; failed startup retains the established container and model data.
A watchdog stop requires [explicit recovery](#diagnose-and-recover-a-stopped-runtime).

For models requiring preparation or patches, keep `kind: vllm` and declare an [inline recipe](recipes.md).
Package the recipe’s tools in the pinned runtime image.
There are no built-in model-specific backends.

## Choose a Hardware Profile

Named profiles check the GPU family, CPU architecture, driver, and memory on the selected execution host.
They do not choose a model, runtime image, or GPU count.
Every profile currently requires Linux, driver major 580 or newer, and exactly one GPU reported by the execution host's `nvidia-smi`; multi-GPU and multi-host serving are not implemented.
The collectors do not filter devices, so a DGX Station with an additional RTX/display GPU is rejected even when `CUDA_VISIBLE_DEVICES` selects only GB300.
The backend uses tensor parallel size 1.
GB200/GB300 profiles describe one observed GPU in a Grace Blackwell system; they do not enable a full compute tray or NVL72 rack.

| Profile | Hardware identity | Host architecture |
|---|---|---|
| `dgx-spark` | GB10 with unified host/GPU memory | ARM64 |
| `dgx-station` | GB300 GPU on ARM64; intended for current DGX Station | ARM64 |
| `gb200`, `gb300`, `gh200` | Corresponding Grace Blackwell or Grace Hopper GPU family | ARM64 |
| `h100`, `h200`, `a100`, `a10`, `a10g`, `a40` | Corresponding NVIDIA GPU family | Explicit `amd64` or `arm64` |
| `l4`, `l40`, `l40s`, `t4` | Corresponding NVIDIA GPU family | Explicit `amd64` or `arm64` |
| `rtx-6000-ada`, `rtx-pro-6000-blackwell` | RTX 6000 Ada or RTX PRO 6000 Blackwell | Explicit `amd64` or `arm64` |
| `rtx-3090`, `rtx-4090`, `rtx-5090` | Corresponding GeForce RTX GPU family | Explicit `amd64` or `arm64` |

System profiles fix ARM64; an optional `architecture` must agree.
They check GPU family and CPU architecture, not chassis identity; `dgx-station` shares the `gb300` checks and excludes earlier Volta and A100 Stations.
GPU-only profiles require `architecture` because GPU identity does not determine the host CPU.
There are no `spark`, `gb100`, or B100/B200/B300 profile names.

For example, declare an H100 on an AMD64 host and a fixed serving budget:

```yaml
# Under spec.services.<name>:
hardware:
  profile: h100
  architecture: amd64
memory:
  gpuMemoryGiB: 48
```

Every named profile requires an observed compute capability that meets its catalog minimum, including 12.1 for `dgx-spark`.
Compute capability is queried independently of GPU memory counters on both local and SSH hosts.
Missing, unsupported, or malformed compute capability stops the operation.

The profile's memory architecture determines capacity accounting:

| Memory architecture | Serving budget and observations |
|---|---|
| Unified (`dgx-spark`) | CPU and GPU share system RAM; use host total/available memory and preserve the host reserve. Dedicated framebuffer counters may report `N/A`. |
| Dedicated (the other current profiles) | Use GPU total/free counters for serving and measure host RAM separately, including on ARM64 Grace systems. Unsupported GPU counters reject the configuration; host RAM is never substituted. |

The collectors preserve an explicit unsupported-counter result; they do not infer unified memory from `N/A` or from a GPU name.
Failed queries and malformed or partial counter responses stop the operation for either memory architecture.
NVIDIA documents why [DGX Spark has no dedicated framebuffer memory](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html#nvidia-smi-reports-memory-usage-not-supported).
DGX Station's coherent CPU/GPU address space is not treated as a combined serving budget.
Its [memory mode](https://docs.nvidia.com/dgx/dgx-station-development-guide/coherency.html) must expose the dedicated counters; NemoClaw does not change the host's driver or memory mode.

Dedicated-memory profiles require at least 4 GiB of GPU memory, but do not assume a SKU's advertised capacity.
Set `hardware.minGpuMemoryBytes` to require more.
This field is required with fractional allocation so snapshot validation has a declared minimum:

```yaml
# Under spec.services.<name>:
hardware:
  profile: h100
  architecture: amd64
  minGpuMemoryBytes: 68719476736 # 64 GiB
memory:
  gpuMemoryUtilization: 0.75
```

This example checks weights against a 48 GiB budget derived from the declared minimum, then uses 75% of observed GPU capacity for serving.
It rejects GPUs below the declared 64 GiB minimum.
Omit fixed GPU and KV-cache budgets in fractional mode.
Unified-memory profiles reject both `minGpuMemoryBytes` and fractional allocation and retain host-memory reserve checks.
All profiles retain the resident host-memory watchdog.

The [profile catalog](../crates/nemoclaw-sdk/src/services/installers/vllm/hardware_profile.rs) uses NVIDIA's [compute-capability table](https://developer.nvidia.com/cuda/gpus) and current [DGX Station specification](https://www.nvidia.com/en-us/products/workstations/dgx-station/), checked on 2026-09-18.
[Profile tests](../crates/nemoclaw-sdk/tests/hardware_profiles.rs) cover schema/parser agreement, GPU-family mismatches, architecture selection, and memory checks using fixtures.
Live model/image qualification on the newly named hardware remains **TBD**; profile acceptance does not establish successful inference or support for every GPU SKU, quantization format, or host architecture.

## Diagnose and Recover a Stopped Runtime

The managed vLLM supervisor continues checking host memory after the CLI exits.
It stops its inference process on sustained pressure, failed memory observations, startup timeout, or an operator stop, and does not automatically restart inference.
A native process exit also ends supervision of that process.
The model volume retains `/data/status.json` with `phase`, `detail`, `updated` (UTC timestamp), and `pid`.
Phases are `initializing`, `downloading`, `preparing`, `loading`, `ready`, and `stopped`.
Read `detail` with the timestamp: a `ready` file from an earlier container start does not prove current readiness.

Collect diagnostics on the execution host using Docker access to the same engine selected by the deployment.
For SSH placement, connect to that host using the already configured SSH identity; do not substitute the client's local Docker daemon.
From any directory, set the engine socket and container name for this deployment:

```sh
model_engine=unix:///var/run/docker.sock
model_container=REPLACE_WITH_WORKSPACE-inference-SERVICE_NAME
docker --host "$model_engine" inspect "$model_container" --format '{{.Id}} {{json .Config.Labels}}'
```

Replace the socket when your selected daemon uses another path, and use the [UID-derived workspace](interfaces.md#select-the-gateway-and-workspace) and the service name in the container name.
Confirm the `nemoclaw.nvidia.com/uid` label matches your YAML before collecting its output.
This name/label check helps select diagnostics; it does not replace the SDK's generation and durable-identity checks or authorize manual mutation.

```sh
diagnostic_dir=$(mktemp -d)
docker --host "$model_engine" cp "$model_container:/data/status.json" "$diagnostic_dir/status.json"
docker --host "$model_engine" logs --tail 100 "$model_container" > "$diagnostic_dir/runtime.log" 2>&1
printf 'Diagnostics: %s\n' "$diagnostic_dir"
```

These commands read the selected container, including a stopped container, and write local diagnostic files.
The container log includes supervisor diagnostics and inherited native process output; inspect it privately before sharing.
If status is missing or the engine is unreachable, retain the original apply error and deployment state; failed observation does not prove resource absence.

| Stop detail | Recovery decision |
|---|---|
| Host memory pressure | Restore host headroom; reduce only workloads you own or ask the host operator; do not disable protection |
| Memory observation failed or sample stream closed | Restore the host observation prerequisites; increasing a timeout does not fix an unreadable memory source |
| Loading exceeded startup budget | Inspect backend output for loading/capacity errors before considering a supported startup-budget change |
| Inference process exited | Diagnose the native error using runtime logs, the selected model and image, and the recipe configuration |
| Operator stop or protection trip | Establish why the stop was requested before explicitly resuming inference |

After correcting the conditions, follow [interrupted-operation recovery](usage.md#recover-an-interrupted-operation) from the client with the original YAML, bundle, and state directory.
An unfinished apply must first reconcile that exact intent; do not change its timeout/model settings to bypass the guard.
For a completed deployment, preview any proposed configuration change and follow the normal runtime replacement rules.
Successful recovery must pass configuration and service readiness checks.
Verify a native agent reply separately using [inference verification](inference.md#verify-the-result).
No recovery step requires deleting manifests, keys, volumes, or ownership bindings.

The [runtime reporter](../crates/nemoclaw-runtime/src/services/installers/vllm/runtime.rs), [supervisor](../crates/nemoclaw-runtime/src/supervisor.rs), and [SDK artifact reader](../crates/nemoclaw-sdk/src/services/installers/vllm/artifacts.rs) define these diagnostics and failure boundaries.

## Configure Nemotron on an AMD64 GPU Host

[The Nemotron example](../examples/nemotron-amd64.yaml) declares the pinned NVIDIA Nemotron 3.5 Lightning 30B-A3B NVFP4 model, served name, native parsers, 65,536-token context, one sequence, and 4,096-token batch.
Its source pins and adaptation are recorded in the [AMD64 runtime notice](../runtimes/vllm-amd64/NOTICE.md).
It uses ordinary `kind: vllm` serving with no preparation recipe.

The example requires an existing OpenShell gateway and a Linux AMD64 Docker host reached through SSH.
That host must expose exactly one NVIDIA GPU with compute capability at least 9.0, at least 96,000,000,000 bytes of dedicated GPU memory, and driver major 580 or newer.
Follow the [SSH placement prerequisites](remote-service.md), build the [AMD64 runtime image](build.md#build-a-runtime-image) on a matching host, and load it into the selected Docker daemon.
Replace the zero image digest, SSH alias, gateway endpoint, private publication address, and deployment UID before applying.
Build a compatible OpenClaw sandbox image using the [Fabric image procedure](inference.md#build-an-image-with-the-configuration-interface), replace `sandboxes[].image.ref` with its immutable digest, and load that image into the gateway's Podman daemon.

`hardware` declares the dedicated-GPU requirements.
`memory.gpuMemoryUtilization: 0.75` allocates a fraction of the observed GPU memory and leaves KV-cache sizing to vLLM.
Omit `gpuMemoryGiB` and `kvCacheGiB` in this mode; nonzero fixed budgets are rejected.
The SDK checks snapshot weight size against the fraction of the declared minimum GPU memory and checks startup allocation against the observed total and free GPU memory.
Host RAM is measured separately: the default 32 GiB reserve plus 20 GiB startup headroom must be available, and the resident host-memory watchdog remains active.
A running service's allocation does not count as missing startup headroom during refresh.

The example selects `container.ipc: host`, sharing the execution host's IPC namespace.
Its declared 32 GiB shared-memory setting is retained in the container launch contract; host IPC uses the host's existing shared-memory mount.
Omitting `container` preserves private IPC with an 8 GiB shared-memory allocation.
The service uses [generated bearer authentication](inference.md#authenticate-a-managed-vllm-service).

Schema, argument, capacity, SSH observation, and build-platform tests cover these contracts.
They do not establish AMD64 image or GPU inference qualification; successful model loading and an agent response remain required on the target host.
