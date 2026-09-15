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
OpenClaw tool grants and separate agent workspaces do not create separate process or filesystem security boundaries.
See [agent tool restrictions](agents.md#multiple-openclaw-agents-and-tool-restrictions).

Host-specific security qualification, enterprise hardening profiles, and a complete threat model: **TBD**.

## Credentials and Authentication

Each credential procedure must identify who supplies the value, where it persists, who can read it, and how it is retired.
Use the owning guide for the selected credential type:

| Credential or connection | Owning procedure |
|---|---|
| Gateway bearer credential and mTLS file references | [Configuration and credentials](usage.md#configuration-and-credentials) |
| External inference key and Hermes provider reference | [Hermes authentication](inference.md#authenticate-hermes-through-the-provider) |
| Generated managed vLLM key retained with model storage | [Managed service authentication](inference.md#authenticate-a-managed-vllm-service) |
| Generated external-Ollama proxy key retained in its credential volume | [Ollama proxy](inference.md#use-external-ollama-through-a-managed-proxy) |
| Brave search key held by OpenShell | [Brave web search](agents.md#brave-web-search) |
| Native OpenClaw/Hermes interface tokens and pairing | [Agent interfaces](interfaces.md) |

Removing a caller's environment variable does not revoke an upstream key or erase a credential retained by a gateway.
Unchanged apply does not automatically detect changed values behind the same reference.
Managed private HTTP endpoints with bearer authentication do not provide TLS.

Corporate CA provisioning across client, image, gateway, and native runtimes: **TBD**.
A complete credential-rotation runbook for every credential type: **TBD**.
Use each existing guide's current lifecycle constraints; do not infer a rotation command.

## Retained Data and Telemetry

Read [state and retention](state.md) before deleting a deployment or disposing of its storage.
For tracing, review the [existing collector requirement](agents.md#openclaw-tracing) and the collector operator's data access and retention policy.

Production tracing privacy review and retention guidance: **TBD**.
Private vulnerability-reporting instructions for the v1 documentation: **TBD**.

## Implementation Evidence

The [policy validator](../crates/nemoclaw-sdk/src/config/network.rs), [credential handling](../crates/nemoclaw-sdk/src/inference_auth.rs), [runtime authentication](../crates/nemoclaw-runtime/src/authentication.rs), and [managed-auth tests](../crates/nemoclaw-sdk/tests/managed_auth.rs) implement parts of these controls.
Use [retained validation records](validation/README.md) for their tested environments and limits.
