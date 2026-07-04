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
- Channel render/build-file targets must stay inside `/sandbox/.openclaw` or `/sandbox/.hermes`; rely on existing applier validation instead of bypassing it.
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
6. Add or update `src/lib/messaging/channels/<channel>/policy/<agent>.yaml` when the manifest declares a channel policy preset.
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

## Unsupported Agent Boundaries

LangChain Deep Agents Code is a terminal-oriented harness. NemoClaw does not run a long-running messaging bridge inside the DeepAgents sandbox today, and no built-in channel manifest lists `langchain-deepagents-code` under `supportedAgents`.

- **No artifact-only support.** Do not add DeepAgents messaging render targets, Dockerfile plan args, startup env parsing, or local contract files without a real bridge that routes channel messages to and from `dcode`.
- **No inbound bridge.** The harness does not spawn channel bot processes. Inbound messages from Telegram, Discord, Slack, or other channels do not currently reach `dcode`. `channels add` must reject DeepAgents before policy, provider, credential, registry, or rebuild mutation while this remains true.
- **Support condition.** Adding DeepAgents support requires a channel manifest `supportedAgents` entry, a build/runtime applier path for that agent, and a runtime bridge/health path before public behavior claims channel readiness.

## Agent Gating and Stale Plan Cleanup

- **Invalid state.** A sandbox can be configured with an agent name that no channel manifest supports, or with stale `NEMOCLAW_MESSAGING_PLAN_B64` state from an earlier build. Without an explicit gate the channel-add path can still tear down the sandbox before failing at `dockerfile-patch.ts`, and rebuild can carry stale messaging plan data into an agent build path that does not consume it.
- **Source boundary.** Channel manifests' `supportedAgents` lists are the single source of truth for whether a given agent supports messaging today, and which channels are available for it. Helpers in `utils.ts` derive the supported agent list from the active channel manifest registry, so `ChannelManifestRegistry.listAvailable`, `MessagingWorkflowPlanner.supportedChannelIds`, onboard state filtering, channel list, channel add/remove, and rebuild all share the same semantics. If no manifest supports the agent, deny or skip everywhere and clear stale staged plans.
- **Source-fix constraint.** Expanding support for an agent requires per-channel `supportedAgents`, agent-side render and hook handlers in `applier/build/messaging-build-applier.mts`, the matching Dockerfile/build env plumbing when needed, and a runtime bridge/health path when public behavior claims channel readiness. Until that stack lands, the gate at the action boundary is the safe behavior: surface the unsupported-agent message in `addSandboxChannel`, clear the staged plan in `stageMessagingManifestPlanForRebuild`, and strip stale plans in `persistManifestChannelRemovePlan`.
- **Regression tests.** `src/lib/messaging/utils.test.ts`, `src/lib/messaging/manifest/registry.test.ts`, and `src/lib/messaging/compiler/workflow-planner.test.ts` lock the helper and registry semantics. `src/lib/actions/sandbox/policy-channel-agent-gate.test.ts`, `src/lib/actions/sandbox/policy-channel-cleanup.test.ts`, `src/lib/actions/sandbox/rebuild-messaging-stage.test.ts`, and `src/lib/onboard/machine/handlers/sandbox.test.ts` cover the action, rebuild, and onboard-resume boundaries against stale or unsupported messaging plans. `test/channels-add-deepagents-rejection.test.ts` exercises the full DeepAgents `addSandboxChannel` boundary in a spawned Node process to prove no policy, provider, registry, credential, or rebuild call happens before the unsupported-agent exit.
- **Removal condition.** Drop the unsupported-agent gate only when every target agent is represented by channel manifest `supportedAgents` entries and `applier/build/messaging-build-applier.mts` resolves its render and runtime targets. At that point the unsupported-agent branch becomes unreachable for that agent and the action boundary can rely on planner-level validation alone.
