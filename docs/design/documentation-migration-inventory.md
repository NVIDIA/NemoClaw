<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# User Documentation Migration Inventory

This inventory supports the [migration plan](documentation-migration.md), including its work packages, ownership, estimates, and release gates.
It covers all 125 non-changelog MDX sources at main revision `97745a7ad9649f851704493e4b670b3674f875aa`.
The baseline for current behavior is v1 revision `089a4bffb07c8386b0487bb1c6d7760836f6c4f0`.
Read old source with `git show 97745a7ad9649f851704493e4b670b3674f875aa:docs/PATH`.

Source paths in the tables are relative to the old `docs/` directory.
Destination paths are relative to the proposed new `docs/` directory; some destinations do not exist yet.
Work package IDs refer to the plan.
These dispositions are planning decisions to review in D00, not completed migrations or product commitments.

- **Rewrite:** the reader task continues, but the procedure or contract changes substantially.
- **Merge:** retain relevant facts in the named canonical owner after checking current behavior.
- **Hold:** preserve previous-version instructions and document the current limitation in the named destination; no new how-to until an owner accepts and qualifies the workflow.
- **History:** preserve versioned historical content and links; do not present it as current qualification.

For every row, D01 inventories all generated variants, published URLs, and consumed anchors; D09 verifies their final disposition.
Do not treat the source-to-page mapping below as a completed URL redirect map.
Held pages may contain reusable explanations, but their old commands must remain version-labeled.

## About and Home — 6 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `index.mdx` | Rewrite | `README.md`, `get-started.md`, `resources.md`: task entry points and version-aware agent access | D02, D08 |
| `about/overview.mdx` | Rewrite | `overview.md`: desired-state product and present capabilities | D02 |
| `about/how-it-works.mdx` | Rewrite | `overview.md`: deployment flow; link `design/architecture.md` for internals | D02 |
| `about/ecosystem.mdx` | Merge | `overview.md`, `agents.md`: NemoClaw/OpenShell/Fabric/OpenClaw ownership | D02, D06 |
| `about/ecosystem-hermes.mdx` | Merge | `overview.md`, `agents.md`: Hermes ownership and native access | D02, D06 |
| `about/ecosystem-deepagents.mdx` | Merge | `overview.md`, `agents.md`: Deep Agents ownership and external-service requirements | D02, D06 |

## Getting Started — 7 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `get-started/prerequisites.mdx` | Rewrite | `prerequisites.md`: verified bundles, images, tools, credentials, endpoints, and host roles | D03 |
| `get-started/quickstart.mdx` | Rewrite | `get-started.md`: OpenClaw YAML-to-interaction walkthrough | D03 |
| `get-started/quickstart-hermes.mdx` | Rewrite | `get-started.md`, `agents.md`, `interfaces.md`: shared deployment steps plus Hermes requirements | D03, D06 |
| `get-started/quickstart-langchain-deepagents-code.mdx` | Rewrite | `agents.md`: external gateway/inference path and native entry point; remove alias/installer workflow | D06 |
| `get-started/quickstart-pi.mdx` | Rewrite | `agents.md`: Pi model metadata, native access, external services, and session lifetime | D06 |
| `get-started/dgx-station-preparation.mdx` | Hold | `prerequisites.md`: do not inherit DGX Station qualification or setup scripts from main | D03 |
| `get-started/windows-preparation.mdx` | Rewrite | `prerequisites.md`: distinguish Windows client bundle evidence from WSL, engine, and GPU deployment support | D03 |

## Agent Configuration — 4 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `configure-agents/configure-agent-heartbeats.mdx` | Rewrite | `agents.md`: first-agent execution defaults, native heartbeat semantics, image/replacement requirements | D06 |
| `configure-agents/configure-memory-search.mdx` | Hold | `agents.md`: native setting; embedding endpoint, egress, credentials, and persistence need a qualified procedure | D06 |
| `configure-agents/progressive-tool-disclosure.mdx` | Rewrite | `agents.md`: shared disclosure mode, read-only allowlist, roster ownership, and replacement | D06 |
| `configure-agents/understand-context-compaction.mdx` | Hold | `agents.md`: verify pinned native defaults; do not carry main-specific tuning or patches as current behavior | D06 |

