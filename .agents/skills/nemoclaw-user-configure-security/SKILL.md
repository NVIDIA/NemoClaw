---
name: "nemoclaw-user-configure-security"
description: "Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs. Explains where NemoClaw stores provider credentials, the file permissions it applies, and the operational security trade-offs of plaintext local storage. Use when reviewing credential handling or advising users how to secure stored API keys. Lists OpenClaw security controls that operate independently of NemoClaw, including prompt injection detection, tool access control, rate limiting, environment variable policy, audit framework, supply chain scanning, messaging access policy, context visibility, and safe regex. Use when reviewing the security boundary between NemoClaw and OpenClaw or assessing what NemoClaw does not cover."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Configure Security

Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs.

## Context

NemoClaw ships with deny-by-default security controls across four layers: network, filesystem, process, and inference.
You can tune every control, but each change shifts the risk profile.
This page documents every configurable knob, its default, what it protects, the concrete risk of relaxing it, and a recommendation for common use cases.

For background on how the layers fit together, refer to How It Works (see the `nemoclaw-user-overview` skill).

<!-- TODO: uncomment after the OpenShell docs are published
:::{seealso}
OpenShell enforces the platform-level mechanisms that NemoClaw configures, including network namespace isolation, seccomp filters, SSRF protection, TLS termination, and gateway authentication.
For the full platform-level controls reference, see [OpenShell Security Best Practices](https://docs.nvidia.com/openshell/latest/security/best-practices.html).
:::
-->

## Protection Layers at a Glance

NemoClaw enforces security at four layers.
NemoClaw locks some when it creates the sandbox and requires a restart to change them.
You can hot-reload others while the sandbox runs.

The following diagram shows the default posture immediately after `nemoclaw onboard`, before you approve any endpoints or apply any presets.

```mermaid
flowchart TB
    subgraph HOST["Your Machine: default posture after nemoclaw onboard"]
        direction TB

        YOU["👤 Operator"]

        subgraph NC["NemoClaw + OpenShell"]
            direction TB

            subgraph SB["Sandbox: the agent's isolated world"]
                direction LR
                PROC["⚙️ Process Layer<br/>Controls what the agent can execute"]
                FS["📁 Filesystem Layer<br/>Controls what the agent can read and write"]
                AGENT["🤖 Agent"]
            end

            subgraph GW["Gateway: the gatekeeper"]
                direction LR
                NET["🌐 Network Layer<br/>Controls where the agent can connect"]
                INF["🧠 Inference Layer<br/>Controls which AI models the agent can use"]
            end
        end
    end

    OUTSIDE["🌍 Outside World<br/>Internet · AI Providers · APIs"]

    AGENT -- "all requests" --> GW
    GW -- "approved only" --> OUTSIDE
    YOU -. "approve / deny" .-> GW

    classDef agent fill:#76b900,stroke:#5a8f00,color:#fff,stroke-width:2px,font-weight:bold
    classDef locked fill:#1a1a1a,stroke:#76b900,color:#fff,stroke-width:2px
    classDef hot fill:#333,stroke:#76b900,color:#e6f2cc,stroke-width:2px
    classDef external fill:#f5f5f5,stroke:#ccc,color:#1a1a1a,stroke-width:1px
    classDef operator fill:#fff,stroke:#76b900,color:#1a1a1a,stroke-width:2px,font-weight:bold

    class AGENT agent
    class PROC,FS locked
    class NET,INF hot
    class OUTSIDE external
    class YOU operator

    style HOST fill:none,stroke:#76b900,stroke-width:2px,color:#1a1a1a
    style NC fill:none,stroke:#76b900,stroke-width:1px,stroke-dasharray:5 5,color:#1a1a1a
    style SB fill:#f5faed,stroke:#76b900,stroke-width:2px,color:#1a1a1a
    style GW fill:#2a2a2a,stroke:#76b900,stroke-width:2px,color:#fff

*Full details in `references/best-practices.md`.*

NemoClaw provides infrastructure-layer security through sandbox isolation, network policy, filesystem restrictions, SSRF validation, and credential handling.
It delegates all application-layer security to OpenClaw.
This page documents areas where NemoClaw adds no independent protection beyond what OpenClaw already provides.

The details below reflect the OpenClaw documentation at the time of writing.
Consult the [OpenClaw Security docs](https://docs.openclaw.ai/gateway/security/index) for the current state.

## Prompt Injection Detection and Prevention

OpenClaw detects and neutralizes prompt injection attempts before they reach the agent.

| Control | Detail |
|---|---|
| Regex detection | Pattern matching detects common injection vectors such as "ignore all previous instructions" and `<system>` tag spoofing |
| Boundary wrapping | Untrusted input is wrapped in randomized XML boundary markers |
| Unicode folding | Homoglyph folding normalizes bracket variants to prevent visual spoofing |
| Invisible character stripping | Zero-width invisible characters are removed from input |
| Boundary sanitization | Fake boundary markers are sanitized to prevent marker injection |
| Auto-wrapping | Web fetch and search results are automatically wrapped as untrusted external content |

## Tool Access Control and Policy Pipeline

OpenClaw enforces a multi-layer tool policy pipeline that gates every tool call.

| Control | Detail |
|---|---|
| Deny list | High-risk tools (`exec`, `spawn`, `shell`, `fs_write`, `fs_delete`, and others) are blocked from Gateway HTTP by default |
| Policy pipeline | Multi-layer pipeline evaluates tool calls through profile, provider, agent, sandbox, and per-provider policies |
| Fail-closed semantics | Tool call hooks block execution on any error |
| Loop detection | Optional guard detects and blocks repeated identical tool call patterns (disabled by default, opt-in via `tools.loopDetection.enabled`) |
| Plugin approval | Approval workflow defaults to deny on timeout |

## Authentication Rate Limiting and Flood Protection

OpenClaw rate-limits authentication attempts and guards against connection floods.

| Control | Detail |
|---|---|
| Auth rate limiter | Sliding-window rate limiter tracks failed authentication attempts per IP and per scope |
| Control plane limiter | Per-device write rate limiting for control plane operations |
| WebSocket flood guard | Closes connections after repeated unauthorized attempts |
| Pre-auth budget | Limits connections before authentication completes |

## Environment Variable Security Policy

OpenClaw blocks environment variables that could enable code injection, privilege escalation, or credential theft.

| Category | Detail |
|---|---|
| Always-blocked keys | Keys such as `NODE_OPTIONS`, `LD_PRELOAD`, shell injection vectors, crypto mining variables, and `GIT_*` hijacking paths |
| Override-blocked keys | Additional keys blocked unless explicitly overridden |
| Blocked prefixes | Prefixes such as `GIT_CONFIG_`, `NPM_CONFIG_`, `CARGO_REGISTRIES_`, `TF_VAR_` |
| Universal blocked prefixes | `DYLD_`, `LD_`, `BASH_FUNC_` |

## Security Audit Framework

OpenClaw runs automated security checks (50+ distinct check types) that cover configuration, credential handling, and sandbox posture.
Run `openclaw security audit` to see all findings for your deployment.

These checks include:

*Full details in `references/openclaw-controls.md`.*

## Reference

- [NemoClaw Credential Storage](references/credential-storage.md)
