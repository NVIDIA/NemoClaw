<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Messaging Network Policy Technical Flow

This note describes how NemoClaw messaging channel manifests interact with OpenShell network policy for OpenClaw and Hermes sandboxes.
It is an internal technical reference for maintainers and contributors.
It is not part of the published user documentation under `docs/`.

The goal is to make the full lifecycle explicit:

- Onboarding.
- Channel add.
- Channel remove.
- Channel stop.
- Channel start.
- Rebuild.
- `policy-add`.
- `policy-remove`.
- `policy-list`.
- Status and diagnostics paths that read the same state.

## Executive Summary

Messaging channel configuration and network policy are separate but linked state.
The channel manifest declares what the channel needs.
The compiled messaging plan records the desired channel state.
OpenShell network policy decides whether the sandbox can reach the messaging provider.

The most important invariant is:

```text
Active channel config must not be built without the policy path that lets the channel reach its upstream API.
Disabled channels must not contribute render output, host forwards, runtime setup, or required policy entries.
Raw channel secrets must not be serialized into plans, registry state, Docker build args, policy files, or agent config.
```

The current implementation is manifest-first, but not every policy mutation is plan-applier-first.
The plan contains manifest-derived `networkPolicy.entries`, and `MessagingSetupApplier.applyPolicyAtOpenShell()` can apply those entries.
However, the live channel command paths currently call the generic policy helpers with the channel-named preset directly.
This works today because every built-in messaging channel has a matching built-in preset name.
If a future channel needs `channelId !== presetName`, the channel command paths must stop assuming the canonical channel ID is also the preset name.

## Primary Source Files

### Manifest And Plan Contracts

| File | Responsibility |
|------|----------------|
| `src/lib/messaging/manifest/types.ts` | Defines `ChannelManifest`, `SandboxMessagingPlan`, `SandboxMessagingNetworkPolicyPlan`, hook phases, credential bindings, render entries, build steps, runtime setup, state updates, and workflow names. |
| `src/lib/messaging/manifest/registry.ts` | Provides the channel manifest registry interface. |
| `src/lib/messaging/channels/built-ins.ts` | Registers current built-in channel manifests. |
| `src/lib/messaging/channels/metadata.ts` | Derives legacy metadata from manifests, including policy preset maps, credential metadata, agent policy key aliases, and validation warnings. |
| `src/lib/messaging/compiler/workflow-planner.ts` | Builds workflow-specific plans for onboard, add, remove, stop, start, and rebuild. |
| `src/lib/messaging/compiler/manifest-compiler.ts` | Compiles manifests into serializable plan sections. |
| `src/lib/messaging/compiler/engines/policy-resolver.ts` | Converts manifest `policyPresets` into plan `networkPolicy.entries`. |

### Host Appliers

| File | Responsibility |
|------|----------------|
| `src/lib/messaging/applier/setup-applier.ts` | Encodes, decodes, reads, writes, and applies messaging plans. |
| `src/lib/messaging/applier/policy.ts` | Applies active plan policy entries through an injected `applyPresets` callback. |
| `src/lib/messaging/applier/openshell-provider.ts` | Creates, updates, and attaches OpenShell providers for channel credentials. |
| `src/lib/messaging/applier/host-state-applier.ts` | Persists the durable compact messaging plan in the sandbox registry. |
| `src/lib/messaging/applier/plan-filter.ts` | Filters plan entries to active, non-disabled channels. |
| `src/lib/messaging/applier/build/messaging-build-applier.mts` | Applies the messaging plan inside the sandbox image build. |

### Policy Helpers

| File | Responsibility |
|------|----------------|
| `src/lib/policy/index.ts` | Loads built-in and custom presets, merges policy YAML, applies and removes presets with `openshell policy set --wait`, and computes `policy-list` gateway matches. |
| `src/lib/onboard/initial-policy.ts` | Builds the initial sandbox create policy, including create-time messaging presets and Hermes inactive-message-policy pruning. |
| `src/lib/onboard/messaging-policy-presets.ts` | Maps selected or disabled channels to policy presets using manifest-derived metadata. |
| `src/lib/onboard/policy-selection.ts` | Merges tier defaults, enabled channel presets, required channel presets, and agent-required presets. |
| `src/lib/onboard/policy-preset-sync.ts` | Reconciles live policy to the target policy preset set by applying and removing presets. |
| `src/lib/onboard/policy-resume-selection.ts` | Reconciles policy selection during resume, including disabled messaging cleanup. |

### Lifecycle Coordinators

| File | Responsibility |
|------|----------------|
| `src/lib/onboard/messaging-channel-setup.ts` | Selects channels during onboarding and writes `NEMOCLAW_MESSAGING_PLAN_B64`. |
| `src/lib/onboard/messaging-prep.ts` | Prepares OpenShell provider definitions for sandbox creation. |
| `src/lib/onboard/sandbox-create-plan.ts` | Computes active messaging channels, initial policy, create args, and providers for sandbox creation. |
| `src/lib/onboard/dockerfile-patch.ts` | Injects the encoded messaging plan into the staged Dockerfile build arg. |
| `src/lib/onboard/machine/handlers/policies.ts` | Connects active channels and disabled channels into policy selection and resume handling. |
| `src/lib/actions/sandbox/policy-channel.ts` | Implements `policy-add`, `policy-remove`, `policy-list`, and `channels add/remove/stop/start`. |
| `src/lib/actions/sandbox/rebuild.ts` | Stages messaging plans before rebuild, restores policy presets, reapplies OpenClaw messaging render after doctor, and verifies host forwards. |
| `src/lib/actions/sandbox/channel-status.ts` | Reads channel runtime status and plan state. |
| `src/lib/actions/sandbox/doctor-messaging.ts` | Reads messaging state for diagnostics. |

