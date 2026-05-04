<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Architecture

NemoClaw has two main components: a TypeScript plugin that integrates with the OpenClaw CLI, and a Python blueprint that orchestrates OpenShell resources.

## System Overview

NVIDIA OpenShell is a general-purpose agent runtime. It provides sandbox containers, a credential-storing gateway, inference proxying, and policy enforcement, but has no opinions about what runs inside. NemoClaw is an opinionated reference stack built on OpenShell that handles what goes in the sandbox and makes the setup accessible.

```mermaid
graph LR
    classDef nemoclaw fill:#76b900,stroke:#5a8f00,color:#fff,stroke-width:2px,font-weight:bold
    classDef openshell fill:#1a1a1a,stroke:#1a1a1a,color:#fff,stroke-width:2px,font-weight:bold
    classDef sandbox fill:#444,stroke:#76b900,color:#fff,stroke-width:2px,font-weight:bold
    classDef agent fill:#f5f5f5,stroke:#e0e0e0,color:#1a1a1a,stroke-width:1px
    classDef external fill:#f5f5f5,stroke:#e0e0e0,color:#1a1a1a,stroke-width:1px
    classDef user fill:#fff,stroke:#76b900,color:#1a1a1a,stroke-width:2px,font-weight:bold

    USER(["👤 User"]):::user

    subgraph EXTERNAL["External Services"]
        INFERENCE["Inference Provider<br/><small>NVIDIA Endpoints · OpenAI<br/>Anthropic · Ollama · vLLM</small>"]:::external
        MSGAPI["Messaging Platforms<br/><small>Telegram · Discord · Slack</small>"]:::external
        INTERNET["Internet<br/><small>PyPI · npm · GitHub · APIs</small>"]:::external
    end

    subgraph HOST["Host Machine"]

        subgraph NEMOCLAW["NemoClaw"]
            direction TB
            NCLI["CLI + Onboarding<br/><small>Guided setup · provider selection<br/>credential validation · deploy</small>"]:::nemoclaw
            BP["Blueprint<br/><small>Hardened Dockerfile<br/>Network policies · Presets<br/>Security configuration</small>"]:::nemoclaw
            MIGRATE["State Management<br/><small>Migration snapshots<br/>Credential stripping<br/>Integrity verification</small>"]:::nemoclaw
        end

        subgraph OPENSHELL["OpenShell"]
            direction TB
            GW["Gateway<br/><small>Credential store<br/>Inference proxy<br/>Policy engine<br/>Device auth</small>"]:::openshell
            OSCLI["openshell CLI<br/><small>provider · sandbox<br/>gateway · policy</small>"]:::openshell
            CHMSG["Channel messaging<br/><small>OpenShell-managed<br/>Telegram · Discord · Slack</small>"]:::openshell

            subgraph SANDBOX["Sandbox Container 🔒"]
                direction TB
                AGENT["Agent<br/><small>OpenClaw or any<br/>compatible agent</small>"]:::agent
                PLUG["NemoClaw Plugin<br/><small>Extends agent with<br/>managed configuration</small>"]:::sandbox
            end
        end
    end

    USER -->|"nemoclaw onboard<br/>nemoclaw connect"| NCLI
    USER -->|"Chat messages"| MSGAPI

    NCLI -->|"Orchestrates"| OSCLI
    BP -->|"Defines sandbox<br/>shape + policies"| SANDBOX
    MIGRATE -->|"Safe state<br/>transfer"| SANDBOX

    AGENT -->|"Inference requests<br/><small>no credentials</small>"| GW
    GW -->|"Proxied with<br/>credential injected"| INFERENCE

    MSGAPI -->|"Platform APIs"| CHMSG
    CHMSG -->|"Deliver to agent"| AGENT

    AGENT -.->|"Policy-gated"| INTERNET
    GW -.->|"Enforced by<br/>gateway"| INTERNET
```

## Deployment Topology

The logical diagram above shows how components relate.
This section shows what actually runs where on the host.
NemoClaw uses a Docker daemon.
The OpenShell gateway runs as a container that embeds a k3s cluster.
The sandbox runs as a Kubernetes pod inside that embedded cluster.

