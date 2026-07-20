<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Label Taxonomy

Status: canonical maintainer policy.

Use a label only when it changes an action, route, or report.

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
- Product Readiness Review reporting.
- Immediate action queues.
- Community contribution signals.
- PR type and PR release activation.
- Agent-owned coordination under `agt: *`.

## Canonical Label Families

### PR Type

Apply one PR type label to a non-draft PR when there is enough evidence.

| Label | Applies To | Description | Positive Signals | Negative Signals |
|---|---|---|---|---|
| `bug-fix` | PR | PR primarily fixes broken behavior. | Fixes regression, failing test, crash, incorrect output. | Adds unrelated new capability, pure docs, pure tooling. |
| `feature` | PR | PR adds or expands user-visible capability. | New command, provider, workflow, config, or user-facing behavior. | Only fixes existing behavior or docs. |
| `refactor` | PR | PR restructures code without intended behavior change. | Cleanup, decomposition, architecture simplification. | User-visible behavior change. |
| `chore` | PR | Docs, CI, dependencies, packaging, policy, or maintenance. | Docs-only, build, CI, dependency, skill policy, automation. | Product behavior change that needs feature or bug-fix. |

`security` can be added as a supplemental risk label to any issue or PR when security review is required.

### Reporting

Reporting labels apply when maintainers need to identify items that feed a recurring review, report, or readiness artifact.

| Label | Applies To | Description | Positive Signals | Negative Signals |
|---|---|---|---|---|
| `PRR` | Issue, PR | Reserved Product Readiness Review label for reports or follow-up used to assess product readiness and user experience. | Maintainer-applied or dedicated PRR workflow-applied Product Readiness Review report, PRR follow-up, readiness assessment, or user experience assessment tied to a PRR. | Generic readiness concern, ordinary UX bug, release validation, QA issue, daily release activity, or normal triage output. |

Do not recommend `PRR` during triage.
Maintainers and PRR workflows reserve it for Product Readiness Reviews.
Do not use it for lifecycle, release readiness, UX routing, or Project Status.

### Routing Areas

Area labels apply to issues and PRs when the affected surface is clear.

Use area labels for the affected product or code surface.
Do not label each concept that the report mentions.
For overlapping areas, prefer the label that routes the next action:

- Use `area: install` for prerequisites and setup mechanics.
  Use `area: onboarding` for the first-run flow and its state.
  Use `area: packaging` for artifacts, images, registries, and distribution.
- Use `area: inference` for model execution and output.
  Use `area: providers` for provider integration, configuration, and selection.
  Use `area: routing` for dispatch, fallback, and model selection.
  Use `area: local-models` for local runtime, download, launch, and connectivity.
- Use `area: integrations` for external app and bridge behavior.
  Use `area: messaging` for message delivery and channel lifecycle.
  Add the matching `integration:*` label for a listed integration.
- Use `area: ci` for failures in workflows, checks, release automation, runners, or test infrastructure.
  Do not add it only because CI found an E2E failure.
  Add both `area: ci` and `area: e2e` when CI or test infrastructure is part of the failure.

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

Do not infer a platform from the test environment alone.
Add a platform label when the error, code path, install behavior, runtime behavior, or repeated reports identify that platform.
When evidence is not conclusive, add the label only if the platform is likely causal or changes routing.
Otherwise, omit it.
Prefer the narrower platform label unless both labels route work to different owners.
Do not add a platform label only because the environment template names Docker, a CPU, or an operating system.

Use a platform label when the platform appears in the error, title, or affected install path.
`Windows ARM`, `Windows ARM64`, and `aarch64` support `platform: arm64`.
`WSL`, `WSL2`, and `Windows Subsystem for Linux` support `platform: wsl`.

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

Add `area: providers` for provider work.
Also add the matching `provider:*` label for a listed provider.
Prefer that label over `provider: openai` for an OpenAI-compatible provider with its own label.
For an unlisted provider, add `area: providers` and name the provider in the rationale.