### Agent Policy Inputs

| File | Responsibility |
|------|----------------|
| `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` | Shared OpenClaw baseline sandbox policy. Messaging provider endpoints are not in this baseline. |
| `agents/hermes/policy-additions.yaml` | Hermes baseline policy. Messaging provider endpoints are not in this baseline. |
| `src/lib/messaging/channels/<channel>/policy/openclaw.yaml` | OpenClaw channel-owned network policy preset YAML for a messaging channel. |
| `src/lib/messaging/channels/<channel>/policy/hermes.yaml` | Hermes channel-owned network policy preset YAML for a messaging channel. |
| `nemoclaw-blueprint/policies/presets/<name>.yaml` | Built-in operator-facing policy presets for non-messaging integrations. |
| `agents/openclaw/manifest.yaml` | OpenClaw agent manifest. Its legacy policy path points to `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`. |
| `agents/hermes/manifest.yaml` | Hermes agent manifest. Its policy additions path is `agents/hermes/policy-additions.yaml`. |

## Data Model

### Channel Manifest

Each built-in channel manifest lives at:

```text
src/lib/messaging/channels/<channel>/manifest.ts
```

Policy-relevant manifest fields are:

| Field | Meaning |
|-------|---------|
| `supportedAgents` | Agents that may use this channel. Current built-ins list `openclaw` and `hermes`. Unsupported agents are rejected before policy, provider, registry, or rebuild mutation. |
| `policyPresets` | Operator-facing policy preset declarations needed when the channel is active. |
| `policyPresets[].name` | Preset name users see and pass to `policy-add`. Current built-ins use the channel ID. |
| `policyPresets[].policyKeys` | Concrete `network_policies` keys for the default policy source. |
| `policyPresets[].agentPolicyKeys` | Concrete `network_policies` keys for specific agents. Telegram maps `telegram` to Hermes key `telegram`. |
| `policyPresets[].requiredAtCreate` | Whether onboarding should force the preset into initial create-time policy and effective policy selection. Slack currently sets this. |
| `policyPresets[].validationWarningLines` | Extra warnings shown when a user applies the preset directly. Discord uses this to steer validation away from `curl`. |
| `credentials` | Provider binding declarations. The plan gets placeholders and availability, not raw tokens. |
| `render` | Agent config render entries for OpenClaw and Hermes. These are filtered to active channels. |
| `hostForward` | Inbound webhook port metadata. Teams declares this. This is not a network policy entry. |
| `runtime` | Runtime visibility, env aliasing, preload, and secret-scan metadata. |
| `agentPackages` | Agent package/plugin installs for active channels. |
| `hooks` | Enrollment, pre-enable, reachability, post-install, health, status, and diagnostic hooks. |

### Sandbox Messaging Plan

The compiled plan is `SandboxMessagingPlan`.
It is serialized through:

```text
NEMOCLAW_MESSAGING_PLAN_B64
```

The plan contains:

| Plan section | Meaning |
|--------------|---------|
| `channels` | Requested channels and whether each is active, selected, configured, or disabled. |
| `disabledChannels` | Channels configured but explicitly stopped. |
| `credentialBindings` | Provider names, env keys, placeholders, availability, and optional non-secret hashes. |
| `networkPolicy` | Manifest-derived preset names and concrete policy keys. |
| `agentRender` | OpenClaw JSON fragments, Hermes env lines, and Hermes YAML fragments. |
| `buildSteps` | Package installs, build args, and build-file hook outputs. |
| `runtimeSetup` | Runtime preloads, env aliases, and secret scans. |
| `stateUpdates` | Persisted non-secret channel state and rebuild hydration metadata. |
| `healthChecks` | Post-rebuild health checks. |

Plans are JSON-compatible.
They must not contain functions, class instances, or raw secrets.

### Registry State

The sandbox registry stores two independent policy-related concepts:

```text
registry.sandboxes.<sandbox>.messaging.plan
registry.sandboxes.<sandbox>.policies
registry.sandboxes.<sandbox>.customPolicies
```

`messaging.plan` is the desired channel state.
`policies` is the list of built-in preset names NemoClaw believes are applied.
`customPolicies` is the list of custom policy presets applied with `policy-add --from-file` or `policy-add --from-dir`.

These can drift.
For example, an active channel can exist while its policy preset has been manually removed.
Conversely, `policy-add telegram` can open egress without enabling Telegram channel configuration.

`policy-list` intentionally displays both local registry state and gateway-enforced state so drift is visible.

## Current Built-In Channel Policy Mapping

| Channel | Manifest preset name | OpenClaw concrete policy key | Hermes concrete policy key | OpenClaw YAML | Hermes YAML |
|---------|----------------------|------------------------------|----------------------------|---------------|-------------|
| `telegram` | `telegram` | `telegram_bot` | `telegram` | `src/lib/messaging/channels/telegram/policy/openclaw.yaml` | `src/lib/messaging/channels/telegram/policy/hermes.yaml` |
| `discord` | `discord` | `discord` | `discord` | `src/lib/messaging/channels/discord/policy/openclaw.yaml` | `src/lib/messaging/channels/discord/policy/hermes.yaml` |
| `slack` | `slack` | `slack` | `slack` | `src/lib/messaging/channels/slack/policy/openclaw.yaml` | `src/lib/messaging/channels/slack/policy/hermes.yaml` |
| `teams` | `teams` | `teams` | `teams` | `src/lib/messaging/channels/teams/policy/openclaw.yaml` | `src/lib/messaging/channels/teams/policy/hermes.yaml` |
| `wechat` | `wechat` | `wechat_bridge` | `wechat_bridge` | `src/lib/messaging/channels/wechat/policy/openclaw.yaml` | `src/lib/messaging/channels/wechat/policy/hermes.yaml` |
| `whatsapp` | `whatsapp` | `whatsapp` | `whatsapp` | `src/lib/messaging/channels/whatsapp/policy/openclaw.yaml` | `src/lib/messaging/channels/whatsapp/policy/hermes.yaml` |