```mermaid
graph TB
    classDef host fill:#fff,stroke:#76b900,stroke-width:2px,color:#1a1a1a,font-weight:bold
    classDef cli fill:#76b900,stroke:#5a8f00,color:#fff,stroke-width:2px,font-weight:bold
    classDef docker fill:#2496ed,stroke:#1577c2,color:#fff,stroke-width:2px,font-weight:bold
    classDef gateway fill:#1a1a1a,stroke:#1a1a1a,color:#fff,stroke-width:2px,font-weight:bold
    classDef k3s fill:#ffc61c,stroke:#c89a00,color:#1a1a1a,stroke-width:2px,font-weight:bold
    classDef pod fill:#444,stroke:#76b900,color:#fff,stroke-width:2px
    classDef external fill:#f5f5f5,stroke:#e0e0e0,color:#1a1a1a,stroke-width:1px

    subgraph HOST["Host machine · Linux / macOS / WSL2 / DGX Spark"]
        direction TB
        CLI["nemoclaw CLI<br/><small>bin/nemoclaw.js → dist/<br/>onboard · connect · status · logs</small>"]:::cli

        subgraph DOCKER["Docker daemon"]
            direction TB

            subgraph GWCON["OpenShell gateway container"]
                direction TB
                PROXY["OpenShell L7 proxy<br/><small>rewrites Authorization headers<br/>and URL-path segments at egress<br/>(credential injection)</small>"]:::gateway

                subgraph K3S["Embedded k3s cluster"]
                    direction TB

                    subgraph POD["Sandbox pod 🔒<br/><small>Landlock + seccomp + netns</small>"]
                        direction TB
                        AGENT["OpenClaw agent<br/>+ NemoClaw plugin"]:::pod
                    end
                end
            end
        end
    end

    INFER["Inference provider<br/><small>NVIDIA Endpoints · OpenAI<br/>Anthropic · Ollama · vLLM</small>"]:::external

    CLI -->|"openshell CLI<br/>(orchestrates)"| GWCON
    AGENT -->|"inference requests<br/><small>placeholder credentials</small>"| PROXY
    PROXY -->|"egress with real credentials<br/>injected at the L7 proxy"| INFER

    class HOST host
    class DOCKER docker
    class GWCON gateway
    class K3S k3s
    class POD pod
```

Layering from top to bottom:

| Layer | Runs as | Role |
|---|---|---|
| Host CLI | Host process (`nemoclaw` on Node.js) | Orchestrates OpenShell via `openshell` CLI calls. |
| Docker daemon | Host service | Runs the OpenShell gateway container. |
| Gateway container | Docker container | Hosts the credential store, the L7 proxy, and the embedded k3s control plane. |
| k3s | Process tree inside the gateway container | Kubernetes control plane that schedules the sandbox pod. |
| Sandbox pod | Pod in the embedded k3s cluster | Runs the OpenClaw agent and the NemoClaw plugin under Landlock + seccomp + netns. |
| OpenShell L7 proxy | Process in the gateway container | Intercepts agent egress and rewrites `Authorization` headers (Bearer/Bot) and URL-path segments to inject the real credential at the network boundary. |

NemoClaw never gives the sandbox a raw provider key.
At onboard time it registers credentials with OpenShell's provider/placeholder system, and the L7 proxy substitutes the real value into outbound requests at egress.
The CLI helper `isInferenceRouteReady` (in `src/lib/onboard.ts`) is a host-side readiness check used by the resume flow to decide whether the active route already covers the chosen provider and model — it is not a runtime component.

