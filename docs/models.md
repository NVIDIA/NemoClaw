<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Select a Managed Model

Use `service.backend: vllm` for a public Hugging Face model that the pinned vLLM image can load natively.
Set `service.model.repository` and an exact 40-character commit in `service.model.revision`.
There is no repository allowlist.

Mutable branches and tags are rejected so a later apply cannot silently change weights.
The OpenShell route's model must match the repository name.

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
Capacity checks reject snapshots whose weights cannot fit the declared budget and retain the existing DGX Spark host checks.
This adds model choice on the qualified Linux ARM64 GB10 host, not a new hardware platform.

Backend startup still establishes actual model compatibility.

Optional `serving.toolParser` and `serving.reasoningParser` select native vLLM parsers.
Unsupported names are rejected.
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
