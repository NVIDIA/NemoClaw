<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker Provider Lifecycle on Linux ARM64

All nine explicitly configured lifecycle tests passed, including both runtime graphs in the CPU test.
The tested source is `7c052dcbfc30b29f5e226280f9b40aa29a17009b`, bundled as `0.1.0-dev.4b4425deb494de61` on 2026-09-19.
The environment uses Linux ARM64, Docker Engine 29.2.1, Rust 1.98.1, OpenTofu 1.12.6, and the pinned Docker provider 4.6.0.
The normal bundle build supplies both the NemoClaw and Docker providers.

## Checks

Workspace formatting, Clippy with warnings denied, and `cargo test --workspace` passed.
Ignored tests in that workspace run do not count as live results.
The documentation check passed with zero errors and one existing Fern warning; the changed documentation received an independent review.
The explicitly configured lifecycle runs use the [fixture commands](../testing/fixtures.md).

| Fixture | Behavior exercised | Result |
|---|---|---|
| `remote_service` | Seven bundled CLI/OpenTofu cases with synthetic Docker-over-SSH and OpenShell: failed creation, recovery, authenticated readiness, image replacement, no-op/export/reapply, retained storage, and partial destroy | Passed |
| `docker_provider_proxy` | Real local Docker and proxy process with an OpenShell fixture: image replacement, missing/stopped container recovery, readiness failure, credential permissions, and absent/foreign/substituted storage rejection | Passed |
| `cpu_runtime_provider_reconciles_compute_and_retains_data` | Both production runtime graphs with CPU fixtures: raw container IDs, replacement, network recreation, retained sentinel data, and teardown | Passed |

The proxy test retains the same credential volume and key across an image-only replacement and verifies that OpenShell resources do not change.
The CPU test retains the production command, environment, mounts, network, and dependencies, while substituting a local engine, CPU limits, and localhost publication.
Its fixture runtime writes status and does not load a model.
Destroy removes disposable containers and networks while retaining durable volumes.

## Image Inputs and Limits

The existing local proxy image was `nc-fabric@sha256:f3b2b22d01fe9baf7946266f437773bdf1e5871cc8b0b6d17ce60d740882148e`.
Local CPU fixture images derived from that image added a status-writing executable and backend label:

- Ollama: `sha256:a83e18979448440d337d7849ae2cefa17cb174edd44e05f506d066ec95188392`.
- vLLM: `sha256:486b434dd1bf3a7f547b7ad2db7a6e67da158108b66591f7f8fd4ab2ced60768`.

The Ollama fixture also supplied the proxy replacement image, using the real proxy entrypoint.
These images were loaded locally and were not published.
Tests used distinct deployment identities and cleaned up only their own resources.

This qualification does not establish GPU inference, model preparation, a live OpenShell server, sandbox inference, or other platforms.
Historical GPU results elsewhere in this directory describe their original custom-controller revisions.
The new deployment state is version 4; versions 1–3 require their original bundle and are rejected without mutation by this implementation.
See [deployment state](../state.md) for recovery requirements.
