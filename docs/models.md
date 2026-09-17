<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Select a Managed Model

Use `service.backend: vllm` for a public Hugging Face model that the pinned vLLM image can load natively.
Set `service.model.repository` and an exact 40-character commit in `service.model.revision`.
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

Start with a model/configuration covered by [retained evidence](validation/README.md), then verify it against your current images and host.
Older evidence is not a release-wide support matrix.
For an external endpoint, its operator owns installation and capacity; use [external inference configuration](inference.md#prepare-an-external-endpoint) instead of the managed-model fields below.

## Pin and Serve the Model

Mutable branches and tags are rejected so a later apply cannot silently change weights.
The OpenShell route's model must match `serving.modelName` when declared, or the repository name when it is omitted.

Choose a scenario from the [DGX Spark examples](../examples/spark/README.md), including small Pi, multiple agents, shared inference, two local models, and a hosted oracle.
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
Without `service.hardware` or an inline recipe, the host must satisfy the existing Linux ARM64 GB10 Spark contract.

Backend startup still establishes actual model compatibility.

Optional `serving.toolParser` and `serving.reasoningParser` select native vLLM parsers.
Unsupported names are rejected.
`serving.mambaBackend: flashinfer` selects the native FlashInfer Mamba backend.
`serving.enforceEager: false` leaves compilation and CUDA graphs at vLLM's native defaults; omission retains eager execution.
Inline recipes supply their own model name and execution settings and reject these ordinary-service overrides.
There are no shell hooks, extra command arguments, or implicit model-specific settings.

Snapshot directories include both repository and revision in their identity.
The runtime retains the manifest, resumable partial files and completion receipt.
Unchanged apply and export verify local receipts and file metadata without fetching the inventory or weights again.

Model changes replace the inference process while preserving its storage volume and previous snapshots.
Failed observation stops planning; failed startup retains the established container and model data.
A watchdog stop requires [explicit recovery](#diagnose-and-recover-a-stopped-runtime).

For models requiring preparation or patches, keep `backend: vllm` and declare an [inline recipe](recipes.md).
Package the recipe’s tools in the pinned runtime image.
There are no built-in model-specific backends.

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
model_container=REPLACE_WITH_WORKSPACE-inference
docker --host "$model_engine" inspect "$model_container" --format '{{.Id}} {{json .Config.Labels}}'
```

Replace the socket when your selected daemon uses another path, and use the [UID-derived workspace](interfaces.md#select-the-gateway-and-workspace) in the container name.
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
| Inference process exited | Resolve the native error using the selected model, runtime image, and recipe evidence |
| Operator stop or protection trip | Establish why the stop was requested before explicitly resuming inference |

After correcting the conditions, follow [interrupted-operation recovery](usage.md#recover-an-interrupted-operation) from the client with the original YAML, bundle, and state directory.
An unfinished apply must first reconcile that exact intent; do not change its timeout/model settings to bypass the guard.
For a completed deployment, preview any proposed configuration change and follow the normal runtime replacement rules.
Successful recovery must pass configuration and service readiness checks.
Verify a native agent reply separately using [inference verification](inference.md#verify-the-result).
No recovery step requires deleting receipts, keys, volumes, or ownership bindings.

The [runtime reporter](../crates/nemoclaw-runtime/src/runtime.rs), [supervisor](../crates/nemoclaw-runtime/src/supervisor.rs), and [SDK status reader](../crates/nemoclaw-sdk/src/managed/artifacts.rs) define these diagnostics and failure boundaries.

## Configure Nemotron on an AMD64 GPU Host

[The Nemotron example](../examples/nemotron-amd64.yaml) declares the pinned NVIDIA Nemotron 3.5 Lightning 30B-A3B NVFP4 model, served name, native parsers, 65,536-token context, one sequence, and 4,096-token batch.
Its source pins and adaptation are recorded in the [AMD64 runtime notice](../runtimes/vllm-amd64/NOTICE.md).
It uses ordinary `backend: vllm` serving with no preparation recipe.

The example requires an existing OpenShell gateway and a Linux AMD64 Docker host reached through SSH.
That host must expose exactly one NVIDIA GPU with compute capability at least 9.0, at least 96,000,000,000 bytes of dedicated GPU memory, and driver major 580 or newer.
Follow the [SSH placement prerequisites](remote-service.md), build the [AMD64 runtime image](build.md#build-a-runtime-image) on a matching host, and load it into the selected Docker daemon.
Replace the zero image digest, SSH alias, gateway endpoint, private publication address, and deployment UID before applying.
Build a compatible OpenClaw sandbox image using the [Fabric image procedure](inference.md#build-an-image-with-the-configuration-interface), replace `sandboxes[].image.ref` with its immutable digest, and load that image into the gateway's Podman daemon.

`service.hardware` declares the dedicated-GPU requirements.
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