For the DGX Spark-specific variant of this topology (cgroup v2, aarch64, unified memory), refer to the [NVIDIA Spark playbook](https://build.nvidia.com/spark/nemoclaw).

## NemoClaw Plugin

The plugin is a thin TypeScript package that registers an inference provider and the `/nemoclaw` slash command.
It runs in-process with the OpenClaw gateway inside the sandbox.
It also registers runtime hooks that keep the agent aware of its environment.
Before an agent turn starts, the plugin prepends a short context block with the active sandbox name, sandbox phase, network policy summary, and filesystem policy summary.
When the policy or phase changes during a session, the plugin sends a smaller update block instead of repeating the full context.

```text
nemoclaw/
├── src/
│   ├── index.ts                    Plugin entry: registers all commands
│   ├── cli.ts                      Commander.js subcommand wiring
│   ├── runtime-context.ts          Sandbox and policy context injection
│   ├── commands/
│   │   ├── launch.ts               Fresh install into OpenShell
│   │   ├── connect.ts              Interactive shell into sandbox
│   │   ├── status.ts               Blueprint run state + sandbox health
│   │   ├── logs.ts                 Stream blueprint and sandbox logs
│   │   └── slash.ts                /nemoclaw chat command handler
│   └── blueprint/
│       ├── resolve.ts              Version resolution, cache management
│       ├── fetch.ts                Download blueprint from OCI registry
│       ├── verify.ts               Digest verification, compatibility checks
│       ├── exec.ts                 Subprocess execution of blueprint runner
│       └── state.ts                Persistent state (run IDs)
├── openclaw.plugin.json            Plugin manifest
└── package.json                    Commands declared under openclaw.extensions
```

## NemoClaw Blueprint

The blueprint is a versioned Python artifact with its own release stream.
The plugin resolves, verifies, and executes the blueprint as a subprocess.
The blueprint drives all interactions with the OpenShell CLI.

```text
nemoclaw-blueprint/
├── blueprint.yaml                  Manifest: version, profiles, compatibility
├── policies/
│   └── openclaw-sandbox.yaml       Default network + filesystem policy
```

The blueprint runtime (TypeScript) lives in the plugin source tree:

```text
nemoclaw/src/blueprint/
├── runner.ts                       CLI runner: plan / apply / status / rollback
├── ssrf.ts                         SSRF endpoint validation (IP + DNS checks)
├── snapshot.ts                     Migration snapshot / restore lifecycle
├── state.ts                        Persistent run state management
```

### Blueprint Lifecycle

```mermaid
flowchart LR
    A[resolve] --> B[verify digest]
    B --> C[plan]
    C --> D[apply]
    D --> E[status]
```

1. Resolve. The plugin locates the blueprint artifact and checks the version against `min_openshell_version` and `min_openclaw_version` constraints in `blueprint.yaml`.
2. Verify. The plugin checks the artifact digest against the expected value.
3. Plan. The runner determines what OpenShell resources to create or update, such as the gateway, providers, sandbox, inference route, and policy.
4. Apply. The runner executes the plan by calling `openshell` CLI commands.
5. Status. The runner reports current state.

## Sandbox Environment

The sandbox runs the
[`ghcr.io/nvidia/openshell-community/sandboxes/openclaw`](https://github.com/NVIDIA/OpenShell-Community)
container image. Inside the sandbox:

- OpenClaw runs with the NemoClaw plugin pre-installed.
- Inference calls are routed through OpenShell to the configured provider.
- Network egress is restricted by the baseline policy in `openclaw-sandbox.yaml`.
- Filesystem access is confined to `/sandbox` and `/tmp` for read-write access, with system paths read-only.
- The NemoClaw plugin injects sandbox and policy context into agent turns so the agent can report policy blocks accurately.

## Inference Routing

Inference requests from the agent never leave the sandbox directly.
OpenShell intercepts them and routes to the configured provider:

```text
Agent (sandbox)  ──▶  OpenShell gateway  ──▶  NVIDIA Endpoint (build.nvidia.com)
```

Refer to Inference Options (use the `nemoclaw-user-configure-inference` skill) for provider configuration details.

## Provider Credential Storage

Provider credentials live in the OpenShell gateway store, not on the host filesystem.
NemoClaw never writes them to host disk; the OpenShell L7 proxy injects values at egress.
See Credential Storage (use the `nemoclaw-user-configure-security` skill) for the inspection, rotation, and migration flow.

## Host-Side State and Config

NemoClaw keeps non-secret operator-facing state on the host rather than inside the sandbox.

| Path | Purpose |
|---|---|
| `~/.nemoclaw/sandboxes.json` | Registered sandbox metadata, including the default sandbox selection. |
| `~/.openclaw/openclaw.json` | Host OpenClaw configuration that NemoClaw snapshots or restores during migration flows. |

The following environment variables configure optional services and local access.

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token you provide before `nemoclaw onboard`. OpenShell stores it in a provider; the sandbox receives placeholders, not the raw secret. |
| `TELEGRAM_ALLOWED_IDS` | Comma-separated Telegram user or chat IDs for allowlists when onboarding applies channel restrictions. |
| `CHAT_UI_URL` | URL for the optional chat UI endpoint. |
| `NEMOCLAW_DISABLE_DEVICE_AUTH` | Build-time-only toggle that disables gateway device pairing when set to `1` before the sandbox image is created. |

For normal setup and reconfiguration, prefer `nemoclaw onboard` over editing these files by hand.
Do not treat `NEMOCLAW_DISABLE_DEVICE_AUTH` as a runtime setting for an already-created sandbox.
