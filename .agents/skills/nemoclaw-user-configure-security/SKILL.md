---
name: "nemoclaw-user-configure-security"
description: "Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs. Explains where NemoClaw stores provider credentials, the file permissions it applies, and the operational security trade-offs of plaintext local storage. Use when reviewing credential handling or advising users how to secure stored API keys."
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

## Reference

- [NemoClaw Credential Storage](references/credential-storage.md)
