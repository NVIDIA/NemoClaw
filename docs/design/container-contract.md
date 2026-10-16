<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Container Service Contract v1

This contract lets an application image run as a YAML service without an application-specific NemoClaw installer.
It also defines the container base shared by managed Ollama and vLLM.

Decision: **Accept**, authorized by San Dang in the container-contract discussion.
Reason: share container deployment without removing managed inference safeguards or teaching the SDK every application's configuration.
Placement: the SDK container installer and existing Docker/OpenTofu resource compiler.
Scope update: San Dang deferred protected-file delivery and accepted literal application environment values as a temporary approach.
This approach does not protect credentials from configuration, state, or Docker inspection.
Accountable NemoClaw maintainer: San Dang.
Validation: focused compiler and provider tests, existing inference lifecycle tests, and separate VoiceClaw qualification under [#12570](https://github.com/NVIDIA/NemoClaw/issues/12570).
This decision does not authorize image publication, live deployment, or a claim of VoiceClaw support.

## Status

[PR #13093](https://github.com/NVIDIA/NemoClaw/pull/13093) implements the container base without a protected-input dependency.
[PR #12619](https://github.com/NVIDIA/NemoClaw/pull/12619) is closed; generic credential-file delivery is deferred.
Use the generated [field reference](../reference/configuration.md) for YAML fields and defaults.
Compiler tests compare explicit `kind: container` configurations with the existing managed Ollama and vLLM launch settings.
These tests are not Linux GPU or VoiceClaw qualification.
The manual environment contract below replaces the earlier generated agent descriptor.

## Common Container Boundary

`kind: container` describes image-owned startup.
The image supplies an entrypoint, interprets its own configuration, and reports its own health.
NemoClaw deploys the container and supplies its declared inputs; it does not interpret application environment-variable names.

| Input | Contract |
|---|---|
| `image` | Immutable OCI image reference; choose an image compatible with the selected host. |
| `command` | Optional argument list passed to the image entrypoint; no implicit shell or secret substitution. |
| `environment` | Literal application strings, visible in configuration, plans/state, exports, and Docker inspection. No host-variable expansion or implicit connection injection. |
| `files` | Nonsecret application configuration uploaded before startup with mode 0444. Contents enter plans and state. These are files in the container, not immutable mounts; root can change them. |
| `container` | CPU, memory, GPU access, shared memory, IPC, and process limits supported by the selected placement. These are not model-memory budgets. |
| `user` | Numeric UID:GID; default 65532:65532. An image that requires root must explicitly request 0:0. GPU access and root are never inferred from the image name. |
| `port` | The application listener used to derive a probe address. The application must separately be configured to listen on that port. |
| `publication` | Optional host address and port; omission does not publish a host listener. |
| `readiness` | Choose HTTP `path` or managed `runtimeStatus`, with `timeoutSeconds`; omission uses Docker HEALTHCHECK. It never generates a model response or starts an agent task. |
| `data` | Disposable writable volume at `mountPath`, default /data. The typed model kinds retain their existing storage policy. |

The initial generic application placement is the managed local Docker gateway's engine and network.
Podman and Kubernetes service placement require separate implementation and qualification; a gateway using either does not imply service support there.
Docker remains the owner of ordinary containers, images, and service networks.

## Process and Readiness

The application must handle SIGTERM and exit without an installer-owned restart loop.
A running container alone does not establish readiness.

For the agreed generic HTTP check, the application serves `GET /health` on its declared port.
HTTP 200 means the application can accept its supported requests; loading returns a non-success response such as 503.
NemoClaw waits within a timeout and retains failure information rather than reporting a failed check as success.
If no HTTP path or runtime-status path is selected, the image must supply a Docker HEALTHCHECK.
HTTP checks use the published address when present, otherwise the container's reported network address.
That address must be reachable from the provider process; Docker Desktop or remote network reachability is not implied.
A container selected by an inference `serviceRef` must publish a private address reachable by OpenShell; the backend base path is /v1.
Its registration waits for the container's readiness, and the caller's route supplies the model name.

An application whose agent is unavailable must return a bounded, actionable failure; it must not select another agent silently.
With manual connection settings, the operator creates and verifies the gateway and agent before deploying the application.
The generic container does not automatically wait for an agent named only in an environment variable.

## Application Environment

This phase supplies application settings through literal container environment values:

```yaml
environment:
  APP_API_KEY: "REPLACE_AT_DEPLOY_TIME"
```

The application reads `APP_API_KEY` directly from its process environment.
NemoClaw does not resolve `${APP_API_KEY}` from the caller's environment or accept `env` reference objects in this map.
There is no generic `secrets` field, credential publisher, or protected-file mount in this phase.

Putting a credential here is a temporary plaintext approach, not secret storage.
The value enters YAML, compiled plans/state, exports, and Docker container configuration; the application and engine administrators can read it.
Literal values are not automatically registered as protected credential references, so do not rely on diagnostic redaction.
Replace placeholders only in private local configuration; never commit real values or share resulting plans, state, exports, or logs.
The application must not copy credentials into browser code or responses.
Removing a container does not erase retained configuration, state history, backups, or logs, and does not revoke an upstream credential.
The operator owns those copies and upstream revocation; no credential rotation service is provided.

This decision does not change credential references for gateways and inference providers or the private storage of typed managed-model credentials.

## Manual VoiceClaw Connection

VoiceClaw implements these environment settings; they are not reserved SDK fields:

| Variable | Meaning |
|---|---|
| `VOICECLAW_PORT` | VoiceClaw's listener port, also used for `/health`. |
| `VOICECLAW_GATEWAY_URL` | The OpenShell gateway URL reachable from the application container, not necessarily the operator's management URL. |
| `VOICECLAW_WORKSPACE` | The selected workspace name. |
| `VOICECLAW_SANDBOX_NAME` | The selected sandbox name. |
| `VOICECLAW_SANDBOX_ID` | The expected physical sandbox identity. |
| `VOICECLAW_AGENT_NAME` | The agent to invoke in that sandbox. |
| `VOICECLAW_AUTH_MODE` | Explicit `none` for trusted local development, or `oidcBearer` for HTTPS with a service token. |
| `VOICECLAW_GATEWAY_TOKEN` | Required for `oidcBearer`; the application's service token supplied as a literal environment value, with the exposure described above. |
| `VOICECLAW_SPEECH_KEY` | Speech credential supplied as a literal environment value, with the exposure described above. |

VoiceClaw verifies the selected workspace, sandbox identity, and agent before invocation.
If identity changes or cannot be established, it stops that request rather than invoking another sandbox by name.
The pinned OpenShell API has no atomic ID precondition for name-addressed exec, so a pre-invocation check does not eliminate the replacement race; see [the SDK boundary](architecture.md#openshell-sdk-boundary).

`none` is plaintext without client authentication and is only for an explicitly trusted local deployment.
`oidcBearer` uses HTTPS with system certificate verification and the application's own service token.
Missing credentials, failed authentication, or TLS errors never trigger an unauthenticated fallback.
VoiceClaw owns token refresh behavior and request deadlines; NemoClaw does not issue or refresh the token.
A token's authority is determined by the gateway, not narrowed by these client settings.
Do not supply an operator's interactive credentials.

Example fragment for the agreed manual integration; the endpoint, workspace, and ID must be copied from the operator's deployment:

```yaml
environment:
  VOICECLAW_PORT: "18790"
  VOICECLAW_GATEWAY_URL: "http://172.29.230.2:17681"
  VOICECLAW_WORKSPACE: "ACTUAL_WORKSPACE"
  VOICECLAW_SANDBOX_NAME: assistant
  VOICECLAW_SANDBOX_ID: "ACTUAL_SANDBOX_ID"
  VOICECLAW_AGENT_NAME: main
  VOICECLAW_AUTH_MODE: none
  VOICECLAW_SPEECH_KEY: "REPLACE_AT_DEPLOY_TIME"
```

There is no `agentConnection`, environment `from`, or generated connection descriptor in the target contract.
VoiceClaw must not require `/run/nemoclaw/agent-connection.json` to start.

## Ollama and vLLM Specialize the Base

“Inherit” means composition in Rust, not a new YAML `extends` feature or a plugin framework.
All three kinds reuse container process settings, owned target assembly, and the Docker compiler.
Ollama and vLLM add their existing runtime configuration and companion resources before using that base.

`kind: ollama` and `kind: vllm` remain convenience frontends, not exclusive deployment capabilities.
They expand typed settings and defaults into the same container base that users can configure explicitly with `kind: container`.
Keep `hardware`, `model`, `serving`, `memory`, image acquisition, placement, update policy, and retained storage behavior.
The runtime still validates hardware, prepares pinned models, observes native readiness, and protects memory after apply exits.
The `ollama` and `vllm` OpenTofu providers remain the owners of their runtime-specific resources and observations.

For example, these settings do not become generic Docker limits:

```yaml
hardware:
  profile: dgx-spark
memory:
  gpuMemoryGiB: 20
  kvCacheGiB: 6
  hostReserveGiB: 32
```

`gpuMemoryGiB` is a serving budget; `kvCacheGiB` controls vLLM's cache; `hostReserveGiB` participates in host-capacity policy.
`container.gpu` exposes devices; `container.memoryLimitGiB` limits container memory, not portable GPU VRAM.
Keep the watchdog's other thresholds and the distinction between dedicated and unified memory.

The managed images already accept nonsecret JSON through `NEMOCLAW_RUNTIME_SPEC`.
Users of the typed kinds need not author that JSON: their installer continues to construct it.
Direct generic use of a managed image needs its complete validated runtime configuration, writable `/data`, resource requirements, and equivalent managed readiness.
A plain HTTP check is not a substitute for Ollama's selected-model checks or fresh managed-runtime status.
The explicit container form must have access to equivalent managed readiness before it can replace either convenience form.
`readiness.runtimeStatus: /data/status.json` reads the existing managed-runtime report without parsing application settings.
It requires a running, identity-matched container and a ready report whose timestamp is not older than that container's start.
It rejects malformed and stopped reports and waits within the timeout for loading or stale reports.
Typed services keep their existing readiness and authentication checks; generic `serviceRef` currently describes an unauthenticated private /v1 endpoint.

The managed image must enforce the same hardware compatibility and memory watchdog in both forms.
No application-name detection or inspection of arbitrary environment keys may select a hidden installer.
Raw containers intentionally do not inherit typed-model cache retention, generated authentication, image-contract admission, or updatePolicy defaults.
Use the typed kind when those managed conveniences are required; this is not an in-place state migration between kinds.

## Storage and Qualification

The initial generic path does not add persistence policy or migrate any existing deployment's storage.
Disposable application storage can be lost on replacement or destroy; model downloads in disposable storage may need repeating.
Existing managed Ollama/vLLM caches and credential storage retain their established lifetimes.

After implementing the VoiceClaw interface, report its source revision, image digest, platform, and accepted settings.
Qualification under #12570 must prove a post-apply turn reaches the selected agent and returns its response.
It must also cover unavailable or replaced agents, authentication failures, interruption/retry, and owned cleanup.
A healthy container, parser fixture, or successful HTTP probe alone is not that qualification.