Important details:

- Telegram's built-in preset name is `telegram`, but the OpenClaw concrete policy key is `telegram_bot`.
- Telegram's Hermes concrete policy key is `telegram`, selected through `agentPolicyKeys` and policy key aliases.
- WeChat's preset name is `wechat`, but the concrete policy key is `wechat_bridge`.
- Slack is marked `requiredAtCreate` in its manifest.
- Teams declares both a policy preset and a host forward.
  The forward handles inbound Bot Framework webhook traffic and is separate from outbound sandbox egress policy.
- WhatsApp has no host-side token provider.
  Pairing state is created inside the sandbox and policy only opens the external WhatsApp Web and media endpoints.

## Policy Loading And Agent Overrides

The user-visible preset name is resolved by `src/lib/policy/index.ts`.

For a built-in preset:

1. `loadPreset(presetName)` first checks whether the preset is a messaging channel preset.
2. Messaging channel presets resolve from `src/lib/messaging/channels/<channel>/policy/openclaw.yaml` by default.
3. `loadPresetForSandbox(sandboxName, presetName)` checks the sandbox agent and resolves Hermes messaging presets from `src/lib/messaging/channels/<channel>/policy/hermes.yaml`.
4. Non-messaging presets still resolve from `nemoclaw-blueprint/policies/presets/<presetName>.yaml`.
5. Legacy agent policy additions remain a fallback only for non-messaging agent-specific overrides.

This means `policy-add telegram` is not necessarily the same YAML for OpenClaw and Hermes.
OpenClaw gets the `telegram_bot` entry from `telegram/policy/openclaw.yaml`.
Hermes gets the `telegram` entry from `telegram/policy/hermes.yaml`.

The agent policy key alias map comes from manifests through:

```text
getMessagingPolicyKeyAliases()
```

This keeps agent override lookup tied to channel manifests instead of hard-coded policy tables.

## Onboarding Flow

### 1. Channel Selection

Entry point:

```text
src/lib/onboard/messaging-channel-setup.ts
```

`setupMessagingChannels()`:

1. Reads built-in manifests from `createBuiltInChannelManifestRegistry()`.
2. Filters channels through the selected agent's supported channel set.
3. In non-interactive mode, detects channels whose required manifest inputs are complete in env or credential store.
4. In interactive mode, renders a channel selector and seeds already-configured channels.
5. Calls `setupSelectedMessagingChannels()`.

`setupSelectedMessagingChannels()`:

1. Normalizes selected channel IDs.
2. Builds an `onboard` plan through `MessagingWorkflowPlanner.buildPlan()`.
3. Runs manifest enrollment hooks when interactive.
4. Writes the plan into `NEMOCLAW_MESSAGING_PLAN_B64`.
5. Deletes inactive selected channels from the enabled set.
6. Prints in-sandbox QR guidance for channels such as WhatsApp.

At this point, channel configuration is planned.
OpenShell policy is not fully reconciled yet.

### 2. Conflict And Preflight Checks

Relevant files:

```text
src/lib/onboard/sandbox-messaging-preflight.ts
src/lib/onboard/messaging-conflict-guard.ts
```

The preflight reads the staged plan and checks for conflicts before sandbox creation.
It respects `disabledChannels`.

Conflict checks include:

- Generic credential hash overlap between sandboxes.
- Channel-owned `pre-enable` hooks.
- Slack Socket Mode ownership.
- Teams host-forward port ownership.

Unsupported agents are blocked earlier through manifest support checks.
DeepAgents-style stale plans are stripped or skipped at action and rebuild boundaries.

### 3. Provider Preparation

Entry point:

```text
src/lib/onboard/messaging-prep.ts
```

`prepareCreateSandboxMessaging()`:

1. Derives token definitions from manifest credential metadata.
2. Filters token definitions to selected channels when a selected-channel list is available.
3. Removes token definitions for disabled channels.
4. Registers additional placeholder providers for available secrets.
5. Detects reusable providers that already exist in OpenShell.
6. Returns `messagingTokenDefs`, reusable provider names, reusable channel names, and disabled channel names.

Provider records are separate from network policy.
Providers attach secrets to the sandbox through OpenShell.
Policy allows outbound traffic to provider APIs.

### 4. Active Channel Derivation For Sandbox Create

Entry point:

```text
src/lib/onboard/sandbox-create-plan.ts
```

`prepareSandboxCreatePlan()` computes `activeMessagingChannels`.
A channel is active for create if it is not disabled and one of these holds:

- Its primary credential token is available.
- Its provider is reusable.
- It is selected and uses QR or in-sandbox pairing semantics.

The active channel list feeds:

- Initial sandbox policy preparation.
- Provider attachment to `openshell sandbox create`.
- Policy selection later in onboarding.

### 5. Initial Sandbox Create Policy

Entry point:

```text
src/lib/onboard/initial-policy.ts
```

`prepareInitialSandboxCreatePolicy(basePolicyPath, activeMessagingChannels, options)` builds the policy file passed to:

```text
openshell sandbox create --policy <policyPath>
```

#### OpenClaw

