<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw

> [!NOTE]
> Start with the [NemoClaw Agent Configs v0.1.0 first-deployment tutorial](docs/get-started/first-deployment.md).
> If you use [NemoClaw v0](https://github.com/NVIDIA/NemoClaw/tree/main), [evaluate NemoClaw Agent Configs in a separate deployment](docs/get-started/migration.md) without changing the original.

## NemoClaw Agent Configs

Configure and deploy sandboxed AI agents from a YAML file.
Choose agents, models, tools, and network access, then preview and apply deployment changes through the CLI or Rust SDK.

[Install the v0.1.0 CLI](docs/get-started/install.md) and follow the [first-deployment tutorial](docs/get-started/first-deployment.md) to verify an OpenClaw reply.

On Windows ARM64, use [the WSL2 onboarding guide](docs/get-started/windows-wsl.md).
Native Windows bundles support AMD64 only.
The WSL2 guide builds the current checkout and creates a managed local gateway; the first-deployment tutorial uses the v0.1.0 release and an existing gateway.

<a href="docs/get-started/first-deployment.md#gh-light-mode-only">
  <picture>
    <source media="(max-width: 700px)" srcset="docs/assets/deployment-workflow-mobile-light.svg">
    <img src="docs/assets/deployment-workflow-light.svg" alt="Define, plan, and apply a NemoClaw deployment. Open the first-deployment tutorial.">
  </picture>
</a>
<a href="docs/get-started/first-deployment.md#gh-dark-mode-only">
  <picture>
    <source media="(max-width: 700px)" srcset="docs/assets/deployment-workflow-mobile.svg">
    <img src="docs/assets/deployment-workflow.svg" alt="Define, plan, and apply a NemoClaw deployment. Open the first-deployment tutorial.">
  </picture>
</a>

### What You Can Do

Use NemoClaw Agent Configs to configure and operate sandboxed agents:

| Outcome | How |
|---|---|
| Run sandboxed agents | Deploy OpenClaw or Hermes in an NVIDIA OpenShell sandbox and connect through its [native interfaces](docs/agents-inference/interfaces.md). |
| Connect models | Use hosted endpoints or run managed vLLM, Ollama, or llama.cpp services, as [inference configuration](docs/agents-inference/inference.md) describes. |
| Add skills and tools | Load [skill folders](docs/agents-inference/agents.md#skills-on-a-mounted-volume) and connect [MCP servers](docs/agents-inference/agents.md#additional-agent-integrations). |
| Set access | Declare [network policy](docs/security/sandbox-network.md) and route [API credentials](docs/agents-inference/agents.md#key-authenticated-apis) through OpenShell. |
| Persist files | Keep files that must survive sandbox replacement on [mounted storage](docs/build-deploy/state.md#keeping-agent-files-on-mounted-volumes). Files alone do not resume a conversation. |

### What's New in Agent Configs

NemoClaw Agent Configs replaces separate lifecycle commands with a desired-state workflow.
One YAML file describes the deployment, so you can review changes before they affect running agents.
`nemoclaw plan` previews the changes, and `nemoclaw apply` makes them.

| New Workflow | How |
|---|---|
| Fix a setting and redeploy from the same YAML | Edit a setting in the file, such as the `targetPort` of a [service exposure](docs/agents-inference/interfaces.md#exposing-a-service-through-the-gateway), then preview, apply, and retry if apply fails. That edit updates the running sandbox in place; [other changes](docs/build-deploy/usage.md#choosing-the-change-path), such as changing sandbox CPU or memory limits, replace the sandbox. |
| Restart a stopped agent in its existing sandbox | When `nemoclaw plan` reports `agent runtime is not running`, apply the same YAML to start the agent again in its sandbox, which keeps its files. Reapplying does not fix an agent that runs but does not answer; refer to [replacing an unusable runtime](docs/build-deploy/usage.md#replacing-workloads-after-an-unusable-runtime). |
| Retry an interrupted deployment | After fixing the cause, apply again with the original bundle, YAML, and state directory. Read [interrupted-operation recovery](docs/build-deploy/usage.md#recovering-an-interrupted-operation) first: after a failed agent start, the retry creates the agent in a new sandbox and deletes the old sandbox's files. |
| Deploy different agents together | Declare several agents in one YAML file, each in its own sandbox with its own network policy and model selection, as the [multiple-sandbox example](examples/features/multiple-sandboxes.yaml) shows. |
| Deploy agents as pods on Kubernetes or OpenShift | Run each agent's sandbox as a pod on an existing cluster, using the same agent images as Docker and Podman. Check the [cluster prerequisites](docs/build-deploy/kubernetes.md#prerequisites) and [platform limits](docs/resources/limits.md#platforms-models-and-placement). |

Support depends on the selected agent, image, model, and platform.
Check [current limits](docs/resources/limits.md) before choosing a configuration.
[Out of Scope](docs/resources/out-of-scope.md) explains what Agent Configs leaves to other components by design.

### Watching a Deployment

[![Watch NemoClaw plan, apply, and destroy a deployment with verbose output](docs/assets/terminal-lifecycle-verbose.png)](docs/assets/terminal-lifecycle-verbose.mp4)

The [43-second lifecycle recording](docs/assets/terminal-lifecycle-verbose.mp4) shows plan, apply, and destroy with `--verbose`. Images are cached, and the plan-review pause is shortened. The recording does not send an inference request.

## Start Here

- [Understand NemoClaw](docs/about/overview.md).
- [Get started with NemoClaw Agent Configs](docs/get-started/first-deployment.md).
- [Author deployment YAML with onboarding](docs/get-started/onboard.md).
- [Browse shipped examples by use case and environment](examples/README.md).
- [Build NemoClaw from source](docs/build-deploy/build.md) for a custom revision or build-only target.
- [Build and onboard on an Apple silicon Mac](docs/get-started/macos.md), starting in Terminal.
- [Configure and operate a deployment](docs/build-deploy/usage.md).
- [Use the SDK](docs/references/sdk.md).
- [Browse all documentation](docs/README.md).

## Roadmap

The [GitHub milestones](https://github.com/NVIDIA/NemoClaw/milestones) track planned work, including [GTC DC 2026](https://github.com/NVIDIA/NemoClaw/milestone/12), [planned NemoClaw v0 features for Agent Configs](https://github.com/NVIDIA/NemoClaw/milestone/14), and [GTC SJC 2027](https://github.com/NVIDIA/NemoClaw/milestone/13).
Milestone placement alone does not promise a delivery date.
For current support, check the [NemoClaw v0 task comparison](docs/get-started/migration.md) and [current limits](docs/resources/limits.md).

## Contributing

Read the [accepted scope](internal-docs/design/scope.md) and follow [AGENTS.md](AGENTS.md) for repository workflow and required checks.
Follow [WRITING.md](WRITING.md) for explanatory text and the [documentation contributor guide](internal-docs/contributing/documentation.md) for documentation changes.
Report potential vulnerabilities through the private channels in [SECURITY.md](SECURITY.md).

## Licenses

Original NemoClaw code uses [Apache-2.0](LICENSE).
