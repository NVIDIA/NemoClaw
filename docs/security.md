<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review Security and Credential Ownership

Select controls for the actual sandbox image, engine host, gateway, and inference endpoint.
Parser acceptance and protocol fixtures do not establish security qualification on a deployment host.

## Isolation and Trust

OpenShell enforces the declared sandbox policy; Fabric runs the native agent within that sandbox.
Use [sandbox policy](sandbox-network.md) for filesystem, process, egress, and proxy configuration.
An explicit policy replaces the preset, and apply rejects policy changes that require sandbox replacement.

The isolated preset uses Landlock `best_effort`; unavailable restrictions are not enforced.
Each declared agent has its own OpenShell sandbox; tool grants do not further isolate processes or files within that sandbox.
See [agent tool restrictions](agents.md#agent-tool-restrictions).
Fabric's Hermes adapter defaults `HERMES_YOLO_MODE` and `HERMES_ACCEPT_HOOKS` to `1`, so Hermes runs commands and hooks without asking for approval; rely on the sandbox policy for isolation.

A threat model, host-specific security qualification and hardening profiles are tracked in [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643).

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
Use a fresh deployment for policy or launch changes that apply refuses to replace.

## Credentials and Authentication

Each credential procedure must identify who supplies the value, where it persists, who can read it, and how it is retired.
Use the owning guide for the selected credential type:

| Credential or connection | Storage, access, and retirement | Owning procedure |
|---|---|---|
| Gateway bearer credential and mTLS files | Caller supplies environment values and local files; SDK/provider need access; gateway operator owns revocation, while the caller removes local values/files when no longer needed | [Configuration and credentials](usage.md#configuration-and-credentials) |
| Literal application-container environment key | Caller places the value in private YAML; it enters plans/state, exports, and Docker configuration; the application and engine administrators can read it; caller owns artifact cleanup and upstream revocation | [Application environment](design/container-contract.md#application-environment) |
| External inference key, including Hermes provider authentication | Caller resolves the reference; OpenShell retains the installed value for routing; destroy removes the provider registration, not the upstream account/key | [Inference authentication](inference.md#authenticate-hermes-through-the-provider) |
| Key for a model server you run in a Kubernetes or OpenShift cluster | Caller supplies the value where `nemoclaw` runs, and a Kubernetes Secret supplies it to the server; principals who can read Secrets or create Pods in the server's namespace, or exec into the server's Pod, and node administrators can read it; OpenShell retains the installed value for routing; destroy removes the provider registration, not the Secret or the server's key | [In-cluster model server](kubernetes.md#use-a-model-server-in-the-cluster) |
| Generated managed vLLM key | Private file in a separate retained credential volume, available to runtime root and engine administrators; recreation reuses it; retiring the container does not erase the key | [Managed service authentication](inference.md#authenticate-a-managed-vllm-service) |
| Generated external-Ollama proxy key | Private credential volume, available to proxy root and engine administrators; retained across destroy/recreation and never forwarded to Ollama | [Ollama proxy](inference.md#use-external-ollama-through-a-managed-proxy) |
| Brave or Tavily search key | Caller supplies the value; OpenShell holds it and replaces the agent's placeholder; destroy removes managed registrations but does not revoke the upstream key | [Web search](agents.md#web-search) |

Removing a caller's environment variable does not revoke an upstream key or erase a credential retained by a gateway.
Unchanged apply does not automatically detect changed values behind the same reference.
Managed private HTTP endpoints with bearer authentication do not provide TLS.

Corporate CA provisioning across the client, images, gateway and native runtimes, and a rotation runbook for every credential type, are tracked in [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643).
Use each existing guide's current lifecycle constraints; do not infer a rotation command.

Keep credential values out of committed or shared YAML, shell arguments, shared URLs, and published diagnostics.
Generic application containers currently have no protected credential delivery; their temporary literal-environment approach exposes values in configuration and state.
Use credential references where the selected provider supports them, rather than copying that plaintext approach into gateway or inference settings.
The example authoring TUI saves credential references and never resolves their values.
Authoring and lifecycle operations are separate commands; accepting an authored document does not authorize apply.
Inspect a secret-free plan before invoking apply.
For `plan` or `apply`, `--non-interactive` requires environment-provided credentials and fails instead of prompting when a reference is unresolved.
Use environment references for provider secrets and protected files for gateway TLS keys.
Configuration export preserves references; it cannot recover a lost credential value.
Retiring a deployment requires separate decisions about upstream revocation, retained gateway/model/proxy storage, and caller-owned files.
[Remove Retained Resources](usage.md#remove-retained-resources) removes retained storage from Docker engines.

### Diagnostic Disclosure

The SDK keeps resolved credential-reference values out of its own error construction and filters child-process errors and progress as a backstop.
Arbitrary literal container environment values are not automatically registered for this protection; treat resulting diagnostics as potentially sensitive.
For values of at least eight Unicode characters, the filter replaces matching spans in one pass, merging overlaps without rescanning `[redacted]` markers.
This exact-value filter does not cover encoded or transformed secrets; providers must still avoid putting credentials in diagnostics.

When any protected value has fewer than eight characters, the SDK withholds child error text and detailed child resource/download progress uniformly, whether or not that value appears in the output.
Failures report `child diagnostic withheld because a credential is too short for safe redaction`.
This prevents character-position disclosure; the threshold does not reject credentials or validate their strength.
SDK stage progress, operation results, and known remaining-state guidance remain available.

Protected values include resolved environment references passed to the child, including gateway TLS file paths, and nonempty values in the SDK process environment whose names contain `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`, ignoring case.
The environment scan includes values subsequently excluded from the child environment or overridden.
If withholding is unexpected, check those references and remove unrelated credential-like environment variables from the invocation.
The [subprocess tests](../crates/nemoclaw-sdk/src/process.rs) and [bundled CLI fixture](../crates/nemoclaw-e2e/tests/deployment.rs) exercise these boundaries.

### Separate the TLS Connections

| Connection | Current configuration boundary |
|---|---|
| Client to OpenShell gateway | HTTPS uses trust verification; optional `gateway.tls` selects CA, client certificate, and key through environment references to file paths |
| Client to inference catalog during onboarding | Uses the client machine's trust store or `SSL_CERT_FILE`; this trust does not configure the inference path |
| OpenShell to external inference | NemoClaw accepts HTTP and HTTPS URLs, with or without a credential; OpenShell checks destinations when a sandbox connects. Prefer HTTPS for credentialed endpoints: over plain HTTP, the key crosses the network unencrypted |
| Managed vLLM or Ollama proxy private endpoint | Optional/generated bearer authentication does not add TLS to the private HTTP transport |
| Client to native dashboard | Authenticated OpenShell forwarding carries the connection to the sandbox-local listener; keep the local bind on loopback |

For an inference endpoint with an internal CA, follow [custom CA trust](inference.md#trust-a-custom-certificate-authority) for the client and the OpenShell images.
Do not reuse gateway mTLS settings as an assumed trust configuration for model downloads, image builds, or native agents.
Those layers need their own corporate-CA procedure ([#12643](https://github.com/NVIDIA/NemoClaw/issues/12643)).

## Retained Data and Telemetry

Read [state and retention](state.md) before deleting a deployment or disposing of its storage.
For tracing, review [Hermes Relay tracing](agents.md#hermes-relay-tracing) and, for any collector, its operator's data access and retention policy.
Before enabling export, identify who can read the collector's stored data and how long it is retained.
The current integration selects an existing collector; it does not provision or manage that retention policy.
Experimental [Hermes Relay tracing](agents.md#hermes-relay-tracing) instead writes local sandbox artifacts without adding a collector or egress rule.
Its full-payload setting is disabled, but trace contents still need privacy review before sharing; deleting the sandbox deletes those files.

Privacy review and retention guidance for production tracing are tracked in [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643).

## Report a Vulnerability

Use the private channels in [SECURITY.md](../SECURITY.md), including NVIDIA's disclosure program and encrypted PSIRT email.
Do not include vulnerability details or credentials in a public issue.

## Implementation and Tests

The [policy validator](../crates/nemoclaw-openshell/src/policy.rs), [credential handling](../crates/nemoclaw-docker/src/credentials.rs), [runtime authentication](../crates/nemoclaw-runtime/src/vllm/runtime/authentication.rs), and [managed-auth tests](../crates/nemoclaw-sdk/tests/managed_auth.rs) implement parts of these controls.