OpenClaw's baseline is `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.
It does not contain messaging provider endpoints.

The create-time policy adds:

- Messaging presets whose manifest sets `requiredAtCreate`.
- Other create-time additions such as some OpenClaw OTEL cases when not suppressed by policy tier.
- Agent or tool gateway additions passed through `additionalPresets`.

Currently Slack is the messaging preset marked `requiredAtCreate`.
Telegram, Discord, Teams, WeChat, and WhatsApp are generally applied later through the policy selection step or explicit `policy-add`.

#### Hermes

Hermes uses `agents/hermes/policy-additions.yaml` as its base policy.
That file contains baseline Hermes entries only.

Before create, `prepareInitialSandboxCreatePolicy()` treats all active Hermes messaging channel presets as create-time presets and merges them from channel-owned Hermes policy files.
`filterHermesInactiveMessagingPolicies()` remains as compatibility cleanup for older Hermes policy files that still contain embedded messaging templates.
The mapping from channel to Hermes policy keys is still derived from manifests through `getMessagingPolicyKeysByChannel({ agent: "hermes" })`.

This prevents a Hermes sandbox from getting Telegram, Discord, Slack, Teams, WeChat, or WhatsApp egress merely because the Hermes baseline file exists.

If an active Hermes channel's policy entry is already present in the filtered base policy, `prepareInitialSandboxCreatePolicy()` records it as already applied.
If an active create-time preset is absent from the base policy, the initial-policy helper merges channel-owned Hermes preset YAML by name.

Current consequence:

- Hermes Slack, Telegram, Discord, Teams, WeChat, and WhatsApp use policy files under `src/lib/messaging/channels/<channel>/policy/hermes.yaml`.
- Hermes baseline policy can change independently from messaging channel egress.

### 6. Dockerfile Plan Injection

Entry point:

```text
src/lib/onboard/dockerfile-patch.ts
```

`patchStagedDockerfile()` reads `NEMOCLAW_MESSAGING_PLAN_B64`.
If a plan exists, it hydrates derived plan fields and replaces:

```text
ARG NEMOCLAW_MESSAGING_PLAN_B64=...
```

in the staged Dockerfile.

If the Dockerfile lacks that arg, patching fails.
This prevents a selected channel from silently disappearing from the image build.

### 7. Build-Time Applier

Entry point:

```text
src/lib/messaging/applier/build/messaging-build-applier.mts
```

The build applier reads `NEMOCLAW_MESSAGING_PLAN_B64` and validates that it matches the target agent.
It filters all build work to active, non-disabled channels.

For OpenClaw, it can:

- Install declared OpenClaw plugins.
- Run `openclaw doctor --fix` with messaging credential placeholder env overrides.
- Render `openclaw.json` channel and plugin fragments.
- Apply post-agent-install build-file hook outputs.
- Write the reduced runtime plan artifact.

For Hermes, it can:

- Render `~/.hermes/.env` lines.
- Render `~/.hermes/config.yaml` fragments.
- Validate trusted Hermes `uv` package specs before root-time installation.
- Write the reduced runtime plan artifact.

Build-time validation treats `NEMOCLAW_MESSAGING_PLAN_B64` as a derived artifact, not root authority.
Hermes package specs are rechecked against trusted built-in manifests for active channels.

### 8. Policy Selection

Entry points:

```text
src/lib/onboard/machine/handlers/policies.ts
src/lib/onboard/policy-selection.ts
src/lib/onboard/policy-preset-sync.ts
```

The policy state handler gathers:

- Channels selected in the current onboarding run.
- Channels recorded in the onboard session messaging plan.
- Channels active in the sandbox registry messaging plan.
- Channels disabled in the registry plan.

`mergePolicyMessagingChannels()` merges selected, recorded, and active channels, then excludes disabled channels.

`setupPoliciesWithSelection()` then computes the target preset set from:

- Tier defaults.
- Enabled messaging channels.
- Required messaging channel presets.
- Web search configuration.
- Local inference.
- Hermes managed tool gateways.
- Agent-required additions.
- Previously applied presets that should be preserved.

Disabled messaging channel presets are pruned.
Restricted tier suppression can remove some agent-required presets.

Important behavior:

- Open policy tier can include messaging presets even if no channel is configured.
  Policy egress is allowed, but no channel bridge exists unless onboarding or `channels add` configured it.
- An operator can remove a non-required channel preset from the policy selector.
  The channel config can remain in the image, but its upstream egress will fail until the preset is re-applied.
- Required create-time channel presets are merged back into the effective selection.

The final target set is reconciled by `syncPresetSelection()`:

1. Remove applied presets not in the target.
2. Apply newly selected presets.
3. Use `applyPresets()` for batches of built-in presets when possible.
4. Use `applyPreset()` otherwise.
5. Persist the effective set back into the registry when reconciliation touched the live set.

