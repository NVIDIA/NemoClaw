# Overview of NVIDIA NemoClaw

import { AgentCli, AgentOnly } from "../_components/AgentGuide";

NVIDIA NemoClaw is an open-source reference stack for running always-on AI agents more safely inside OpenShell containers.
NemoClaw provides onboarding, lifecycle management, and agent operations for supported runtimes in OpenShell sandboxes.
It incorporates policy-based privacy and security guardrails, giving you control over your agents' behavior and data handling.
These controls help self-evolving agents run more safely in clouds, on-premises environments, RTX PCs, and DGX Spark.

NemoClaw pairs hosted models on inference providers or local endpoints with a hardened sandbox, routed inference, and declarative egress policy so deployment stays safer and more repeatable.
The sandbox runtime comes from [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).
NemoClaw adds the blueprint, <AgentCli /> CLI, onboarding, and related tooling as the reference way to run supported agents there.

| Capability              | Description                                                                                                                                          |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Sandbox supported agents | Creates an OpenShell sandbox pre-configured for your selected agent, with filesystem and network policies applied from the first boot.                   |
| Route inference         | Configures OpenShell inference routing so agent traffic goes to the provider and model you chose during onboarding (NVIDIA Endpoints, OpenAI, Anthropic, Gemini, compatible endpoints, local Ollama, and others). The agent uses `inference.local` inside the sandbox; credentials stay on the host. |
| Manage the lifecycle    | Handles blueprint versioning, digest verification, and sandbox setup.                                                                                |

## Key Features

NemoClaw provides the following product capabilities.

| Feature | Description |
|---------|-------------|
| Guided onboarding | Validates credentials, selects providers, and creates a working sandbox in one command. |
| Agent skills | Packages NemoClaw documentation as user skills so AI coding assistants can guide setup, inference configuration, policy management, monitoring, deployment, security review, and troubleshooting. |
| Hardened blueprint | A security-first Dockerfile with capability drops, least-privilege network rules, and declarative policy. |
| State management | Safe migration of agent state across machines with credential stripping and integrity verification. |
| Messaging channels | OpenShell-managed processes connect Telegram, Discord, Slack, and similar platforms to the sandboxed agent. NemoClaw configures channels during onboarding; OpenShell supplies the native constructs, credential flow, and runtime supervision. |
| Routed inference | Provider-routed model calls through the OpenShell gateway, transparent to the agent. Supports NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, compatible endpoints, local Ollama, local vLLM, and the Model Router. |
| Layered protection | Network, filesystem, process, and inference controls that can be hot-reloaded or locked at creation. |

## Benefits of Using NemoClaw

Autonomous AI agents can make arbitrary network requests, access the host filesystem, and call any inference endpoint. Without guardrails, this creates security, cost, and compliance risks that grow as agents run unattended.

NemoClaw provides the following benefits to mitigate these risks.

| Benefit                    | Description                                                                                                            |
|----------------------------|------------------------------------------------------------------------------------------------------------------------|
| Sandboxed execution        | Every agent runs inside an OpenShell sandbox with Landlock, seccomp, and network namespace isolation. The sandbox grants no access by default. |
| Routed inference           | The OpenShell gateway routes model traffic to your selected provider, transparent to the agent. You can switch providers or models. Refer to Inference Options (use the `nemoclaw-user-configure-inference` skill).          |
| Declarative network policy | YAML defines egress rules. OpenShell blocks unknown hosts and surfaces them to the operator for approval.                 |
| Single CLI                 | The <AgentCli /> command orchestrates the full stack: gateway, sandbox, inference provider, and network policy.           |
| Blueprint lifecycle        | Versioned blueprints handle sandbox creation, digest verification, and reproducible setup.                             |

## Use Cases

You can use NemoClaw for use cases such as the following.

| Use Case                  | Description                                                                                  |
|---------------------------|----------------------------------------------------------------------------------------------|
| Always-on assistant       | Run a sandboxed agent with controlled network access and operator-approved egress.        |
| Sandboxed testing         | Test agent behavior in a locked-down environment before granting broader permissions.         |
| Remote GPU deployment     | Deploy a sandboxed agent to a remote GPU instance for persistent operation.                   |

## Next Steps

Navigate to the following topics to learn more about NemoClaw and how to install and use it.

<AgentOnly variant="openclaw">

- [Architecture Overview](how-it-works.md) to understand how NemoClaw works.
- [Ecosystem](ecosystem.md) to understand how your agent, OpenShell, and NemoClaw relate in the wider stack, and when to use NemoClaw versus OpenShell.
- Quickstart with OpenClaw (use the `nemoclaw-user-get-started` skill) to install NemoClaw and run your first OpenClaw sandbox.
- Agent Skills (use the `nemoclaw-user-agent-skills` skill) to load NemoClaw guidance into an AI coding assistant.
- Inference Options (use the `nemoclaw-user-configure-inference` skill) to check the inference providers that NemoClaw supports and how inference routing works.

</AgentOnly>
<AgentOnly variant="hermes">

- [Architecture Overview](how-it-works.md) to understand how NemoClaw works.
- [Ecosystem](ecosystem.md) to understand how Hermes, OpenShell, and NemoClaw relate in the wider stack, and when to use NemoClaw versus OpenShell.
- Quickstart with Hermes (use the `nemoclaw-user-get-started` skill) to install NemoClaw and run your first Hermes sandbox with `nemoclaw`.
- Agent Skills (use the `nemoclaw-user-agent-skills` skill) to load NemoClaw guidance into an AI coding assistant.
- Inference Options (use the `nemoclaw-user-configure-inference` skill) to check the inference providers that NemoClaw supports and how inference routing works.

</AgentOnly>
