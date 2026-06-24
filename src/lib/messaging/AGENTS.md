<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Instructions for `src/lib/messaging`

## Purpose

This package owns NemoClaw's manifest-first messaging architecture. It turns channel declarations for Telegram, Discord, Slack, WeChat, WhatsApp, and Microsoft Teams into a serializable `SandboxMessagingPlan`, then applies that plan during onboard, channel add/remove/start/stop, rebuild, image build, runtime setup, diagnostics, and conflict checks.

The design goal is to keep messaging channel behavior out of core onboard/rebuild logic. Add channel-specific behavior to manifests, template resolvers, hooks, runtime assets, and policy metadata first; only change shared engines when the manifest vocabulary cannot express the required behavior.

## Data Flow

1. Channel manifests live in `channels/<channel>/manifest.ts` and are registered by `channels/built-ins.ts`.
2. `MessagingWorkflowPlanner` selects the right workflow shape for onboard, add, remove, start, stop, or rebuild.
3. `ManifestCompiler` and `compiler/engines/*` compile manifests into a `SandboxMessagingPlan`.
4. `MessagingSetupApplier` serializes the plan through `NEMOCLAW_MESSAGING_PLAN_B64`.
5. `onboard/dockerfile-patch.ts` bakes the plan into the sandbox build.
6. `applier/build/messaging-build-applier.mts` applies agent install, render, post-agent-install build files, and writes the reduced runtime plan artifact.
7. `MessagingHostStateApplier` persists durable plan state under the sandbox registry entry.
8. Rebuild reads the persisted plan, stages a fresh build plan, and reapplies OpenClaw render/post-install hooks after `openclaw doctor` rewrites config.

## Package Map

| Path | Ownership |
|---|---|
| `manifest/` | Serializable manifest and plan contracts. Keep these JSON-compatible. |
| `channels/` | Built-in channel manifests, channel metadata helpers, template resolvers, runtime preload assets, and channel hook implementations. |
| `compiler/` | Manifest-to-plan compilation. It may resolve env/config inputs and run enrollment/reachability/build hooks, but should not mutate OpenShell or registry state directly. |
| `hooks/` | Hook contracts, registries, runner validation, common prompt/static-output helpers, and conflict error types. |
| `applier/` | Host/OpenShell side effects: plan env serialization, provider upsert/reuse, policy apply, agent config writes, hook phase execution, conflict detection, registry persistence, and build-time applier. |
| `persistence.ts` | Compact persisted plan shape and hydration from current manifests. |
| `plan-validation.ts` | Defensive parsing for persisted or env-provided plans. |
| `diagnostics.ts` | Manifest-derived channel diagnostics used by status/doctor paths. |
| `utils.ts` | Agent/channel availability and selection helpers. |

## Core Invariants

- Manifests and compiled plans are serializable data. Do not put functions, classes, live clients, or raw secret values in them.
- Secret inputs must not declare `statePath`; persisted plans may contain `credentialAvailable`, `credentialHash`, and placeholders, never tokens.
- Hook implementations are resolved by stable handler IDs through `MessagingHookRegistry`. Manifests reference handlers by string; they do not import handler code.
- Hook outputs must match manifest declarations and be JSON-serializable. Add outputs to the manifest before consuming them.
- Channel render/build-file targets must stay inside `/sandbox/.openclaw`, `/sandbox/.hermes`, or `/sandbox/.deepagents`; rely on existing applier validation instead of bypassing it.
- Disabled channels are not active. Always filter effects through `enabledPlanChannels()` or `filterEnabledPlanEntries()` when applying providers, policies, render, hooks, runtime setup, or conflicts.
- Conflict detection has two axes: generic credential-hash overlap in `applier/conflict-detection/` and channel-owned `pre-enable` hooks such as Slack Socket Mode gateway checks.
- Keep transitional compatibility tables derived from manifests. `src/lib/sandbox/channels.ts` intentionally builds legacy CLI metadata from `listBuiltInMessagingChannelManifests()`.