## Channel Add Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
addSandboxChannel()
```

### Add Preconditions

`channels add <channel>` validates before prompting for tokens or mutating state:

1. A channel argument is required.
2. The channel manifest must exist.
3. The sandbox agent must support the manifest.
4. The built-in preset YAML named by the canonical channel ID must exist.
5. That preset YAML must contain parseable `network_policies` entries.

If preset YAML is missing or malformed, the command exits before:

- Token prompt.
- Provider registration.
- Registry write.
- Policy mutation.
- Rebuild prompt.

Current gotcha:

```text
channels add currently validates and applies a preset named after the canonical channel ID.
```

This is aligned with current built-ins.
It is not general enough for future channels whose manifest `policyPresets[].name` differs from the channel ID.

### Add Plan Creation

`planSandboxChannelAdd()`:

1. Hydrates non-secret stored config from the onboard session and registry.
2. Builds an `add-channel` plan through `MessagingWorkflowPlanner.buildChannelAddPlanFromSandboxEntry()`.
3. Merges the incoming channel plan with any existing registry plan.
4. Writes the plan to `NEMOCLAW_MESSAGING_PLAN_B64`.

### Add Conflict Checks

After planning, `channels add` runs:

- Generic credential hash conflict checks.
- Channel-owned `pre-enable` hooks.

Failure behavior:

- In interactive mode, the user can continue unless the hook failure is not a conflict error.
- In non-interactive mode, conflicts abort unless `--force` is used where supported.
- If the user aborts, no provider, policy, registry, or rebuild mutation has happened yet.

### Add Active Plan Assertion

`assertAddChannelPlanActive()` verifies the target channel is active.
If required secret or config inputs are missing, it prints the missing manifest input IDs and exits.

This matters for host-QR channels such as WeChat.
A cached token without required account metadata is not enough to build an active plan.

### Add Token Or Host-QR Channels

Token and host-QR channels currently include:

- Telegram.
- Discord.
- Slack.
- Microsoft Teams.
- WeChat.

The flow is:

1. Collect manifest credentials from env or credential store.
2. Persist acquired channel tokens locally for this run.
3. Register or update OpenShell bridge providers.
4. Apply the channel-named policy preset with `applyChannelPresetIfAvailable()`.
5. Persist the messaging plan to the sandbox registry.
6. Prompt for rebuild.
7. If rebuild runs immediately, verify host forwards and run manifest health checks.

Policy application happens before plan persistence.
If policy application fails on a fresh add after provider registration, `rollbackChannelAdd()` attempts to:

- Clear staged channel tokens.
- Detach and delete bridge providers.
- Restore prior local credential state when rotating an existing channel.
- Warn about residual gateway provider state when cleanup cannot be proven.

This prevents a sandbox from advertising an enabled channel while the policy preset failed to apply.

### Add In-Sandbox QR Channels

WhatsApp is the current in-sandbox QR channel.

The flow is:

1. Apply the channel-named policy preset.
2. Register no host-side channel provider because there is no host-side token.
3. Persist the active messaging plan.
4. Print pairing guidance.
5. Prompt for rebuild.
6. Pair inside the rebuilt sandbox.

Policy is applied before plan persistence so the channel is not rebuilt active without upstream egress.

### Add Rebuild Deferral

If the operator declines the rebuild:

- Providers may already be registered.
- The policy preset may already be applied.
- The registry messaging plan records the channel.
- The running sandbox image still has the old channel config until rebuild.

This is intentional.
The queued state is durable and `rebuild` later applies it to the image.

## Channel Remove Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
removeSandboxChannel()
```

### Remove Preconditions

The command validates:

- A channel argument is present.
- The channel exists in the legacy channel facade from `src/lib/sandbox/channels.ts`.

Removal still uses the compatibility channel facade because provider token keys and QR state helpers predate the manifest-only shape.

### QR State Cleanup First

For QR-paired channels that store auth state inside the sandbox, currently WhatsApp, removal starts by clearing durable in-sandbox state.

This happens before provider, registry, or policy mutation.
If cleanup fails and the channel has residue in registry, policy, session, or live applied presets, the command exits.

This ordering prevents rebuild backup and restore from preserving an auth blob after the operator asked to remove the channel.

Cleanup paths are agent-derived:

- OpenClaw: `/sandbox/.openclaw/<channel>/` when the agent declares that state dir.
- Hermes: `/sandbox/.hermes/platforms/<channel>/` when the agent declares `platforms`.

The cleanup tries OpenShell sandbox exec and falls back to SSH.

### Provider Teardown

For token-backed channels, `applyChannelRemoveToGatewayAndRegistry()`:

1. Ensures the gateway is reachable.
2. Detaches bridge providers from the sandbox.
3. Deletes bridge providers from the gateway.
4. Treats not-found and not-attached as success-equivalent.
5. Fails without updating registry when non-benign detach or delete errors occur.

Best-effort mode is used only in rollback paths.
Normal remove fails closed so local registry does not say the channel is gone while a gateway bridge is still live.

### Policy Narrowing

`removeChannelPresetIfPresent()` removes the channel-named built-in preset when it is applied.

Behavior:

- If the built-in preset does not exist, it only syncs the onboard session.
- If the preset is not applied, it only syncs the onboard session.
- If the preset is applied, it calls `policies.removePreset()`.
- Failure prints a warning and manual `policy-remove <channel>` guidance.

This is best-effort after bridge teardown.
The command does not roll the channel back to enabled just because policy narrowing failed.

### Plan Persistence And Rebuild

After provider and policy cleanup:

1. `persistManifestChannelRemovePlan()` removes the channel from the durable messaging plan.
2. Token-backed channels try best-effort durable state cleanup.
3. NemoClaw prompts for rebuild.

If rebuild is deferred, the live sandbox image can still contain old channel config until rebuilt.
The bridge provider is already gone and policy is usually narrowed, so the old config should not be able to authenticate or reach the upstream provider.

## Channel Stop Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
stopSandboxChannel()
```

`channels stop <channel>` disables delivery without deleting credentials or channel state.

The flow is:

1. Validate the channel argument.
2. Validate the sandbox exists.
3. Validate the channel is configured for the sandbox.
4. No-op if it is already disabled.
5. Persist a plan with the channel in `disabledChannels`.
6. Prompt for rebuild.

Important policy behavior:

```text
channels stop does not immediately remove the live policy preset.
```

The stop command changes desired state.
It relies on rebuild or later policy resume reconciliation to prune disabled-channel presets.

Consequences:

- If the operator defers rebuild, the old running sandbox may still have active channel config and live egress policy.
- If the operator rebuilds, disabled channels are filtered out of render, runtime setup, host forwards, package installs, and restored policy presets.
- If the operator wants immediate live egress narrowing without waiting for rebuild, they must also run `policy-remove <channel>`.

Credentials and QR state remain intact.
This is what lets `channels start` restore the channel without token re-entry or QR re-pairing.

## Channel Start Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
startSandboxChannel()
```