## Deployment — 6 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `deployment/deploy-to-headless-server.mdx` | Rewrite | `usage.md`, `interfaces.md`, `remote-service.md`: separate client access, gateway placement, and SSH model service | D03, D05 |
| `deployment/gateway-lifecycle-authority.mdx` | Rewrite | `usage.md`: managed/external ownership and retained gateway identity | D04 |
| `deployment/install-openclaw-plugins.mdx` | Hold | `agents.md`: native plugin ownership; old managed Dockerfile/custom-image workflow does not transfer | D06 |
| `deployment/register-external-component.mdx` | Rewrite | `usage.md`, `migration.md`: supported external gateway/inference declarations; no general component registry equivalence | D04 |
| `deployment/sandbox-hardening.mdx` | Rewrite | `security.md`, `sandbox-network.md`: current image/process/policy controls with host-qualified enforcement | D08 |
| `deployment/set-up-mcp-bridge.mdx` | Hold | `agents.md`, `migration.md`: no current NemoClaw bridge-management workflow | D06 |

## Inference — 33 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `inference/choose-compatible-inference-api.mdx` | Rewrite | `inference.md`: explicit API and harness compatibility; no automatic protocol translation | D05 |
| `inference/choose-inference-provider.mdx` | Rewrite | `inference.md`: endpoint/API/credential selection and management modes; distinguish configuration from vendor qualification | D05 |
| `inference/choose-local-inference-server.mdx` | Rewrite | `inference.md`, `models.md`: managed Ollama/vLLM versus external service ownership | D05 |
| `inference/choose-model.mdx` | Rewrite | `models.md`: model revision, capacity, API, context, and qualification; remove old catalog assumptions | D05 |
| `inference/configure-inference-timeouts.mdx` | Rewrite | `agents.md`, `inference.md`: execution timeout versus startup, readiness, and provider budgets | D05, D06 |
| `inference/configure-model-capabilities.mdx` | Rewrite | `inference.md`: supported OpenClaw reasoning fields and Pi native metadata; no inferred vision qualification | D05 |
| `inference/configure-model-limits.mdx` | Rewrite | `inference.md`: agent context/output limits versus managed-server capacity; harness-specific constraints | D05 |
| `inference/custom-endpoint-security.mdx` | Merge | `security.md`, `inference.md`: current HTTPS/private-address rules and credential routing | D05, D08 |
| `inference/declarative-agents-manifest.mdx` | Rewrite | `agents.md`, `migration.md`: desired-state agents, shared primary route, roster restrictions; old manifest is not the new schema | D04, D06 |
| `inference/how-inference-routing-works.mdx` | Rewrite | `inference.md`: Fabric/native-agent → OpenShell → configured provider; credential boundary | D05 |
| `inference/model-capability-audit.mdx` | Merge | `models.md`, `validation/README.md`: evidence vocabulary; retain old results only with original revision | D05 |
| `inference/set-up-anthropic-compatible-endpoint.mdx` | Merge | `inference.md`: explicit `anthropic-messages` configuration and matching harnesses | D05 |
| `inference/set-up-llama-cpp.mdx` | Hold | `inference.md`, `migration.md`: old managed installation is unavailable; any external endpoint example needs API qualification | D05 |
| `inference/set-up-model-router.mdx` | Hold | `inference.md`, `migration.md`: no equivalent managed router or model-pool lifecycle | D05 |
| `inference/set-up-nvidia-nim.mdx` | Hold | `inference.md`, `migration.md`: no equivalent managed NIM setup; qualify an external endpoint separately | D05 |
| `inference/set-up-ollama.mdx` | Rewrite | `inference.md`, `usage.md`: managed container/network/storage/model contract and recovery | D05 |
| `inference/set-up-openai-compatible-endpoint.mdx` | Merge | `inference.md`: API selection, endpoint and credential references, real verification | D05 |
| `inference/set-up-sub-agent.mdx` | Rewrite | `agents.md`, `migration.md`: distinguish declared OpenClaw agents sharing one route from old auxiliary-model/direct-credential setup | D06 |
| `inference/set-up-vllm-on-two-dgx-sparks.mdx` | Hold | `remote-service.md`, `migration.md`: SSH service placement and same-host two-daemon evidence do not qualify distributed inference | D05 |
| `inference/set-up-vllm-on-two-dgx-stations.mdx` | Hold | `remote-service.md`, `migration.md`: no inherited multi-node profile or hardware qualification | D05 |
| `inference/set-up-vllm.mdx` | Rewrite | `inference.md`, `models.md`, `recipes.md`: immutable runtime, model revision, service limits, memory supervision | D05 |
| `inference/switch-models.mdx` | Rewrite | `usage.md`, `inference.md`: change desired route model; identify runtime restart and conversation effects by harness | D04, D05 |
| `inference/switch-providers.mdx` | Rewrite | `usage.md`, `inference.md`: plan current endpoint/provider changes; distinguish route update from sandbox replacement | D04, D05 |
| `inference/understand-provider-validation.mdx` | Rewrite | `inference.md`, `troubleshooting.md`: configuration checks, observations, active probes, failure preservation | D05 |
| `inference/use-anthropic.mdx` | Merge | `inference.md`: candidate named-provider example; publish vendor-specific success claims only after qualification | D05 |
| `inference/use-google-gemini.mdx` | Merge | `inference.md`: qualify the intended compatible API; do not retain old native catalog/probe promises | D05 |
| `inference/use-hermes-provider.mdx` | Merge | `inference.md`: current Hermes provider auth reference; no interactive login promise | D05 |
| `inference/use-nvidia-endpoints.mdx` | Merge | `inference.md`: candidate endpoint example with explicit model/API evidence | D05 |
| `inference/use-openai.mdx` | Merge | `inference.md`: candidate completions/Responses examples scoped by harness and evidence | D05 |
| `inference/use-openrouter.mdx` | Merge | `inference.md`: candidate compatible endpoint example without inherited catalog validation | D05 |
| `inference/use-shared-gateway-routes.mdx` | Rewrite | `usage.md`, `inference.md`: deployment-owned routes and drift; no ambient reconnect/repoint workflow | D04, D05 |
| `inference/verify-inference-route.mdx` | Rewrite | `inference.md`, `troubleshooting.md`: distinguish declared settings, observed route, and actual agent reply | D05 |
| `inference/view-active-inference-route.mdx` | Rewrite | `usage.md`, `inference.md`: checked export and documented observations; remove `inference get` commands | D04, D05 |

