# How NemoClaw Works

NemoClaw combines a lightweight CLI plugin with a versioned blueprint to move OpenClaw into a controlled sandbox.
This page explains the key concepts about NemoClaw at a high level.

## How It Fits Together

The `nemoclaw` CLI is the primary entrypoint for setting up and managing sandboxed OpenClaw agents.
It delegates heavy lifting to a versioned blueprint, a Python artifact that orchestrates sandbox creation, policy application, and inference provider setup through the OpenShell CLI.

NemoClaw adds the following layers on top of OpenShell.

| Layer | What it provides |
|-------|------------------|
| Onboarding | Guided setup that validates credentials, selects providers, and creates a working sandbox in one command. |
| Blueprint | A hardened Dockerfile with security policies, capability drops, and least-privilege network rules. |
| State management | Safe migration of agent state across machines with credential stripping and integrity verification. |
| Messaging bridges | Host-side processes that connect Telegram, Discord, and Slack to the sandboxed agent. |

OpenShell handles *how* to sandbox an agent securely. NemoClaw handles *what* goes in the sandbox and makes the setup accessible. For the full system diagram, see Architecture (see the `nemoclaw-reference` skill).

```mermaid
flowchart TB
    subgraph Host
        CMD["nemoclaw onboard"]
        PLUGIN[nemoclaw plugin]
        BLUEPRINT[blueprint runner]
        CLI["openshell CLI sandbox · gateway · inference · policy"]

        CMD --> PLUGIN
        PLUGIN --> BLUEPRINT
        BLUEPRINT --> CLI
    end

    subgraph Sandbox["OpenShell Sandbox"]
        AGENT[OpenClaw agent]
        INF[NVIDIA inference, routed]
        NET[default network policy]
        FS[filesystem isolation]

        AGENT --- INF
        AGENT --- NET
        AGENT --- FS
    end

    PLUGIN --> AGENT

    classDef nv fill:#76b900,stroke:#333,color:#fff
    classDef nvLight fill:#e6f2cc,stroke:#76b900,color:#1a1a1a
    classDef nvDark fill:#333,stroke:#76b900,color:#fff

    class CMD,PLUGIN,BLUEPRINT nvDark
    class CLI nv
    class AGENT nv
    class INF,NET,FS nvLight

    style Host fill:none,stroke:#76b900,stroke-width:2px,color:#1a1a1a
    style Sandbox fill:#f5faed,stroke:#76b900,stroke-width:2px,color:#1a1a1a
```

## Design Principles

NemoClaw architecture follows the following principles.

Thin plugin, versioned blueprint
: The plugin stays small and stable. Orchestration logic lives in the blueprint and evolves on its own release cadence.

Respect CLI boundaries
: The `nemoclaw` CLI is the primary interface for sandbox management.

Supply chain safety
: Blueprint artifacts are immutable, versioned, and digest-verified before execution.

OpenShell-native for new installs
: For users without an existing OpenClaw installation, NemoClaw recommends `openshell sandbox create` directly
  rather than forcing a plugin-driven bootstrap.

Reproducible setup
: Running setup again recreates the sandbox from the same blueprint and policy definitions.

## Plugin and Blueprint

NemoClaw is split into two parts:

- The *plugin* is a TypeScript package that registers an inference provider and the `/nemoclaw` slash command inside the sandbox.
  It handles user interaction and delegates orchestration work to the blueprint.
- The *blueprint* is a versioned Python artifact that contains all the logic for creating sandboxes, applying policies, and configuring inference.
  The plugin resolves, verifies, and executes the blueprint as a subprocess.

This separation keeps the plugin small and stable while allowing the blueprint to evolve on its own release cadence.

## Sandbox Creation

When you run `nemoclaw onboard`, NemoClaw creates an OpenShell sandbox that runs OpenClaw in an isolated container.
The blueprint orchestrates this process through the OpenShell CLI:

1. The plugin downloads the blueprint artifact, checks version compatibility, and verifies the digest.
2. The blueprint determines which OpenShell resources to create or update, such as the gateway, inference providers, sandbox, and network policy.
3. The blueprint calls OpenShell CLI commands to create the sandbox and configure each resource.

After the sandbox starts, the agent runs inside it with all network, filesystem, and inference controls in place.

## Inference Routing

Inference requests from the agent never leave the sandbox directly.
OpenShell intercepts every inference call and routes it to the configured provider.
During onboarding, NemoClaw validates the selected provider and model, configures the OpenShell route, and bakes the matching model reference into the sandbox image.
The sandbox then talks to `inference.local`, while the host owns the actual provider credential and upstream endpoint.

## Protection Layers

The sandbox starts with a default policy that controls network egress, filesystem access, process privileges, and inference routing.

| Layer | What it protects | When it applies |
|---|---|---|
| Network | Blocks unauthorized outbound connections. | Hot-reloadable at runtime. |
| Filesystem | Prevents reads and writes outside `/sandbox` and `/tmp`. | Locked at sandbox creation. |
| Process | Blocks privilege escalation and dangerous syscalls. | Locked at sandbox creation. |
| Inference | Reroutes model API calls to controlled backends. | Hot-reloadable at runtime. |

When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval. Approved endpoints persist for the current session but are not saved to the baseline policy file.

For details on the baseline rules, refer to Network Policies (see the `nemoclaw-reference` skill). For container-level hardening, refer to Sandbox Hardening (see the `nemoclaw-deploy-remote` skill).

## Next Steps

- Follow the Quickstart (see the `nemoclaw-get-started` skill) to launch your first sandbox.
- Refer to the Architecture (see the `nemoclaw-reference` skill) for the full technical structure, including file layouts and the blueprint lifecycle.
- Refer to Inference Options (see the `nemoclaw-configure-inference` skill) for detailed provider configuration.