`channels start <channel>` re-enables a configured channel.

The flow is:

1. Validate the channel argument.
2. Validate the sandbox exists.
3. Validate the channel is configured for the sandbox.
4. No-op if it is already enabled.
5. Persist a plan with the channel removed from `disabledChannels`.
6. Apply the channel-named policy preset.
7. If policy apply fails, roll the plan back to disabled state and exit.
8. Prompt for rebuild.
9. If rebuild runs immediately, verify needed host forwards.

Policy application happens before rebuild.
This prevents a channel from being rebuilt active without the matching upstream egress policy.

If rebuild is deferred:

- Policy may already be widened.
- The running image may still have the old disabled configuration.
- The next rebuild applies the active channel config.

## Rebuild Flow

Entry point:

```text
src/lib/actions/sandbox/rebuild.ts
```

### Plan Staging

Before destructive work, rebuild calls:

```text
stageMessagingManifestPlanForRebuild()
```

This function:

1. Loads the target agent.
2. Checks whether the agent can participate in manifest-based messaging.
3. Lists channel IDs supported by the agent.
4. Hydrates the persisted registry plan.
5. Filters unsupported channels.
6. Refreshes derived fields such as runtime setup and host forward metadata.
7. Writes the `rebuild` plan to `NEMOCLAW_MESSAGING_PLAN_B64`.

If the agent is not supported by any channel manifest, rebuild clears the messaging env plan and skips.
If a stored plan is invalid or cannot be staged, rebuild fails before backup or deletion.

### Recreate

Rebuild deletes and recreates the sandbox through `onboard --resume`.
Before calling onboard, it pins the session to:

- The target sandbox name.
- The target agent.
- The staged messaging plan.
- The original inference provider, model, credential env, endpoint, and Hermes tool gateways.

The resumed onboarding flow injects the plan into the new image exactly like initial onboarding.

### Policy Restore

After recreate and state restore, rebuild restores policy presets.

Relevant helper:

```text
mergeRebuildMessagingPolicyPresets()
```

Inputs:

- Backup manifest policy presets when a backup exists.
- Registry policy presets as fallback for stale-sandbox recovery.
- Enabled channel IDs from the staged rebuild plan.
- Disabled channel IDs from the staged rebuild plan.

Behavior:

1. Start from backup policy presets or registry policy presets.
2. Prune presets that belong to disabled messaging channels.
3. Add presets that belong to enabled messaging channels.
4. Apply each preset.
5. Track restored and failed preset names.
6. Update the registry `policies` field with only successfully restored presets.

This means `policy-list` should not show a local applied marker for a preset that rebuild failed to restore.

### OpenClaw Doctor Reapply

OpenClaw rebuild runs `openclaw doctor --fix` after state restore.
Doctor can rewrite `openclaw.json`.

To keep messaging config intact, rebuild calls:

```text
reapplyMessagingManifestAfterOpenClawDoctor()
```

This reapplies manifest-owned render and post-agent-install hook outputs after doctor.
It is OpenClaw-specific.
Hermes does not have an equivalent post-doctor rewrite step.

### Host Forward Verification

After rebuild, `ensureMessagingHostForwardAfterRebuild()` verifies host forwards needed by active channels.
Teams depends on this because inbound Bot Framework traffic reaches the sandbox through the configured local webhook port.

Host forwards are not OpenShell egress policy.
They are separate host-side routing state.

## `policy-add` Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
addSandboxPolicy()
```

Modes:

- Built-in preset by name.
- Custom preset from `--from-file`.
- Custom presets from `--from-dir`.
- Interactive preset picker.

### Built-In Preset Add

For a built-in preset:

1. Validate the preset name against `policies.listPresets()` after agent filtering.
2. Refuse if the preset is already recorded as applied.
3. Load preset content with `policies.loadPreset()`.
4. Print endpoint preview.
5. Print preset validation warnings.
6. Confirm unless `--yes`, `--force`, or non-interactive mode skips confirmation.
7. Apply the preset through `policies.applyPreset()`.
8. Sync onboard session policy presets.
9. Refresh the sandbox policy context file.

`policies.applyPreset()`:

1. Calls `loadPresetForSandbox()`.
2. Resolves an agent-specific policy document when available.
3. Reads current gateway policy with `openshell policy get --full`.
4. Merges the preset's `network_policies` entries into that YAML.
5. Writes a temporary policy file.
6. Calls `openshell policy set --policy <tmp> --wait <sandbox>`.
7. Records the preset name in the registry.

### Messaging Preset Warning

For messaging presets, `getPresetValidationWarning()` uses manifest-derived metadata to warn:

```text
The preset only opens network egress.
It does not enable channel setup, pairing, or runtime configuration.
```

The warning can include channel-specific notes from `validationWarningLines`.

### Custom Preset Add

Custom presets:

1. Must be YAML files.
2. Must declare `preset.name`.
3. Must declare a `network_policies` mapping.
4. Must not collide with a built-in preset name.
5. Are persisted under `registry.customPolicies`.

Custom presets do not interact with channel manifests.
They can open equivalent endpoints, but they do not configure channel credentials, render agent config, or create messaging plan entries.

## `policy-remove` Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
removeSandboxPolicy()
```