## Sandbox Operations — 26 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `manage-sandboxes/add-channels-after-onboarding.mdx` | Hold | `agents.md`, `migration.md`: native enrollment; schema lacks complete channel prerequisites | D06 |
| `manage-sandboxes/add-mcp-server.mdx` | Hold | `agents.md`, `migration.md`: no current `mcp add` lifecycle | D06 |
| `manage-sandboxes/backup-restore.mdx` | Rewrite | `state.md`, `migration.md`: no snapshot equivalent; distinguish configuration export and separate native-data backup | D04 |
| `manage-sandboxes/enable-channels-during-onboarding.mdx` | Hold | `agents.md`, `migration.md`: no onboarding or managed channel provisioning | D06 |
| `manage-sandboxes/gateway-lifecycle-control.mdx` | Rewrite | `usage.md`, `agents.md`: distinguish managed OpenShell gateway from native agent gateway | D04, D06 |
| `manage-sandboxes/install-plugins-hermes.mdx` | Hold | `agents.md`: native ownership; verify image, egress, credential, and persistence prerequisites before a how-to | D06 |
| `manage-sandboxes/lifecycle.mdx` | Rewrite | `usage.md`: plan/apply/export/destroy, retained bindings, and recovery | D04 |
| `manage-sandboxes/manage-mcp-servers.mdx` | Hold | `agents.md`, `migration.md`: no managed add/update/remove lifecycle | D06 |
| `manage-sandboxes/manage-messaging-channels.mdx` | Hold | `agents.md`, `migration.md`: no managed enable/disable/status lifecycle | D06 |
| `manage-sandboxes/messaging-channels.mdx` | Hold | `agents.md`: retain native ownership explanation without claiming fixture-based channel support | D06 |
| `manage-sandboxes/recover-rebuild-sandboxes.mdx` | Rewrite | `usage.md`, `troubleshooting.md`: explicit reconciliation; no rebuild, adoption, pruning, or ambiguous mutation retry | D04 |
| `manage-sandboxes/run-deep-agents-code.mdx` | Rewrite | `agents.md`: current native access and sessions; remove launch/use aliases and managed MCP assumptions | D06 |
| `manage-sandboxes/run-pi.mdx` | Rewrite | `agents.md`: native access, route metadata, runtime restarts, and lost in-memory conversations | D06 |
| `manage-sandboxes/run-sandboxes.mdx` | Rewrite | `usage.md`, `interfaces.md`: separate deployment state directories and native forwarding | D03, D04 |
| `manage-sandboxes/runtime-controls.mdx` | Rewrite | `agents.md`, `usage.md`: declarative settings versus native settings and drift/replacement rules | D04, D06 |
| `manage-sandboxes/set-up-discord.mdx` | Hold | `agents.md`, previous-version channel guide: require a qualified native procedure | D06 |
| `manage-sandboxes/set-up-google-chat.mdx` | Hold | `agents.md`, previous-version channel guide: webhook, credentials, and exposure are not provisioned | D06 |
| `manage-sandboxes/set-up-microsoft-teams.mdx` | Hold | `agents.md`, previous-version channel guide: no managed webhook/channel equivalent | D06 |
| `manage-sandboxes/set-up-slack.mdx` | Hold | `agents.md`, previous-version channel guide: native tokens, egress, and persistence need qualification | D06 |
| `manage-sandboxes/set-up-telegram.mdx` | Hold | `agents.md`, previous-version channel guide: native enrollment and token prerequisites | D06 |
| `manage-sandboxes/set-up-wechat.mdx` | Hold | `agents.md`, previous-version channel guide: native pairing and session retention prerequisites | D06 |
| `manage-sandboxes/set-up-whatsapp.mdx` | Hold | `agents.md`, previous-version channel guide: native pairing and session retention prerequisites | D06 |
| `manage-sandboxes/transfer-state-manually.mdx` | Rewrite | `state.md`, `migration.md`: verify supported native-data transfer; remove upload/download/backup-all commands | D04 |
| `manage-sandboxes/uninstall-nemoclaw.mdx` | Rewrite | `usage.md`, `state.md`: deployment destroy versus removal of local bundle; enumerate retained resources without inventing purge | D04 |
| `manage-sandboxes/update-sandboxes.mdx` | Rewrite | `usage.md`, `migration.md`: image/schema compatibility, refused replacement, parallel deployment | D04 |
| `manage-sandboxes/workspace-files.mdx` | Rewrite | `state.md`, `agents.md`: current native paths and deletion; no inherited host-mount or backup guarantee | D04, D06 |

