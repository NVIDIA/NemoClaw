// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import type { PendingSandboxPolicyVerification } from "../../state/registry";
import type { OpenshellCliHelpers } from "../openshell-cli";
import { asDeferredProviderRefreshError } from "../sandbox-create/provider-publication";

type ProviderSyncInput = {
  sandboxName: string;
  enabledChannels: string[];
  agent: unknown;
  webSearchConfig: unknown;
  lifecycleGeneration?: string;
  sandboxIdentityFingerprint?: string;
  pendingPolicyVerification?: PendingSandboxPolicyVerification;
  reservationSessionId?: string;
  revalidatePolicyRequirements?(operation: string): void;
};

const providers = require("../providers") as {
  synchronizeMessagingProvidersAfterPolicy(
    input: ProviderSyncInput,
    deps: Record<string, unknown>,
  ): Promise<PendingSandboxPolicyVerification | undefined>;
};

type ProviderSyncRuntime = Pick<
  SandboxCreateOrchestrationRuntime,
  | "GATEWAY_NAME"
  | "getSandboxRecreateObservation"
  | "registry"
  | "runOpenshell"
  | "sandboxCreateIntentResolver"
  | "sandboxRecreateTransaction"
  | "sleepSeconds"
  | "upsertMessagingProviders"
  | "waitForSandboxReady"
>;

/** Bind post-policy provider synchronization to one gateway and lifecycle authority. */
export function bind(
  runtime: ProviderSyncRuntime,
  runGatewayOpenshell: OpenshellCliHelpers["runOpenshell"],
) {
  return async (input: ProviderSyncInput) => {
    const revalidateSandboxIdentity = (operation: string, retryNotReady: boolean): boolean => {
      if (!input.lifecycleGeneration || !input.sandboxIdentityFingerprint) {
        throw new Error(`Cannot ${operation}: sandbox lifecycle identity is not recorded.`);
      }
      const observation = runtime.getSandboxRecreateObservation(
        input.sandboxName,
        runtime.GATEWAY_NAME,
      );
      if (retryNotReady && observation.state === "not_ready") return false;
      runtime.sandboxRecreateTransaction.revalidateCreatedSandboxLifecycleRegistration(
        { sandboxName: input.sandboxName, gatewayName: runtime.GATEWAY_NAME },
        {
          lifecycleGeneration: input.lifecycleGeneration,
          lifecycleLiveIdentityFingerprint: input.sandboxIdentityFingerprint,
        },
        () => observation,
      );
      return true;
    };
    try {
      const checkpoint = await providers.synchronizeMessagingProvidersAfterPolicy(input, {
        rebindMessagingCapabilities: runtime.sandboxCreateIntentResolver.rebind,
        upsertMessagingProviders: runtime.upsertMessagingProviders,
        runGatewayOpenshell,
        runOpenshell: runtime.runOpenshell,
        sleepSeconds: runtime.sleepSeconds,
        waitForSandboxReady: runtime.waitForSandboxReady,
        gatewayName: runtime.GATEWAY_NAME,
        advancePendingSandboxProviderRefresh: runtime.registry.advancePendingSandboxProviderRefresh,
        revalidateSandboxIdentity: (operation: string) => {
          revalidateSandboxIdentity(operation, false);
        },
        tryRevalidateReadySandboxIdentity: (operation: string) =>
          revalidateSandboxIdentity(operation, true),
      });
      if (checkpoint?.providerRefresh?.phase === "ready") {
        runtime.registry.publishPendingSandboxProviderRefresh(
          input.sandboxName,
          input.reservationSessionId ?? "",
          checkpoint,
        );
      }
    } catch (error) {
      if (input.pendingPolicyVerification?.providerRefresh) {
        throw asDeferredProviderRefreshError(input.sandboxName, error);
      }
      throw error;
    }
  };
}
