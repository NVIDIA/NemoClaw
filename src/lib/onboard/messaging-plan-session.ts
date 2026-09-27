// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { GatewayCredentialOnlyProviderInspection } from "./gateway-provider-metadata";
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

export type MessagingGatewayCredentialInspector = (
  name: string,
  type: string,
  credentialEnv: string,
) => GatewayCredentialOnlyProviderInspection | Promise<GatewayCredentialOnlyProviderInspection>;

/** Keep active channels only while every gateway credential provider still matches. */
export async function messagingChannelsWithReusableGatewayCredentials(
  plan: SandboxMessagingPlan | null | undefined,
  inspectGatewayCredential: MessagingGatewayCredentialInspector,
): Promise<string[]> {
  if (!plan) return [];
  const bridgeProfiles = messagingBridgeProfilesForAgent(plan.agent);
  const reusableChannels = await Promise.all(
    getActiveChannelIdsFromPlan(plan).map(async (channelId) => {
      const bindings = plan.credentialBindings.filter((binding) => binding.channelId === channelId);
      const providers =
        bindings.length > 0
          ? bindings.map((binding) => ({
              name: binding.providerName,
              type:
                staticMessagingProviderTypeForChannel(binding.channelId, plan.agent) ??
                MESSAGING_CREDENTIAL_PROVIDER_TYPE,
              credentialEnv: binding.providerEnvKey,
            }))
          : bridgeProfiles
              .filter((profile) => profile.channelId === channelId && profile.strategy !== null)
              .flatMap((profile) =>
                bridgeProviderNamesForChannel(plan.sandboxName, channelId, [profile]).map(
                  (name) => ({
                    name,
                    type: profile.profileId,
                    credentialEnv: profile.credentialKey,
                  }),
                ),
              );
      const inspections = await Promise.all(
        providers.map(({ name, type, credentialEnv }) =>
          inspectGatewayCredential(name, type, credentialEnv),
        ),
      );
      if (inspections.some(({ kind }) => kind === "indeterminate")) {
        throw new Error(
          `Could not inspect gateway credentials for messaging channel '${channelId}'. Verify the gateway is reachable, then retry onboarding.`,
        );
      }
      return inspections.length > 0 && inspections.every(({ kind }) => kind === "exact")
        ? channelId
        : null;
    }),
  );
  return reusableChannels.filter((channelId) => channelId !== null);
}

/** Derive configured channel IDs from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const channels = getConfiguredChannelIdsFromPlan(plan);
  return channels.length > 0 ? channels : null;
}