## Monitoring — 5 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `monitoring/manage-deepagents-trace-export.mdx` | Hold | `migration.md`: no declared collector lifecycle; preserve old instructions by version | D06 |
| `monitoring/monitor-sandbox-activity.mdx` | Rewrite | `troubleshooting.md`, `sdk.md`: supported diagnostics, native logs/access, and SDK progress; no doctor/status/debug equivalence | D04, D07 |
| `monitoring/set-up-deepagents-trace-export.mdx` | Hold | `migration.md`: OTLP/LangSmith setup is not a current declared workflow | D06 |
| `monitoring/understand-deepagents-trace-export.mdx` | Hold | `migration.md`, `security.md`: previous trace privacy guidance remains versioned; no new telemetry claim | D06, D08 |
| `monitoring/verify-deepagents-trace-export.mdx` | Hold | `migration.md`: no current end-to-end trace qualification | D06 |

## Network Policy — 10 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `network-policy/apply-policy-presets.mdx` | Rewrite | `sandbox-network.md`: isolated preset or full explicit policy; no maintained-preset CLI | D08 |
| `network-policy/approve-network-requests.mdx` | Hold | `sandbox-network.md`, `migration.md`: external live edits can drift from intent; no current NemoClaw approval workflow | D08 |
| `network-policy/change-baseline-network-policy.mdx` | Rewrite | `sandbox-network.md`: full explicit policy, defaults, replacement, and data-loss effects | D08 |
| `network-policy/configure-raw-tls-passthrough.mdx` | Merge | `sandbox-network.md`: retain only fields accepted by the pinned explicit-policy parser; review enforcement tradeoffs | D08 |
| `network-policy/create-custom-policy-presets.mdx` | Rewrite | `sandbox-network.md`: author validated explicit policy instead of preset files | D08 |
| `network-policy/customize-network-policy.mdx` | Merge | `sandbox-network.md`: one owner for declared policy changes and drift | D08 |
| `network-policy/explain-network-policy-to-agents.mdx` | Hold | `sandbox-network.md`, `migration.md`: no policy-explain command; do not imply agent-side inspection | D08 |
| `network-policy/integration-policy-examples.mdx` | Merge | `sandbox-network.md`: qualify reusable explicit-policy examples individually; old integrations remain held | D08 |
| `network-policy/replace-live-network-policy.mdx` | Rewrite | `sandbox-network.md`: ordinary apply rejects policy replacement; document supported recreation and preservation steps | D08 |
| `network-policy/set-up-gmail-with-an-app-password.mdx` | Hold | `agents.md`, previous-version integration guide: credential/mount/access prerequisites lack a complete current workflow | D06, D08 |

