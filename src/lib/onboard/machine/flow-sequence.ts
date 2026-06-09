// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardFlowContext, OnboardFlowPhaseResult } from "./flow-context";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
  createPostVerifyPhase,
} from "./flow-phases/agent-policy-finalization";
import { createGatewayPhase, createPreflightPhase } from "./flow-phases/preflight-gateway";
import { createProviderInferencePhase, createSandboxPhase } from "./flow-phases/provider-sandbox";
import type { OnboardSequencePhase } from "./sequence-runner";

export interface OnboardFlowPhaseHandlers<Context extends OnboardFlowContext> {
  preflight(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  gateway(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  providerInference(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  sandbox(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  openclaw(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  agentSetup(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  policies(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  finalization(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
  postVerify(context: Context): Promise<OnboardFlowPhaseResult<Context>>;
}

export function buildOnboardFlowPhaseSequence<Context extends OnboardFlowContext>(
  handlers: OnboardFlowPhaseHandlers<Context>,
): OnboardSequencePhase<Context>[] {
  return [
    createPreflightPhase(async (context) => {
      const result = await handlers.preflight(context);
      return {
        session: result.context.session,
        gpu: result.context.gpu,
        sandboxGpuConfig: result.context.sandboxGpuConfig as NonNullable<
          Context["sandboxGpuConfig"]
        >,
        gpuPassthrough: result.context.gpuPassthrough,
        result: result.result,
      };
    }),
    createGatewayPhase(async (context) => {
      const result = await handlers.gateway(context);
      return { session: result.context.session, result: result.result };
    }),
    createProviderInferencePhase((context) => handlers.providerInference(context)),
    createSandboxPhase((context) => handlers.sandbox(context)),
    createOpenclawSetupPhase((context) => handlers.openclaw(context)),
    createAgentSetupPhase((context) => handlers.agentSetup(context)),
    createPoliciesPhase((context) => handlers.policies(context)),
    createFinalizationPhase((context) => handlers.finalization(context)),
    createPostVerifyPhase((context) => handlers.postVerify(context)),
  ];
}
