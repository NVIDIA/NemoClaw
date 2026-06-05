<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Label Taxonomy

Status: canonical maintainer policy.

Labels should exist only when maintainers, agents, dashboards, or reviewers act differently because the label is present.

## Native Fields Before Labels

Use native GitHub Issue Type for issue classification:

- `Bug`
- `Enhancement`
- `Task`
- `Documentation`
- `Epic`
- `Initiative`

Use GitHub Project fields for:

- Priority
- Effort
- Start date
- Target date
- Lifecycle status
- Release or project status

Use labels for:

- Product or code routing.
- Platform, provider, integration, or reproduction surface.
- Immediate action queues.
- Community contribution signals.
- PR type and PR release activation.
- Agent-owned coordination under `agt: *`.

## Canonical Label Families

### PR Type

Apply exactly one PR type label to a non-draft PR when there is enough evidence.

| Label | Applies To | Description | Positive Signals | Negative Signals |
|---|---|---|---|---|
| `bug-fix` | PR | PR primarily fixes broken behavior. | Fixes regression, failing test, crash, incorrect output. | Adds unrelated new capability, pure docs, pure tooling. |
| `feature` | PR | PR adds or expands user-visible capability. | New command, provider, workflow, config, or user-facing behavior. | Only fixes existing behavior or docs. |
| `refactor` | PR | PR restructures code without intended behavior change. | Cleanup, decomposition, architecture simplification. | User-visible behavior change. |
| `chore` | PR | Docs, CI, dependencies, packaging, policy, or maintenance. | Docs-only, build, CI, dependency, skill policy, automation. | Product behavior change that needs feature or bug-fix. |

`security` can be added as a supplemental risk label to any issue or PR when security review is required.

### Routing Areas

Area labels apply to issues and PRs when the affected surface is clear.

Use area labels for the affected product or code surface, not for every concept mentioned in the report. For overlapping areas, prefer the label that best describes the owner of the next action:

- `area: install` for prerequisites or setup mechanics; `area: onboarding` for first-run flow and onboarding state; `area: packaging` for shipped artifacts, images, registries, or distribution.
- `area: inference` for model execution or output behavior; `area: providers` for provider integration, configuration, or selection work; `area: routing` for dispatch, fallback, or model-selection logic; `area: local-models` for local runtime, download, launch, or connectivity.
- `area: integrations` for external app or bridge behavior; `area: messaging` when message delivery or channel lifecycle is the affected subsystem; add a specific `integration:*` label when one listed integration is involved.

| Label | Description |
|---|---|
| `area: architecture` | Architecture, design debt, major refactors, or maintainability. |
| `area: ci` | CI workflows, checks, release automation, or GitHub Actions. |
| `area: cli` | Command line interface, flags, terminal UX, or output. |
| `area: docs` | Documentation, examples, guides, generated docs, or docs build. |
| `area: e2e` | End-to-end tests, nightly failures, or validation infrastructure. |
| `area: inference` | Inference routing, serving, model selection, or generated outputs. |
| `area: install` | Install, setup, prerequisites, or uninstall flow. |
| `area: integrations` | External app, tool, channel, or OpenClaw integration behavior. |
| `area: local-models` | Local model providers, downloads, launch, or connectivity. |
| `area: messaging` | Messaging channels, bridges, manifests, or channel lifecycle. |
| `area: networking` | DNS, proxy, TLS, ports, host aliases, or connectivity. |
| `area: observability` | Logging, metrics, tracing, diagnostics, or debug output. |
| `area: onboarding` | First-run, onboarding FSM, provider setup, or sandbox launch. |
| `area: packaging` | Packages, images, registries, installers, or distribution. |
| `area: performance` | Latency, throughput, resource use, benchmarks, or scaling. |
| `area: policy` | Network policy, egress rules, presets, or sandbox policy. |
| `area: project-management` | Taxonomy, triage, workflow, roadmap, or project process. |
| `area: providers` | Inference provider integration, configuration, or selection work. |
| `area: routing` | Request routing, policy routing, model selection, or fallback logic. |
| `area: sandbox` | OpenShell sandbox lifecycle, runtime, configuration, or recovery. |
| `area: security` | Security controls, permissions, secrets, or hardening. |
| `area: skills` | Agent skills, prompts, behaviors, or skill packaging. |
| `area: ui` | Web UI, terminal display, visual layout, or UX behavior. |

### Platform

Platform labels apply when the issue or PR is specific to a platform or is more likely relevant to that platform, not merely because the author happened to test there. This is one of the hardest label families to infer.

Positive signals include platform-specific errors, platform-specific code paths, platform-specific install/runtime behavior, or repeated evidence from the same platform. Weak signals include reproduction setup only, "all platforms" reports, or logs that mention a platform without showing platform-specific behavior.

When evidence is ambiguous, use the platform label only when the platform seems routing-relevant or likely causal. Otherwise, leave it off and explain what evidence would make it platform-specific.

