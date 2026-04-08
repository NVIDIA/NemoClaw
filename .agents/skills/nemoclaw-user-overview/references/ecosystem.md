# Ecosystem

NemoClaw provides onboarding, lifecycle management, and management of OpenClaw within OpenShell containers.

This page describes how the ecosystem is formed across projects, where NemoClaw sits relative to [OpenShell](https://github.com/NVIDIA/OpenShell) and [OpenClaw](https://openclaw.ai), and how to choose between NemoClaw and OpenShell.

## How the Stack Fits Together

Three pieces usually appear together in a NemoClaw deployment, each with a distinct scope:

| Project | Scope |
|---------|--------|
| [OpenClaw](https://openclaw.ai) | The assistant: runtime, tools, memory, and behavior inside the container. It does not define the sandbox or the host gateway. |
| [OpenShell](https://github.com/NVIDIA/OpenShell) | The execution environment: sandbox lifecycle, network and filesystem policy, inference routing, and the operator-facing `openshell` CLI for those primitives. |
| NemoClaw | The NVIDIA reference stack that implements the definition above on the host: `nemoclaw` CLI and plugin, versioned blueprint, channel messaging configured for OpenShell-managed delivery, and state migration helpers so OpenClaw runs inside OpenShell in a documented, repeatable way. |

NemoClaw sits above OpenShell in the operator workflow.
It drives OpenShell APIs and CLI to create and configure the sandbox that runs OpenClaw.
Models and endpoints sit behind OpenShell’s inference routing.
NemoClaw onboarding wires provider choice into that routing.

```mermaid
flowchart TB
    NC["🦞 NVIDIA NemoClaw<br/>CLI, plugin, blueprint"]
    OS["🐚 NVIDIA OpenShell<br/>Gateway, policy, inference routing"]
    OC["🦞 OpenClaw<br/>Assistant in sandbox"]

    NC -->|orchestrates| OS
    OS -->|isolates and runs| OC

    classDef nv fill:#76b900,stroke:#333,color:#fff
    classDef nvLight fill:#e6f2cc,stroke:#76b900,color:#1a1a1a
    classDef nvDark fill:#333,stroke:#76b900,color:#fff

    class NC nv
    class OS nv
    class OC nvDark

    linkStyle 0 stroke:#76b900,stroke-width:2px
    linkStyle 1 stroke:#76b900,stroke-width:2px
```

## NemoClaw Path versus OpenShell Path

Both paths assume OpenShell can sandbox a workload.
The difference is who owns the integration work.

| Path | What it means |
|------|---------------|
| **NemoClaw path** | You adopt the reference stack. NemoClaw’s blueprint encodes a hardened image, default policies, and orchestration so `nemoclaw onboard` can stand up a known-good OpenClaw-on-OpenShell setup with less custom glue. |
| **OpenShell path** | You use OpenShell as the platform and supply your own container, install steps for OpenClaw, policy YAML, provider setup, and any host bridges. OpenShell stays the sandbox and policy engine; nothing requires NemoClaw’s blueprint or CLI. |

## When to Use Which

Use the following table to decide when to use NemoClaw versus OpenShell.

| Situation | Prefer |
|-----------|--------|
| You want OpenClaw with minimal assembly, NVIDIA defaults, and the documented install and onboard flow. | NemoClaw |
| You need maximum flexibility: custom images, a layout that does not match the NemoClaw blueprint, or a workload outside this reference stack. | OpenShell with your own integration |
| You are standardizing on the NVIDIA reference for always-on assistants with policy and inference routing. | NemoClaw |
| You are building internal platform abstractions where the NemoClaw CLI or blueprint is not the right fit. | OpenShell (and your orchestration) |

## Related topics

| Page | View |
|------|------|
| Overview (see the `nemoclaw-user-overview` skill) | What NemoClaw is: capabilities, benefits, and use cases. |
| How It Works (see the `nemoclaw-user-overview` skill) | How NemoClaw runs: plugin, blueprint, sandbox creation, routing, protection layers. |
| Architecture (see the `nemoclaw-user-reference` skill) | Repository structure and technical diagrams. |