## Adding or Changing a Channel

Start with `channels/<channel>/manifest.ts`.

1. Declare `auth`, `inputs`, `credentials`, `policyPresets`, `render`, `runtime`, `agentPackages`, `state`, and `hooks` in the manifest.
2. Add template placeholders to `channels/<channel>/template-resolver.ts` when static render data needs derived values such as allowlists, booleans, proxy URLs, or Hermes/OpenClaw schema differences.
3. Add hook implementations under `channels/<channel>/hooks/` only for side effects or checks that cannot be represented as static manifest data.
4. Register hook handlers in the channel `hooks/index.ts` and in `hooks/builtins.ts`.
5. Add runtime preload assets under `channels/<channel>/runtime/` only when the agent runtime needs boot/connect-time shims or diagnostics.
6. Add or update `nemoclaw-blueprint/policies/presets/<channel>.yaml` when the manifest declares a channel policy preset.
7. Cover the behavior with manifest/compiler tests plus applier/onboard/channel CLI tests when host effects change.

## Where Changes Belong

- New prompt, token, allowlist, provider, policy, render, package install, runtime setup, state hydration, or health-check metadata belongs in a channel manifest.
- Nontrivial render derivation belongs in a channel template resolver.
- Enrollment, external reachability checks, QR capture, channel-specific conflict checks, runtime status, and health probes belong in hooks.
- Provider creation/reuse, policy application, config-file writes, plan env encoding, and registry persistence belong in `applier/`.
- Onboard and `actions/sandbox/policy-channel.ts` should orchestrate planner/applier calls, not grow channel-specific rules.
- Build-time config generation should use the compiled plan and `applier/build/messaging-build-applier.mts`; do not reintroduce channel-specific config rendering in `scripts/generate-openclaw-config.mts` or `agents/hermes/generate-config.ts`.

## Testing Guide

Use the narrowest test that covers the changed surface:

- Manifest shape and plan compilation: `npx vitest run src/lib/messaging/compiler src/lib/messaging/manifest src/lib/messaging/channels`
- Hook behavior: `npx vitest run src/lib/messaging/hooks src/lib/messaging/channels/<channel>/hooks`
- Host/OpenShell application: `npx vitest run src/lib/messaging/applier`
- Build-time render/install behavior: `npx vitest run test/messaging-build-applier.test.ts`
- Onboard/channel CLI integration: `npx vitest run test/onboard-messaging.test.ts test/channels-add-preset.test.ts src/lib/onboard/messaging-channel-setup.test.ts`

Mock external messaging APIs. Do not call real Telegram, Discord, Slack, WeChat, WhatsApp, Microsoft Teams, NVIDIA, or OpenShell services from unit tests.

## Documentation

User-facing behavior changes usually need docs under `docs/manage-sandboxes/messaging-channels.mdx` or `docs/reference/commands.mdx`.
Update `.agents/skills/nemoclaw-user-guide/SKILL.md` only when AI-agent docs routing guidance changes.

## DeepAgents Messaging Artifact Contract

LangChain Deep Agents Code is a terminal-oriented harness. NemoClaw does not run a long-running messaging bridge inside the DeepAgents sandbox today; the integration is artifact-only and is not advertised as public channel support.

- **Build-time artifacts.** The build applier can render DeepAgents env-lines fragments to `~/.deepagents/.env` and JSON fragments to `~/.deepagents/messaging.json` for local contract validation. The DeepAgents agent manifest keeps `messaging_platforms.supported: []`, and built-in channel manifests do not list DeepAgents under `supportedAgents`, until a bridge exists.
- **Startup consumer.** `agents/langchain-deepagents-code/start.sh` parses `~/.deepagents/.env` as data with a strict messaging-key allowlist before launching `dcode`, so messaging-related env vars (Telegram bot token, Discord guild ids, Slack app token, etc.) are present in the agent process environment without executing generated shell content.
- **No inbound bridge.** The harness does not spawn channel bot processes. Inbound messages from Telegram, Discord, or Slack do not currently reach `dcode`. `channels add` must reject DeepAgents before policy, provider, credential, registry, or rebuild mutation while this remains true. The Ready state reported after rebuild reflects the agent runtime, not channel reachability. A future change must add a bot/bridge process before claiming end-to-end channel functionality.
- **Removal condition.** Drop this artifact-only contract once a DeepAgents-side messaging bridge (or upstream `dcode` feature) consumes `~/.deepagents/messaging.json` and routes messages to/from `dcode`. Until then, this section is the documented limit of the integration.