The command:

1. Selects a built-in or custom preset that is recorded as applied.
2. Resolves preset content from built-in files or registry custom policies.
3. Prints endpoint removal preview.
4. Confirms unless confirmation is skipped.
5. Calls `policies.removePreset()`.
6. Syncs onboard session policy presets.
7. Refreshes the sandbox policy context file.

`policies.removePreset()`:

1. Resolves agent-specific preset content when applicable.
2. Reads the current gateway policy.
3. Removes all concrete `network_policies` keys declared by the preset.
4. Calls `openshell policy set --policy <tmp> --wait <sandbox>`.
5. Removes the built-in preset name from registry `policies` or the custom preset from `customPolicies`.

`policy-remove <channel>` does not edit `messaging.plan`.
If the channel is still active, it remains configured but cannot reach its upstream API until policy is restored.

## `policy-list` Flow

Entry point:

```text
src/lib/actions/sandbox/policy-channel.ts
listSandboxPolicies()
```

The command lists:

- Built-in non-messaging presets from `nemoclaw-blueprint/policies/presets/`.
- Built-in messaging presets from `src/lib/messaging/channels/<channel>/policy/<agent>.yaml`.
- Sandbox-scoped custom presets from the registry.

For each preset, it computes:

- `inRegistry`: whether the preset name is recorded in registry `policies` or `customPolicies`.
- `inGateway`: whether the current OpenShell gateway policy contains all concrete policy keys for that preset.

`inGateway` is computed by:

1. Running `openshell policy get --full <sandbox>`.
2. Parsing the returned policy YAML.
3. Listing current `network_policies` keys.
4. Matching those keys against built-in and custom preset definitions.
5. Using agent-specific preset content for agent sandboxes when available.

If the gateway cannot be reached or the policy cannot be parsed, `getGatewayPresets()` returns `null`.
The display then shows local state only and warns.

`policy-list` does not infer desired channel state from manifests.
It only compares known preset definitions against local registry and gateway policy.

## Status And Doctor Flows

Status and doctor paths read the same plan and runtime artifacts, but they should not mutate policy.

Relevant files:

```text
src/lib/actions/sandbox/channel-status.ts
src/lib/actions/sandbox/doctor-messaging.ts
src/lib/messaging/diagnostics.ts
src/lib/channel-runtime-status.ts
```

These flows can show:

- Configured channels.
- Active channels.
- Disabled channels.
- Runtime visibility.
- Slack Socket Mode overlaps.
- Missing bridge startup signals.
- Missing runtime artifacts.
- Gateway or host-forward issues.

They should not be used as a source of truth for applying network policy.
They are diagnostic consumers of registry, plan, runtime, and gateway state.

## OpenClaw And Hermes Differences

### OpenClaw

OpenClaw channel render targets include:

- `openclaw.json` channel blocks.
- `openclaw.json` plugin entries.
- OpenClaw plugin installs through `openclaw plugins install`.
- OpenClaw runtime preloads.
- OpenClaw runtime secret scans.
- Post-doctor render reapply after rebuild.

OpenClaw policy behavior:

- Baseline policy is `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`.
- Messaging endpoints are not baseline.
- Built-in messaging presets generally apply from `nemoclaw-blueprint/policies/presets`.
- Telegram uses concrete key `telegram_bot`.
- WeChat uses concrete key `wechat_bridge`.

### Hermes

Hermes channel render targets include:

- `~/.hermes/.env` env lines.
- `~/.hermes/config.yaml` platform sections.
- Hermes runtime env aliases when declared.
- Hermes package installs only when a trusted active manifest declares a pinned `hermes-uv-pip` package.

Hermes policy behavior:

- Baseline policy is `agents/hermes/policy-additions.yaml`.
- That file includes messaging templates for several channels.
- Inactive Hermes messaging entries are removed before sandbox create.
- `policy-add` and `policy-list` resolve agent-specific entries before built-in fallback.
- Telegram uses concrete key `telegram`.
- Slack, Discord, Teams, and WeChat use Hermes-specific entries when available.
- WhatsApp currently falls back to the built-in policy preset.

### Unsupported Agents

The manifest `supportedAgents` list is authoritative.
Agents that are not supported by any channel manifest should not receive messaging config, providers, policy mutations, or stale plan rebuilds.

The unsupported-agent boundary is enforced in:

- Channel listing.
- Channel add.
- Planner supported-channel checks.
- Rebuild plan staging.
- Onboard stale-plan cleanup.

## Failure Boundaries And Rollback Rules

### Fail Before Mutation

These failures happen before policy, provider, registry, or rebuild mutation:

- Unknown channel.
- Channel unsupported by sandbox agent.
- Missing or malformed channel-named preset YAML on `channels add`.
- Missing required inputs before active add.
- User aborts a conflict check.
- Non-interactive conflict without `--force`.
- Rebuild messaging plan cannot be staged.

### Fail Closed After Provider Mutation

`channels add` can register providers before policy apply.
If policy apply then fails, rollback attempts to remove or restore provider and credential state.

Fresh add rollback tries to clean:

- Channel tokens.
- Gateway provider attachments.
- Gateway providers.
- Registry state.

Existing channel token rotation rollback restores:

- Prior local credentials.
- Prior registry plan where possible.
- Prior gateway provider values on a best-effort basis.

Residual gateway provider state is explicitly warned.

### Fail Closed Before QR State Loss

`channels remove` for in-sandbox QR channels clears durable in-sandbox auth state before registry and policy mutation.
If that cleanup cannot be confirmed, the command exits and leaves registry and policy untouched.

