<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Threat Model

This page describes what a NemoClaw deployment protects, from whom, and which component each protection relies on.
It complements the [trust boundaries](security.md#identify-the-trust-boundaries) and [credential ownership](security.md#credentials-and-authentication) on the security page.
It hasn't been qualified on specific hosts ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

## What a Deployment Protects

| Asset | Where it lives |
|---|---|
| Upstream credentials: inference, web search, and API keys | The caller's environment; OpenShell holds installed values for routing |
| Generated credentials: managed vLLM and Ollama proxy keys | Retained credential volumes on the service's engine |
| Gateway keys: signing keys, TLS material, encryption keys | Managed gateway storage, or the cluster for Kubernetes gateways |
| Agent data: files, conversations, artifacts, traces | The sandbox's writable layer, or mounted volumes |
| Deployment state | The local state directory, holding resource identities and settings but no credential values |

## Threats and Mitigations

| Threat | Mitigation | Relies on |
|---|---|---|
| A prompt-injected or malicious agent reaches hosts or files it shouldn't | Each agent runs in its own sandbox, and the sandbox policy grants only declared destinations, executables, and paths | OpenShell policy enforcement; Landlock where the host supports it |
| An agent reads an upstream key | Agents see an opaque placeholder; the OpenShell proxy substitutes the key only on requests to the registered endpoint | OpenShell credential injection |
| An agent calls tools beyond its task | MCP grants limit methods and tools at the proxy, and harness tool lists limit what the agent is offered | OpenShell MCP policy; the harness |
| One agent reads another's data | Separate sandboxes and separate volumes | OpenShell sandboxes; the platform's volume access controls |
| A key leaks through NemoClaw's output | Credential values stay out of configuration exports, plans, and state; diagnostics redact resolved values | NemoClaw's [diagnostic disclosure](security.md#diagnostic-disclosure) rules |
| Traffic is read or altered on the network | HTTPS to external endpoints and the gateway; mTLS for managed Kubernetes gateways | TLS configuration; prefer HTTPS for credentialed endpoints |
| A tampered image runs | Images are pinned by digest, and NemoClaw checks image labels before use | Image digests; the registry's integrity |
| State or configuration drifts out of band | Plans compare observed objects with state, including each sandbox's loaded policy hash | OpenTofu refresh; OpenShell's reported state |

## Assumptions and Remaining Risks

- **The host administrator is trusted.** Anyone who administers the Docker or Podman engine, or the cluster, can read containers, volumes, and process environments, including generated keys.
- **The sandbox is the boundary within an agent.** Tools and processes inside one sandbox share its files and credentials; tool restrictions don't isolate them from each other.
- **Landlock is best effort.** On hosts without Landlock support, filesystem restrictions inside the sandbox aren't enforced; see [isolation](security.md#isolation-and-trust).
- **Hermes runs without approval prompts.** Fabric's Hermes adapter enables `HERMES_YOLO_MODE`, so the sandbox policy is the only limit on what it runs.
- **Upstream services see what agents send them.** An inference or tool provider receives every routed request, including prompts and data.
- **Destroy doesn't revoke upstream keys.** Revoking them is the key owner's job; see [credential rotation](credential-rotation.md).

To reduce these risks, follow the [hardening checklist](security.md#harden-a-deployment).
