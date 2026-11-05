<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configure a Container Service

Use `kind: container` to run an image-owned application on a managed local Docker gateway. The image supplies its entrypoint, application configuration, and health behavior; NemoClaw deploys it but does not interpret application-specific environment variables. Podman and Kubernetes service placement are not supported by this container path. The typed `ollama` and `vllm` kinds retain their own model preparation, credentials, readiness checks, and storage policies; a generic container does not inherit them.

## Supply Inputs

The container image owns its application behavior; configure the inputs NemoClaw needs to install and check it.

| Input | Behavior |
|---|---|
| `image` | Immutable OCI reference compatible with the host. |
| `command` | Optional arguments to the image entrypoint; no shell expansion. |
| `environment` | Literal strings; no host-variable expansion or protected credential delivery. Values enter configuration, plans, state, exports, and Docker inspection. |
| `files` | Nonsecret files uploaded before startup with mode 0444. Contents enter plans and state; these are not immutable mounts. |
| `container` | CPU, memory, GPU, IPC, shared-memory, and process limits for the placement, not managed-model memory budgets. |
| `user` | Numeric UID:GID; defaults to 65532:65532. Root must be explicit. |
| `port` and `publication` | The application listener used for probing, and optional published host address and port. The application must listen on the declared port. |
| `readiness` | HTTP `path`, managed `runtimeStatus`, or, when omitted, the image's Docker HEALTHCHECK. A passing probe does not establish an agent reply. |
| `data` | Disposable writable volume at `mountPath`, default `/data`. |

For an HTTP readiness path, the application must return HTTP 200 only when it can accept its supported requests; return a non-success status while loading. Without a path or runtime-status selection, the image must supply a Docker HEALTHCHECK. A service referenced by an inference `serviceRef` needs an address reachable from OpenShell, at base path `/v1`, and registration waits for readiness. See [inference](../agents-inference/inference.md) for authentication and API compatibility requirements.

## Protect Application Credentials

Do not put secrets in a shared YAML file. An `environment` value is literal, even if it looks like `${API_KEY}`; there is no automatic resolution or generic `secrets` field. If an application requires a literal key, use private local configuration and protect the resulting plan, state, export, and Docker metadata. Removing a container does not revoke a credential or erase retained copies. Prefer a typed managed service when its credential and storage safeguards are needed. Refer to [security](../security/security.md) and [state](state.md) for ownership and retention.

## Decide Whether the Image Fits

A running container does not establish application readiness, and readiness does not establish successful inference or an agent response. Generic services use disposable application storage; replacement or destroy can lose its data. Before switching from `ollama` or `vllm`, check the managed model's hardware, readiness, authentication, cache, and retention requirements in [model services](../agents-inference/models.md). There is no automatic state migration between service kinds.

This user-facing contract follows the container decision in the inspected `origin/v1` revision `86b8d94273a76a696e06b300dc29f7035b163667` ([design rationale](../../internal-docs/design/container-contract.md)). It describes the declared container boundary, not a live qualification of an arbitrary application image.
