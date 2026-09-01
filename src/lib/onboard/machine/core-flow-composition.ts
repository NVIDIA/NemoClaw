// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stopStaleDashboardListenersForSandbox } from "../stale-gateway-cleanup";
import {
  type CoreOnboardFlowPhases,
  createProviderInferenceOnboardFlowPhase,
  createSandboxOnboardFlowPhase,
  type ProviderInferenceOnboardFlowPhaseOptions,
  type SandboxOnboardFlowPhaseOptions,
} from "./core-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import { createResumeProviderShim, type ResumeProviderShimDeps } from "./resume-provider-shim";

export {
  isCoreFlowCompleteBeforeFinalization,
  prepareCoreOnboardFlowContext,
  prepareFinalOnboardFlowContext,
  runCoreOnboardFlowSlice,
} from "./core-flow-phases";

type ResumeProviderShim = ReturnType<typeof createResumeProviderShim>;

type ProviderInferenceCompositionOptions<Context extends OnboardFlowContext, Host> = Omit<
  ProviderInferenceOnboardFlowPhaseOptions<Context, Host>,
  "deps"
> & {
  deps: Omit<
    ProviderInferenceOnboardFlowPhaseOptions<Context, Host>["deps"],
    keyof ResumeProviderShim
  >;
};

type SandboxCompositionOptions<
  Context extends OnboardFlowContext,
  MessagingChannelConfig,
  ResourceProfile,
> = Omit<
  SandboxOnboardFlowPhaseOptions<Context, MessagingChannelConfig, ResourceProfile>,
  "deps"
> & {
  deps: Omit<
    SandboxOnboardFlowPhaseOptions<Context, MessagingChannelConfig, ResourceProfile>["deps"],
    "stopStaleDashboardListenersForSandbox"
  >;
};

export interface CoreOnboardFlowCompositionInput<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
> {
  resumeProvider: ResumeProviderShimDeps;
  providerInference: ProviderInferenceCompositionOptions<Context, Host>;
  sandbox: SandboxCompositionOptions<Context, MessagingChannelConfig, ResourceProfile>;
}

export function createCoreOnboardFlowPhases<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
>(
  input: CoreOnboardFlowCompositionInput<Context, Host, MessagingChannelConfig, ResourceProfile>,
): CoreOnboardFlowPhases<Context> {
  const resumeProvider = createResumeProviderShim(input.resumeProvider);
  return {
    providerInference: createProviderInferenceOnboardFlowPhase<Context, Host>({
      ...input.providerInference,
      deps: { ...input.providerInference.deps, ...resumeProvider },
    }),
    sandbox: createSandboxOnboardFlowPhase<Context, MessagingChannelConfig, ResourceProfile>({
      ...input.sandbox,
      deps: {
        ...input.sandbox.deps,
        stopStaleDashboardListenersForSandbox: (sandboxes, sandboxName) => {
          stopStaleDashboardListenersForSandbox(
            sandboxes as Parameters<typeof stopStaleDashboardListenersForSandbox>[0],
            sandboxName,
          );
        },
      },
    }),
  };
}
