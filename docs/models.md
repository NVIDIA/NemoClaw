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

A concrete configuration is in [examples/vllm.yaml](../examples/vllm.yaml).
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
A watchdog stop requires explicit apply to recover.

For models requiring preparation or patches, keep `backend: vllm` and declare an [inline recipe](recipes.md).
Package the recipe’s tools in the pinned runtime image.
There are no built-in model-specific backends.

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