| Label | Description |
|---|---|
| `provider: anthropic` | Anthropic or Claude provider behavior. |
| `provider: nvidia` | NVIDIA inference endpoint, NIM, or NVIDIA provider behavior. |
| `provider: ollama` | Ollama local model provider behavior. |
| `provider: openai` | OpenAI API or OpenAI-compatible provider behavior. |
| `provider: vllm` | vLLM local or hosted provider behavior. |

### Integration

Integration labels apply when a recurring external app, channel, tool, or agent integration is specifically involved.

Add `area: integrations` for integration subsystem work.
Add `area: messaging` for delivery, channel lifecycle, manifests, or bridge messages.
Add the matching `integration:*` label when a listed integration is the affected subject.
Do not replace that label with only `area: integrations`.
Use the title, body, linked issue, tests, file paths, and PR prefix as evidence.

| Label | Description |
|---|---|
| `integration: brave` | Brave integration behavior. |
| `integration: dcode` | LangChain Deep Code integration behavior. |
| `integration: discord` | Discord bridge or channel lifecycle. |
| `integration: hermes` | Hermes startup, plugin, sandbox, TUI, or Hermes model/tool-call behavior. |
| `integration: openclaw` | OpenClaw runtime, TUI, e2e tests, stubs, plugins, configuration, or bridge. |
| `integration: slack` | Slack bridge, manifest, auth, or delivery behavior. |
| `integration: telegram` | Telegram bot, bridge, polling, or delivery. |
| `integration: wechat` | WeChat channel or bridge behavior. |
| `integration: whatsapp` | WhatsApp channel setup or runtime. |

### Needs

`needs:*` labels identify blocked actions. Remove them when the action is complete.
`Needs Review` is a Project Status value, not a label.
Do not add `needs: triage` during triage. It identifies items that have not been processed.

| Label | Applies To | Description |
|---|---|---|
| `needs: cleanup-review` | Issue, PR | Stale, superseded, competing, convergence-needed, or closure-candidate item needs maintainer judgment. |
| `needs: design` | Issue, PR | Product or architecture direction is unclear or cross-cutting. |
| `needs: info` | Issue, PR | Missing repro, logs, version, platform, answer, or PR context required before work can proceed. Optional clarifying questions should use `questions_for_author` without this label. |
| `needs: rebase` | PR | Merge conflicts, dirty merge state, or rebase requested. |
| `needs: triage` | Issue, PR | Existing inbox/placeholder signal for unprocessed items. Do not newly add from normal triage once Type, labels, and Project fields are being recommended. |
| `needs: unblock` | Issue, PR | Blocked item needs a dependency or decision resolved. |

Do not combine:

- `needs: info` with `needs: rebase`.
- `good first issue` with `security`, urgent priority, or `needs: design`.

### Community

| Label | Applies To | Description |
|---|---|---|
| `good first issue` | Issue | Small, clear task for new contributors. Do not use it for permission, secret, security, release, or policy work. |
| `help wanted` | Issue | Accepted work where maintainers welcome external contribution. |

### Release Train

Daily `v0.0.x` labels activate open PRs for release work.
After a PR merges, authorized automation adds the next patch label while the merge is ahead of the release tag.
After verification of the tag and `latest`, release housekeeping moves open items and deletes the released label.
Tags and commit ancestry record release membership.
An issue label can track attention or PR work. It does not include the issue in a release.
Do not rename or reuse a released label. See `release-train.md`.

### Agent-Owned

`agt: *` labels are agent-owned coordination labels.
Agents may create, apply, remove, and delete them in an authorized agent workflow.
They must not encode product type, priority, Project Status, sprint, or release version.

## Unknown Labels

Do not create, apply, or recreate a label that is absent from this taxonomy.
The `agt: *` namespace is the exception.

Report an old or unknown label in an audit or cleanup dry run.
Do not apply it to another item.
