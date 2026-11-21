<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuring a Container Service

Use `kind: container` to run an image-owned application on a managed local Docker gateway.
The image supplies its entrypoint, application configuration, and health behavior.
NemoClaw deploys it but doesn't interpret application-specific environment variables.
This container path doesn't support Podman or Kubernetes service placement.
The typed `ollama` and `vllm` kinds retain their own model preparation, credentials, readiness checks, and storage policies.
A generic container doesn't inherit them.

## Supplying Inputs

The container image owns its application behavior.
Configure the inputs NemoClaw needs to install and check it.

| Input | Behavior |
|---|---|
| `image` | Immutable OCI reference compatible with the host. |
| `command` | Optional arguments to the image entrypoint; no shell expansion. |
| `environment` | Literal strings; no host-variable expansion or protected credential delivery. Values enter configuration, plans, state, exports, and Docker inspection. |
| `files` | Nonsecret files uploaded before startup with mode 0444. Contents enter plans and state; these aren't immutable mounts. |
| `container` | CPU, memory, GPU, IPC, shared-memory, and process limits for the placement, not managed-model memory budgets. |
| `user` | Numeric UID:GID; defaults to 65532:65532. Root must be explicit. |
| `port` and `publication` | The application listener used for probing, and optional published host address and port. The application must listen on the declared port. |
| `readiness` | HTTP `path`, managed `runtimeStatus`, or, when omitted, the image's Docker HEALTHCHECK. A passing probe doesn't establish an agent reply. |
| `data` | Disposable writable volume at `mountPath`, default `/data`. |

For an HTTP readiness path, the application must return HTTP 200 only when it can accept its supported requests.
Return a non-success status while loading.
Without a path or runtime-status selection, the image must supply a Docker HEALTHCHECK.
A service referenced by an inference `serviceRef` needs an address reachable from NVIDIA OpenShell, at base path `/v1`, and registration waits for readiness.
See [inference](../agents-inference/inference.md) for authentication and API compatibility requirements.

## Protecting Application Credentials

Don't put secrets in a shared YAML file.
An `environment` value is literal, even if it looks like `${API_KEY}`.
There is no automatic resolution or generic `secrets` field.
If an application requires a literal key, use private local configuration and protect the resulting plan, state, export, and Docker metadata.
Removing a container doesn't revoke a credential or erase retained copies.
Prefer a typed managed service when you need its credential and storage safeguards.
Refer to [security](../security/security.md) and [state](state.md) for ownership and retention.

## Deciding Whether the Image Fits

A running container doesn't establish application readiness, and readiness doesn't establish successful inference or an agent response.
Generic services use disposable application storage.
Replacement or destroy can lose its data.
Before switching from `ollama` or `vllm`, check the managed model's hardware, readiness, authentication, cache, and retention requirements in [model services](../agents-inference/models.md).
There is no automatic state migration between service kinds.

This user-facing contract follows the container decision in the inspected `origin/v1` revision `1636069b91f402242a35714fde1011042c3f1f70` ([design rationale](../../internal-docs/design/container-contract.md)).
It describes the declared container boundary, not a live qualification of an arbitrary application image.
