// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardFlowContext, OnboardFlowPhaseResult } from "../flow-context";
import { mergeOnboardFlowContext, onboardFlowPhaseResult } from "../flow-context";
import type { OnboardSequencePhase } from "../sequence-runner";

type FlowPhaseHandler<Context extends OnboardFlowContext> = (context: Context) => Promise<{
  context?: Partial<Context>;
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

function createFlowPhase<Context extends OnboardFlowContext>(
  state: OnboardSequencePhase<Context>["state"],
  runPhase: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return {
    state,
    async run(context) {
      const result = await runPhase(context);
      return onboardFlowPhaseResult(
        result.context ? mergeOnboardFlowContext(context, result.context) : context,
        result.result,
      );
    },
  };
}

export function createAgentSetupPhase<Context extends OnboardFlowContext>(
  runAgentSetup: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return createFlowPhase("agent_setup", runAgentSetup);
}

export function createOpenclawSetupPhase<Context extends OnboardFlowContext>(
  runOpenclawSetup: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return createFlowPhase("openclaw", runOpenclawSetup);
}

export function createPoliciesPhase<Context extends OnboardFlowContext>(
  runPolicies: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return createFlowPhase("policies", runPolicies);
}

export function createFinalizationPhase<Context extends OnboardFlowContext>(
  runFinalization: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return createFlowPhase("finalizing", runFinalization);
}

export function createPostVerifyPhase<Context extends OnboardFlowContext>(
  runPostVerify: FlowPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return createFlowPhase("post_verify", runPostVerify);
}