### Best-Effort Narrowing After Bridge Removal

Policy removal during `channels remove` is best-effort once bridge teardown has succeeded.
If policy narrowing fails, the bridge is gone but egress might remain.
The command prints manual `policy-remove <channel>` guidance.

### Start Rollback

`channels start` applies policy after enabling the plan.
If policy apply fails, it attempts to put the plan back into disabled state.

This prevents rebuild from later making the channel active without egress.

## Common Drift States

### Active Channel But Missing Policy

How it happens:

- Operator runs `policy-remove <channel>`.
- Policy restore fails during rebuild.
- Custom policy replacement removes the concrete keys.

Effect:

- Agent config and providers can exist.
- Channel traffic is denied by OpenShell.
- `policy-list` should show the preset missing from gateway.

Recovery:

```bash
nemoclaw <sandbox> policy-add <channel> --yes
```

### Policy Applied But Channel Not Configured

How it happens:

- Operator runs `policy-add <channel>`.
- Open tier applies messaging presets.
- Custom policy contains equivalent endpoints.

Effect:

- Sandbox can reach provider API endpoints.
- No bridge is configured unless onboarding or `channels add` created one.

Recovery:

```bash
nemoclaw <sandbox> channels add <channel>
nemoclaw <sandbox> rebuild
```

### Disabled Channel With Live Policy Still Applied

How it happens:

- Operator runs `channels stop <channel>` and defers rebuild.

Effect:

- Desired plan says disabled.
- Live sandbox and live policy may still reflect the old active state.

Recovery:

```bash
nemoclaw <sandbox> rebuild
```

Optional immediate narrowing:

```bash
nemoclaw <sandbox> policy-remove <channel> --yes
```

### Registry Says Applied But Gateway Unknown

How it happens:

- Gateway unreachable during `policy-list`.
- OpenShell policy query fails.

Effect:

- `policy-list` shows local state only.
- It cannot prove enforcement.

Recovery:

```bash
openshell gateway start --name <gateway>
nemoclaw <sandbox> policy-list
```

## Contributor Checklist For Channel Policy Changes

When adding or changing a channel policy:

1. Update the channel manifest first.
2. Keep `supportedAgents` precise.
3. Add or update `policyPresets`.
4. Add or update `src/lib/messaging/channels/<channel>/policy/openclaw.yaml`.
5. Add or update `src/lib/messaging/channels/<channel>/policy/hermes.yaml` when Hermes supports the channel.
6. Keep manifest `policyKeys` and `agentPolicyKeys` aligned with the actual YAML keys.
7. Decide whether `requiredAtCreate` is truly needed.
8. Add `validationWarningLines` when direct `policy-add` validation has a known trap.
9. Add or update template resolvers only for derived render values.
10. Add hooks only for side effects or checks that static manifest data cannot express.
11. Update build-time trusted manifest registration if the build applier still uses a static trusted list.
12. Test manifest metadata and plan compilation.
13. Test channel add for preset validation and rollback.
14. Test channel remove for provider, policy, and QR state cleanup when applicable.
15. Test stop/start policy behavior.
16. Test rebuild policy restoration, including disabled-channel pruning.
17. Test Hermes agent-specific policy resolution if the channel supports Hermes.
18. Test `policy-list` gateway matching when concrete keys differ from the preset name.

## Known Design Gaps

### Channel Command Preset Name Assumption

`channels add`, `channels start`, and `channels remove` currently apply or remove the channel-named preset directly.
They do not consume the compiled plan's `networkPolicy.entries`.

Current built-ins are safe because channel ID and preset name match.
A future channel with a different preset name would need a shared helper that reads manifest policy metadata instead of assuming `channelId === presetName`.

### Scattered Registration

The manifest contract is strong, but registration remains split across:

- Built-in manifests.
- Hook registry.
- Template resolver registry.
- Metadata facades.
- Build-time trusted manifest list.
- Legacy `src/lib/sandbox/channels.ts`.

A future catalog layer should centralize these surfaces.

### Policy Is Not Solely Manifest-Driven

Open policy tier and manual `policy-add` can apply messaging presets independent of active channels.
This is intentional, but it means "preset applied" is not equivalent to "channel configured".

### Stop Does Not Immediately Narrow Live Egress

`channels stop` persists desired disabled state and relies on rebuild or policy reconciliation to narrow policy.
This preserves credentials and state for later start, but it is not an immediate firewall operation.

If immediate egress closure is required, pair `channels stop` with `policy-remove`.

## Minimal Mental Model

Use this model when debugging:

```text
Manifest
  declares channel needs, including policy preset names and concrete keys

Planner
  compiles manifests plus current state into SandboxMessagingPlan

Registry
  stores desired channel state and recorded policy preset names

Docker build applier
  turns active plan entries into agent config, packages, runtime setup, and runtime artifacts

OpenShell providers
  carry secrets into the sandbox as placeholders

OpenShell policy
  decides whether the sandbox can reach upstream messaging hosts

Channel commands
  mutate desired channel state, providers, and sometimes live policy

Policy commands
  mutate live policy and registry policy names, but not channel config

Rebuild
  reconciles desired channel state into a fresh image and restores policy to match enabled channels
```

When behavior is confusing, inspect these in order:

1. Manifest support and `policyPresets`.
2. Registry `messaging.plan`.
3. Registry `policies` and `customPolicies`.
4. Gateway policy from `openshell policy get --full`.
5. Agent config in `/sandbox/.openclaw` or `/sandbox/.hermes`.
6. Reduced runtime plan artifact.
7. OpenShell providers.
8. Host forwards for Teams.
