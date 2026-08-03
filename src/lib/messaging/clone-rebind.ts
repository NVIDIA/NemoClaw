// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cloneAndDeepFreeze } from "../core/immutable";
import { isValidName } from "../name-validation";
import { createBuiltInChannelManifestRegistry } from "./channels/built-ins";
import { resolveSandboxNameTemplate } from "./compiler/engines/template";
import { hydrateDerivedSandboxMessagingPlanFields } from "./hydration";
import type { MessagingAgentId, SandboxMessagingPlan } from "./manifest";
import { compactSandboxMessagingPlanForPersistence } from "./persistence";
import { parseSandboxMessagingPlan } from "./plan-validation";

export interface SandboxMessagingCloneRebindInput {
  readonly sourceSandboxName: string;
  readonly destinationSandboxName: string;
  readonly agent: MessagingAgentId;
  readonly sourcePlan: unknown;
  /**
   * Explicit non-secret inputs used by manifest renderers. Clone rebinding
   * never consults process.env, so an unrelated host credential cannot change
   * the destination plan or enter its fingerprints.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class SandboxMessagingCloneRebindError extends Error {
  constructor(message: string) {
    super(`Cannot rebind managed messaging plan: ${message}`);
    this.name = "SandboxMessagingCloneRebindError";
  }
}

function fail(message: string): never {
  throw new SandboxMessagingCloneRebindError(message);
}

function requireSandboxName(value: string, label: string): string {
  if (!isValidName(value)) fail(`${label} sandbox name is invalid`);
  return value;
}

/**
 * Recompile one secret-free managed messaging plan for a destination sandbox.
 *
 * Compact persistence data is the retained intent boundary. All target-bound
 * provider names and executable derived fields are rebuilt from current
 * built-in manifests with an explicit, credential-free environment.
 */
export function rebindSandboxMessagingPlanForClone(
  input: SandboxMessagingCloneRebindInput,
): SandboxMessagingPlan {
  const sourceSandboxName = requireSandboxName(input.sourceSandboxName, "source");
  const destinationSandboxName = requireSandboxName(input.destinationSandboxName, "destination");
  if (sourceSandboxName === destinationSandboxName) {
    fail("source and destination sandbox names must differ");
  }

  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const supportedChannelIds = manifestRegistry
    .listAvailable({ agent: input.agent })
    .map((manifest) => manifest.id);
  const environment = Object.freeze({ ...(input.environment ?? {}) });
  const sourcePlan = parseSandboxMessagingPlan(input.sourcePlan, {
    sandboxName: sourceSandboxName,
    agent: input.agent,
    supportedChannelIds,
    environment,
  });
  if (!sourcePlan) fail("source plan is invalid or uses a non-built-in channel");
  const sourceChannelIds = new Set(sourcePlan.channels.map((channel) => channel.channelId));
  if (sourcePlan.disabledChannels.some((channelId) => !sourceChannelIds.has(channelId))) {
    fail("source plan disables a channel that is not configured");
  }
  for (const channel of sourcePlan.channels) {
    const manifest = manifestRegistry.get(channel.channelId);
    if (!manifest || !manifest.supportedAgents.includes(input.agent)) {
      fail(`source channel ${channel.channelId} is not a supported built-in`);
    }
    const listedDisabled = sourcePlan.disabledChannels.includes(channel.channelId);
    if (channel.disabled !== listedDisabled || (channel.active && !channel.configured)) {
      fail(`source channel ${channel.channelId} has inconsistent lifecycle state`);
    }
    const seenInputIds = new Set<string>();
    for (const planInput of channel.inputs) {
      if (seenInputIds.has(planInput.inputId)) {
        fail(`source channel ${channel.channelId} repeats input ${planInput.inputId}`);
      }
      seenInputIds.add(planInput.inputId);
      const manifestInput = manifest.inputs.find((candidate) => candidate.id === planInput.inputId);
      if (!manifestInput || manifestInput.kind !== planInput.kind) {
        fail(
          `source channel ${channel.channelId} input ${planInput.inputId} is not manifest-owned`,
        );
      }
      if (planInput.kind === "secret" && planInput.value !== undefined) {
        fail("source plan contains a raw secret input value");
      }
    }
    if (channel.active && !channel.disabled) {
      for (const requiredInput of manifest.inputs.filter((candidate) => candidate.required)) {
        const retained = channel.inputs.find((candidate) => candidate.inputId === requiredInput.id);
        const available =
          requiredInput.kind === "secret"
            ? retained?.credentialAvailable === true
            : retained?.value !== undefined;
        if (!available) {
          fail(
            `active source channel ${channel.channelId} is missing required input ${requiredInput.id}`,
          );
        }
      }
    }
  }

  const compact = compactSandboxMessagingPlanForPersistence(sourcePlan);
  const credentialBindings = (compact.credentialBindings ?? []).map(
    ({ credentialHash: _sourceCredentialHash, ...binding }) => binding,
  );
  const targetIntent = {
    ...compact,
    // A source hash describes the source gateway credential, not the explicit
    // credential that clone provisioning will write into the destination.
    credentialBindings,
    sandboxName: destinationSandboxName,
    // These fields are executable output, not retained clone intent.
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
    stateUpdates: [],
    healthChecks: [],
  } as const;
  const normalized = parseSandboxMessagingPlan(targetIntent, {
    sandboxName: destinationSandboxName,
    agent: input.agent,
    supportedChannelIds,
    environment,
  });
  if (!normalized) fail("destination intent could not be normalized");
  const hydrated = hydrateDerivedSandboxMessagingPlanFields(normalized, { environment });
  const rebound = parseSandboxMessagingPlan(hydrated, {
    sandboxName: destinationSandboxName,
    agent: input.agent,
    supportedChannelIds,
    environment,
  });
  if (!rebound) fail("destination plan could not be validated after manifest hydration");
  const secretProvenanceNeutralRebound = {
    ...rebound,
    credentialBindings: rebound.credentialBindings.map(
      ({ credentialHash: _ambientCredentialHash, ...binding }) => binding,
    ),
  };
  for (const binding of secretProvenanceNeutralRebound.credentialBindings) {
    const credential = manifestRegistry
      .get(binding.channelId)
      ?.credentials.find((candidate) => candidate.id === binding.credentialId);
    const expectedProviderName =
      credential === undefined
        ? undefined
        : resolveSandboxNameTemplate(credential.providerName, destinationSandboxName);
    if (!expectedProviderName || binding.providerName !== expectedProviderName) {
      fail(`destination provider identity for ${binding.channelId} could not be proven`);
    }
  }
  return cloneAndDeepFreeze(secretProvenanceNeutralRebound);
}