When a more specific platform label applies, prefer it over a broader one unless both are independently routing-relevant. Do not add `platform: container`, `platform: arm64`, or an OS label just because the environment template mentions Docker, CPU architecture, or OS.

| Label | Description |
|---|---|
| `platform: arm64` | ARM64 or aarch64-specific behavior. |
| `platform: brev` | Brev hosted development environments. |
| `platform: container` | Docker, containerd, Podman, or image behavior. |
| `platform: dgx-spark` | DGX Spark hardware or workflows. |
| `platform: dgx-station` | DGX Station hardware or workflows. |
| `platform: gb10` | GB10 GPU environments. |
| `platform: jetson` | Jetson AGX Thor or Orin environments. |
| `platform: k3s` | K3s-specific behavior. |
| `platform: k8s` | Kubernetes-specific behavior. |
| `platform: linux` | Linux behavior without Ubuntu specificity. |
| `platform: macos` | macOS, Darwin, Homebrew, or Apple Silicon behavior. |
| `platform: ubuntu` | Ubuntu-specific behavior. |
| `platform: windows` | Native Windows or PowerShell behavior. |
| `platform: wsl` | Windows Subsystem for Linux behavior. |

Do not create or apply `platform: all`.

### Provider

Provider labels apply when the issue or PR is specific to a recurring inference provider.

Use `area: providers` for provider integration work, and add `provider:*` when a listed provider is specifically involved. When a provider exposes an OpenAI-compatible API but has its own provider label, use the more specific provider label instead of `provider: openai`. For unknown or proposed providers, use `area: providers` and name the provider in the rationale.

| Label | Description |
|---|---|
| `provider: anthropic` | Anthropic or Claude provider behavior. |
| `provider: nvidia` | NVIDIA inference endpoint, NIM, or NVIDIA provider behavior. |
| `provider: ollama` | Ollama local model provider behavior. |
| `provider: openai` | OpenAI API or OpenAI-compatible provider behavior. |
| `provider: vllm` | vLLM local or hosted provider behavior. |

### Integration

Integration labels apply when a recurring external app, channel, tool, or agent integration is specifically involved.

Use `area: integrations` for integration subsystem work, and add `integration:*` when a listed integration is named or clearly implicated. Use `area: messaging` when delivery, channel lifecycle, manifests, or bridge messages are the affected subsystem; combine it with `integration:*` when the messaging issue is specific to a listed integration.

| Label | Description |
|---|---|
| `integration: brave` | Brave integration behavior. |
| `integration: discord` | Discord bridge or channel lifecycle. |
| `integration: hermes` | Hermes startup, plugin, or sandbox behavior. |
| `integration: openclaw` | OpenClaw runtime, plugins, configuration, or bridge. |
| `integration: slack` | Slack bridge, manifest, auth, or delivery behavior. |
| `integration: telegram` | Telegram bot, bridge, polling, or delivery. |
| `integration: wechat` | WeChat channel or bridge behavior. |
| `integration: whatsapp` | WhatsApp channel setup or runtime. |

### Needs

`needs:*` labels are action queues. Remove them when the action is complete. `Needs Review` is a Project Status value, not a label.

| Label | Applies To | Description |
|---|---|---|
| `needs: cleanup-review` | Issue, PR | Stale, superseded, competing, convergence-needed, or closure-candidate item needs maintainer judgment. |
| `needs: design` | Issue, PR | Product or architecture direction is unclear or cross-cutting. |
| `needs: info` | Issue, PR | Missing repro, logs, version, platform, answer, or PR context. |
| `needs: rebase` | PR | Merge conflicts, dirty merge state, or rebase requested. |
| `needs: triage` | Issue, PR | New issue or PR needs maintainer review for project workflow assignment, labeling, ownership, or next action. |
| `needs: unblock` | Issue, PR | Blocked item needs a dependency or decision resolved. |

Do not combine:

- `needs: info` with `needs: rebase`.
- `good first issue` with `security`, urgent priority, or `needs: design`.

### Community

| Label | Applies To | Description |
|---|---|---|
| `good first issue` | Issue | Small, clear, safe task for new contributors with tiny blast radius and no permission, secret, security, release, or policy risk. |
| `help wanted` | Issue | Accepted work where maintainers welcome external contribution. |

### Release Train

Daily `v0.0.x` labels activate PRs for daily release work. Issues may use a daily label as a tracking or attention signal, but issue labels do not determine release inclusion. See `release-train.md`.

### Agent-Owned

`agt: *` labels are agent-owned coordination labels. Agents may create, apply, remove, and delete them inside an authorized agent-owned workflow. They must not encode product type, priority, project status, sprint, or release version.

## Unknown Labels

Labels not listed in this taxonomy are not canonical and must not be created, applied, or recreated by agents or maintainers. The only exception is the agent-owned `agt: *` namespace described above.

If an old or unknown label is found on an existing item, report it in an audit or cleanup dry run. Do not use it as permission to apply the same label elsewhere.
