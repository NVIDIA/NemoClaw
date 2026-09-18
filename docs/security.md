<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review Security and Credential Ownership

Select controls for the actual sandbox image, engine host, gateway, and inference endpoint.
Parser acceptance and protocol fixtures do not establish security qualification on a deployment host.

## Isolation and Trust

OpenShell enforces the declared sandbox policy; Fabric runs the native agent within that sandbox.
Use [sandbox policy](sandbox-network.md) for filesystem, process, egress, and proxy configuration.
An explicit policy replaces the preset, and ordinary apply rejects policy changes that require sandbox replacement.

The isolated preset uses Landlock `best_effort`; unavailable restrictions are not enforced.
Each declared agent has its own OpenShell sandbox; tool grants do not further isolate processes or files within that sandbox.
See [agent tool restrictions](agents.md#agent-tool-restrictions).

Host-specific security qualification, enterprise hardening profiles, and a complete threat model: **TBD**.

### Identify the Trust Boundaries

| Actor or component | Access to account for |
|---|---|
| Client running the CLI/SDK | Reads declared credential references and TLS files, operates the deployment state, and starts the matched provider/OpenTofu processes |
| Docker/Podman host administrator | Controls containers, images, mounted storage, and process environments; container-local file permissions do not exclude this administrator |
| OpenShell gateway and supervisor proxy | Enforce the configured routing/policy and install or substitute provider credentials |
| Fabric and native agent inside a sandbox | Share the sandbox's permitted files, processes, and native credentials; the sandbox is the isolation boundary |
| Inference endpoint operator | Receives the requests routed to that endpoint |
| Recipe tools and runtime images | Execute within their declared runtime; select reviewed immutable artifacts and retain their source notices |

Before granting access, identify the destination, executing binary, files, and credentials the task needs.
Use [explicit network policy](sandbox-network.md#choose-a-policy) for an allowed destination; selecting an HTTP proxy alone does not grant egress.
An explicit policy replaces the entire preset, so retain the intended filesystem and process settings too.
Use a fresh deployment for policy or launch changes that ordinary apply refuses to replace.

## Credentials and Authentication

Each credential procedure must identify who supplies the value, where it persists, who can read it, and how it is retired.
Use the owning guide for the selected credential type:

| Credential or connection | Storage, access, and retirement | Owning procedure |
|---|---|---|
| Gateway bearer credential and mTLS files | Caller supplies environment values and local files; SDK/provider need access; gateway operator owns revocation, while the caller removes local values/files when no longer needed | [Configuration and credentials](usage.md#configuration-and-credentials) |
| External inference key, including Hermes provider authentication | Caller resolves the reference; OpenShell retains the installed value for routing; destroy removes the provider registration, not the upstream account/key | [Inference authentication](inference.md#authenticate-hermes-through-the-provider) |
| Generated managed vLLM key | Private file in retained model storage, available to runtime root and engine administrators; recreation reuses it; retiring the container does not erase the key | [Managed service authentication](inference.md#authenticate-a-managed-vllm-service) |
| Generated external-Ollama proxy key | Private credential volume, available to proxy root and engine administrators; retained across destroy/recreation and never forwarded to Ollama | [Ollama proxy](inference.md#use-external-ollama-through-a-managed-proxy) |
| Brave search key | Caller supplies the value; OpenShell holds it and replaces the agent's placeholder; destroy removes managed registrations but does not revoke the Brave key | [Brave web search](agents.md#brave-web-search) |
| Native OpenClaw/local Hermes interface tokens | Sandbox-user-readable native files; retained across process restarts, deleted with sandbox data; replace compromised credentials through a fresh deployment | [Agent interfaces](interfaces.md) |

Removing a caller's environment variable does not revoke an upstream key or erase a credential retained by a gateway.
Unchanged apply does not automatically detect changed values behind the same reference.
Managed private HTTP endpoints with bearer authentication do not provide TLS.

Corporate CA provisioning across client, image, gateway, and native runtimes: **TBD**.
A complete credential-rotation runbook for every credential type: **TBD**.
Use each existing guide's current lifecycle constraints; do not infer a rotation command.

Keep credential values out of YAML, shell arguments, shared URLs, and published diagnostics.
Onboarding saves credential references in YAML before requesting their values.
Generation-only onboarding never resolves credentials.
In composed interactive onboarding, accepting the authored YAML does not authorize apply: inspect the secret-free plan preview and answer the separate apply prompt.
`--non-interactive` is an explicit automation choice that requires environment-provided credentials and proceeds from a successful plan to apply without prompting.
Use environment references for provider secrets and protected files for gateway TLS keys.
Configuration export preserves references; it cannot recover a lost credential value.
Retiring a deployment requires separate decisions about upstream revocation, retained gateway/model/proxy storage, and caller-owned files.

### Separate the TLS Connections

| Connection | Current configuration boundary |
|---|---|
| Client to OpenShell gateway | HTTPS uses trust verification; optional `gateway.tls` selects CA, client certificate, and key through environment references to file paths |
| OpenShell to external inference | Caller-provided inference keys require HTTPS; an accepted URL does not configure a corporate CA across all containers |
| Managed vLLM or Ollama proxy private endpoint | Optional/generated bearer authentication does not add TLS to the private HTTP transport |
| Client to native dashboard | Authenticated OpenShell forwarding carries the connection to the sandbox-local listener; keep the local bind on loopback |

Do not reuse gateway mTLS settings as an assumed trust configuration for model downloads, image builds, or native agents.
Those layers need their own verified corporate-CA procedure, which remains **TBD**.

## Retained Data and Telemetry

Read [state and retention](state.md) before deleting a deployment or disposing of its storage.
For tracing, review the [existing collector requirement](agents.md#openclaw-tracing) and the collector operator's data access and retention policy.
Before enabling export, identify who can read the collector's stored data and how long it is retained.
The current integration selects an existing collector; it does not provision or manage that retention policy.
Experimental [Hermes Relay tracing](agents.md#hermes-relay-tracing) instead writes local sandbox artifacts without adding a collector or egress rule.
Its full-payload setting is disabled, but trace contents still need privacy review before sharing; deleting the sandbox deletes those files.
Relay without explicit `interfaces` selects the upstream adapter, which defaults to `HERMES_YOLO_MODE=1` and accepted hooks when unset; the local Hermes adapter's manual-approval configuration does not apply.
Review this change in native control behavior before enabling the experimental mode.

Production tracing privacy review and retention guidance: **TBD**.

## Report a Vulnerability

Use the private channels in [SECURITY.md](../SECURITY.md), including NVIDIA's disclosure program and encrypted PSIRT email.
Do not include vulnerability details or credentials in a public issue.

## Earlier Runtime Identity

The earlier experimental Okta/Entra runtime-identity profiles and OAuth refresh lifecycle have no equivalent declaration in the v1 schema.
A v1 runtime-identity procedure remains **TBD** pending an accepted implementation and tenant-scoped qualification.
Provider authentication references do not implement that older identity workflow.

## Implementation and Tests

The [policy validator](../crates/nemoclaw-sdk/src/config/network.rs), [credential handling](../crates/nemoclaw-sdk/src/inference_auth.rs), [runtime authentication](../crates/nemoclaw-runtime/src/authentication.rs), and [managed-auth tests](../crates/nemoclaw-sdk/tests/managed_auth.rs) implement parts of these controls.
Use [retained validation records](validation/README.md) for their tested environments and limits.