## Agent Gating and Stale Plan Cleanup

- **Invalid state.** A sandbox can be configured with an agent whose manifest declares no messaging support (`messaging_platforms.supported: []`) or an agent name outside the messaging runtime allowlist. Without an explicit gate the channel-add path can still tear down the sandbox before failing at `dockerfile-patch.ts`, and a rebuild can carry a stale `NEMOCLAW_MESSAGING_PLAN_B64` into the Dockerfile patch step for an agent that does not declare the matching `ARG`. The current runtime allowlist is `openclaw`, `hermes`, and `langchain-deepagents-code` — see `MESSAGING_AGENT_IDS` in `utils.ts`.
- **Source boundary.** The agent manifest's `messaging_platforms.supported` list is the single source of truth for whether a given agent supports messaging today, and which channels are available for it. The `MessagingAgentId` union in `applier/build/messaging-build-applier.mts` is the runtime allowlist for build-time messaging integration. Both are checked at the action boundary by `isMessagingSupportedAgent(agent)` and `tryGetMessagingAgentId(agent)` in `utils.ts`. The `ChannelManifestRegistry.listAvailable` and `MessagingWorkflowPlanner.supportedChannelIds` paths share these semantics, so an explicit empty allowlist means deny-all everywhere, and a populated allowlist filters to that subset.
- **Source-fix constraint.** Expanding `messaging_platforms.supported` for an agent requires the matching Dockerfile `ARG NEMOCLAW_MESSAGING_PLAN_B64=`, a `MessagingAgentId` entry, per-channel `supportedAgents`, agent-side render and hook handlers in `applier/build/messaging-build-applier.mts`, and a runtime bridge/health path when the public behavior claims channel readiness. Until that stack lands, the gate at the action boundary is the only safe behavior — surfacing the unsupported-agent message in `addSandboxChannel`, clearing the staged plan in `stageMessagingManifestPlanForRebuild`, and stripping stale plans in `persistManifestChannelRemovePlan`.
- **Regression tests.** `src/lib/messaging/utils.test.ts`, `src/lib/messaging/manifest/registry.test.ts`, and `src/lib/messaging/compiler/workflow-planner.test.ts` lock the helper and registry semantics. `src/lib/actions/sandbox/policy-channel-agent-gate.test.ts`, `src/lib/actions/sandbox/policy-channel-cleanup.test.ts`, `src/lib/actions/sandbox/rebuild-messaging-stage.test.ts`, and `src/lib/onboard/machine/handlers/sandbox.test.ts` cover the action, rebuild, and onboard-resume boundaries against stale or unsupported messaging plans. `test/channels-add-deepagents-rejection.test.ts` exercises the full DeepAgents `addSandboxChannel` boundary in a spawned Node process to prove no policy, provider, registry, credential, or rebuild call happens before the unsupported-agent exit.
- **Removal condition.** Drop the gate (or shrink it back to known runtimes only) once the targeted agent has a Dockerfile `ARG NEMOCLAW_MESSAGING_PLAN_B64=`, a `MessagingAgentId` entry, populated `messaging_platforms.supported`, the channel manifests list it under `supportedAgents`, and `applier/build/messaging-build-applier.mts` resolves its render and runtime targets. At that point the empty-allowlist branch becomes unreachable for that agent and the action boundary can rely on planner-level validation alone.
