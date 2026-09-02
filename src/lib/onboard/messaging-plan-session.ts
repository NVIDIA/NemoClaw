// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
import {
  getActiveChannelIdsFromPlan,
  getConfiguredChannelIdsFromPlan,
} from "../messaging/plan-validation";
import {
  bridgeProviderNamesForChannel,
  messagingBridgeProfilesForAgent,
  staticMessagingProviderTypeForChannel,
} from "./messaging-bridge-provider";

export {
  getActiveChannelIdsFromPlan as getActiveChannelsFromPlan,
  getDisabledChannelIdsFromPlan as getDisabledChannelsFromPlan,
  getMessagingChannelConfigFromPlan,
  parseSandboxMessagingPlan,
} from "../messaging/plan-validation";

export type MessagingGatewayCredentialMatcher = (
  name: string,
  type: string,
  credentialEnv: string,
) => boolean;

/** Keep active channels only while every gateway credential provider still matches. */
export function messagingChannelsWithReusableGatewayCredentials(
  plan: SandboxMessagingPlan | null | undefined,
  providerMatchesGatewayCredential: MessagingGatewayCredentialMatcher,
): string[] {
  if (!plan) return [];
  const bridgeProfiles = messagingBridgeProfilesForAgent(plan.agent);
  return getActiveChannelIdsFromPlan(plan).filter((channelId) => {
    const bindings = plan.credentialBindings.filter((binding) => binding.channelId === channelId);
    if (bindings.length > 0) {
      return bindings.every((binding) =>
        providerMatchesGatewayCredential(
          binding.providerName,
          staticMessagingProviderTypeForChannel(binding.channelId, plan.agent) ??
            MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          binding.providerEnvKey,
        ),
      );
    }

    const gatewayBridgeProviders = bridgeProfiles
      .filter((profile) => profile.channelId === channelId && profile.strategy !== null)
      .flatMap((profile) =>
        bridgeProviderNamesForChannel(plan.sandboxName, channelId, [profile]).map((name) => ({
          name,
          type: profile.profileId,
          credentialEnv: profile.credentialKey,
        })),
      );
    return (
      gatewayBridgeProviders.length > 0 &&
      gatewayBridgeProviders.every(({ name, type, credentialEnv }) =>
        providerMatchesGatewayCredential(name, type, credentialEnv),
      )
    );
  });
}

/** Derive configured channel IDs from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getConfiguredChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}
