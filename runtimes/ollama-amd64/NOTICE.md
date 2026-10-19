<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Ollama Runtime Sources

This artifact extends the upstream Ollama 0.40.6 image, pinned by the multi-platform manifest digest in its Dockerfile.
The overlay retains the unmodified Ollama MIT license at `/opt/nemoclaw/source/ollama-LICENSE`, downloaded with a pinned SHA-256 in `build.json`.
It preserves the base image filesystem and does not replace existing upstream notices.
[Ollama 0.40.6](https://github.com/ollama/ollama/tree/v0.40.6) is distributed under its [MIT license](https://github.com/ollama/ollama/blob/v0.40.6/LICENSE).

The NemoClaw integration added on 2026-09-18 supplies the shared supervisor and selects it as the entrypoint.
It does not patch Ollama source.
The upstream source revision is `2476d5ead197abe04629651028f83d48dc75d2b2`.
The runtime uses the upstream pull, show, and inventory APIs, environment configuration, the load-only generate API, and the process inventory API.
The process inventory reports GPU residency using the same total/VRAM comparison as the upstream `ollama ps` command.

The retained supervisor archive contains the exact Rust sources, vendored dependency sources and notices, and build metadata used by this artifact.
The runtime verifies pinned model manifests and blobs in persistent storage before starting Ollama.
Model licenses remain with the registry snapshot; they are not replaced by the supervisor license.

Deterministic tests cover the adapter and shared lifecycle.
Live GPU inference qualification of this artifact remains TBD; an upstream image pin and successful build alone do not qualify a GPU or model.