## Reference — 15 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `reference/architecture.mdx` | Rewrite | `overview.md`, `design/architecture.md`: current deployment and state ownership | D02 |
| `reference/cli-selection-guide.mdx` | Rewrite | `overview.md`, `reference/cli.md`, `agents.md`: NemoClaw, SDK, OpenShell, and native runtime responsibilities | D02 |
| `reference/commands.mdx` | Rewrite | `reference/cli.md`: current parser/help and process behavior | D02 |
| `reference/configure-runtime-identity.mdx` | Hold | `security.md`, `migration.md`: old identity/policy integration is not part of the current declared contract | D08 |
| `reference/enterprise-readiness.mdx` | Rewrite | `overview.md`, `security.md`, `prerequisites.md`: explicit limits; no enterprise qualification inferred from unit tests | D02, D08 |
| `reference/extension-taxonomy-sdk-readiness.mdx` | Rewrite | `sdk.md`, `provider.md`, `recipes.md`, `agents.md`: actual extension and ownership boundaries | D07 |
| `reference/headless-lifecycle-package.mdx` | Rewrite | `sdk.md`, `migration.md`: Rust lifecycle SDK versus former TypeScript observe/plan package | D07 |
| `reference/host-files-and-state.mdx` | Rewrite | `state.md`: deployment directories, intent/bindings/runtime state, bundle, tokens, and persistent volumes | D04 |
| `reference/network-policies.mdx` | Merge | `sandbox-network.md`, `reference/configuration.md`: procedural owner plus generated fields | D08 |
| `reference/pi-commands.mdx` | Merge | `reference/cli.md`, `agents.md`: shared CLI and Pi-native access | D02, D06 |
| `reference/pi-support.mdx` | Rewrite | `agents.md`, `prerequisites.md`: current external-service requirements, API metadata, and evidence limits | D06 |
| `reference/platform-support.mdx` | Rewrite | `prerequisites.md`: client/runtime/engine/GPU matrix backed by revision-specific evidence | D03 |
| `reference/system-readiness.mdx` | Rewrite | `prerequisites.md`, `troubleshooting.md`: verifiable preflight steps; no `host probe` command | D03, D04 |
| `reference/troubleshoot-mcp-servers.mdx` | Hold | `migration.md`, previous-version MCP guide: current CLI lacks managed MCP lifecycle | D06 |
| `reference/troubleshooting.mdx` | Rewrite | `troubleshooting.md`: errors and recovery from current code; remove legacy repair commands | D04 |

## Resources — 4 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `resources/agent-skills.mdx` | Rewrite | `resources.md`: version-aware Markdown, search/MCP, starter prompt, and routing skill | D08 |
| `resources/community-contributions.mdx` | Merge | `resources.md`: contribution destinations and current accepted product boundary | D08 |
| `resources/engineer-agentic-documentation.mdx` | Merge | `CONTRIBUTING.md`: retain applicable contributor guidance; archive main-specific automation description | D01 |
| `resources/license.mdx` | Rewrite | `resources.md`, component notices: original and derived-source licenses, including Qwen3.8 attribution | D08 |

## Security — 9 Sources

| Source | Disposition | Destination and required change | Package |
|---|---|---|---|
| `security/best-practices.mdx` | Rewrite | `security.md`: current controls and limits by owner, environment, and qualification | D08 |
| `security/configure-corporate-ca-trust.mdx` | Rewrite | `security.md`: distinguish gateway mTLS, endpoint trust, image trust, and native runtime trust; no inherited CA-import automation | D08 |
| `security/credential-rotation.mdx` | Rewrite | `security.md`: unchanged-reference rotation is not automatically detected; native interface token replacement and upstream revocation | D08 |
| `security/credential-storage.mdx` | Rewrite | `security.md`: environment/file references, child-process access, gateway persistence, native token lifetimes, and redaction | D08 |
| `security/filesystem-controls.mdx` | Merge | `sandbox-network.md`, `security.md`: exact filesystem policy, shared sandbox boundaries, and Landlock mode | D08 |
| `security/gateway-authentication-controls.mdx` | Rewrite | `security.md`, `interfaces.md`: OpenShell mTLS/bearer versus native agent tokens and pairing | D08 |
| `security/openclaw-controls.mdx` | Rewrite | `security.md`, `agents.md`: pinned native controls versus NemoClaw-owned roster/tools; no blanket protection claims | D08 |
| `security/process-controls.mdx` | Merge | `sandbox-network.md`, `security.md`: current process policy, image settings, and enforcement evidence | D08 |
| `security/tcb-boundary.mdx` | Rewrite | `security.md`, `overview.md`: SDK/provider/OpenTofu, engines, OpenShell, Fabric, native agents, recipes, and models | D02, D08 |

## History and Publication Inputs

These are additional inputs, outside the 125-source table count.
Audit generated products as routes, not as independently authored pages.

| Source or input at the main baseline | Disposition and deliverable | Package |
|---|---|---|
| `docs/changelog/*.mdx` — 75 dated files and `overview.mdx` | History: preserve all 76 sources in previous-version release history, including their internal route targets; create next-version release notes separately | D01, D09 |
| `docs/index.yml` | Derive all 300 page entries plus generated changelog URLs; rebuild navigation from current page ownership | D01, D02 |
| `fern/docs.yml` | Inventory all 410 redirect rules, versions, instances, theme, and assets; specify version cutover and rollback | D01 |
| `fern/fern.config.json`, `fern/main.css`, `fern/assets/`, `fern/components/`, `docs/_components/` | Reuse only required publication inputs; inspect components for old release/installer assumptions | D01 |
| `docs/about/images/nemoclaw-highlevel-component-diagram.png` | Replace the obsolete architecture illustration from current ownership boundaries; preserve attribution if adapting it | D02 |
| `docs/resources/starter-prompt.md` and `docs/resources/prompt-assets/{dgx-spark,dgx-station,windows-wsl}.md` | Rewrite current workflow and version selection; preserve immutable old prompt URLs; update pins only to existing content | D08 |
| `docs/resources/local-credential-form.html` | Hold the old helper/form flow; current credentials use references; retain only if a reviewed current consumer needs it | D08 |
| `.agents/skills/nemoclaw-user-guide/` and its routing consumers | Rewrite version detection/routing; keep the skill small and point to canonical docs; test wrong-version avoidance | D08 |
| `scripts/sync-agent-variant-docs.mts`, `scripts/generate-starter-prompt.mts`, `scripts/check-docs-published-routes.mts`, `scripts/check-env-var-docs.mts`, `scripts/generate-platform-docs.py` | Inspect dependencies and reuse useful behavior; adapt to shared Markdown and current contracts; do not restore old generated facts | D01 |
| `scripts/fern-preview-config.mts`, `scripts/watch-fern-preview.mts`, docs npm scripts and their locked dependencies | Choose a minimal reproducible docs toolchain and preview workflow | D01 |
| `.github/workflows/docs-{cli-parity-pr,links-pr,preview-pr,publish-public,publish-staging}.yaml` | Rebuild validation/preview/publish triggers for the chosen versioning model and `v1` release source; preserve credential boundaries | D01 |
| `.github/workflows/post-merge-docs.yaml`, `tools/post-merge-docs/`, `docs/.docs-skip` | Decide change-impact and release-cutoff workflow; old main/tag/npm assumptions need explicit replacement | D01, D09 |
| `docs/{AGENTS,CONTRIBUTING,STYLE,AUTOMATION,DORI_SETUP}.md`, `fern/AGENTS.md`, documentation contributor/maintainer skills | Current `WRITING.md` and `docs/CONTRIBUTING.md` remain authoritative; add chosen publication procedures to their owners | D01 |
| `docs/security/advisory-early-warning.md` | History: internal npm-era audit/automation evidence; do not present as current Rust dependency policy | D08 |
| Root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, repository links and badges | Update product entry points, private security-reporting route, contribution links, versions, and public doc links | D02, D08, D09 |

## New Surface with No Complete Main Guide

These additions are required even when no old page maps to them directly.

| Current surface | Destination | Package |
|---|---|---|
| Immutable verified native bundle and bundled schema | `build.md`, `prerequisites.md`, `get-started.md` | D03 |
| Full public Rust lifecycle SDK, cancellation, progress, secret resolution, and persistent state | `sdk.md` | D07 |
| Production OpenTofu provider, resource/configuration schema, packaging, and state ownership | `provider.md` | D07 |
| Revision-matched JSON Schema/editor assistance and generated field reference | `usage.md`, `reference/configuration.md`; maintainer process in `configuration-schema.md` | D02, D03 |
| Ownership/generation/durable identity, complete observations, locking, explicit reconciliation | `usage.md`, `state.md`, `troubleshooting.md` | D04 |
| Data retention by resource and no lost-state adoption/purge | `state.md`, `migration.md` | D04 |
| Generic managed model selection, inline recipes, memory supervision, and recovery | `models.md`, `recipes.md`, `troubleshooting.md` | D05 |
| SSH-selected engine identity and separation of engine control from inference reachability | `remote-service.md`, `prerequisites.md` | D05 |
| Ten Fabric harnesses with differing API/management support | `agents.md`, `inference.md` | D05, D06 |
| Declarative OpenClaw roster, read-only tools, disclosure, execution, and interface settings | `agents.md`, `interfaces.md` | D06 |
| Hermes API/dashboard/TUI session separation and credentials | `interfaces.md`, `security.md` | D06, D08 |

## Inventory Acceptance

D00 confirms that every baseline source appears exactly once in the MDX tables and that the historical/input groups cover the remaining publication assets.
D01 expands source rows into actual routes and anchors using the baseline navigation and redirect rules.
Each implementation change records its source disposition, current owner, affected variants/routes, and validation in its review description.
D09 reconciles later main/v1 changes and verifies all current public surfaces and all old routes before cutover.
