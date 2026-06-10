// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardFlowContext, OnboardFlowPhaseResult } from "../flow-context";
import { mergeOnboardFlowContext, onboardFlowPhaseResult } from "../flow-context";
import type { OnboardSequencePhase } from "../sequence-runner";

type ProviderInferencePhaseHandler<Context extends OnboardFlowContext> = (
  context: Context,
) => Promise<{
  context: Partial<Context>;
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

type SandboxPhaseHandler<Context extends OnboardFlowContext> = (context: Context) => Promise<{
  context: Partial<Context>;
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

export function createProviderInferencePhase<Context extends OnboardFlowContext>(
  runProviderInference: ProviderInferencePhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return {
    state: "provider_selection",
    async run(context) {
      const result = await runProviderInference(context);
      return onboardFlowPhaseResult(
        mergeOnboardFlowContext(context, result.context),
        result.result,
      );
    },
  };
}

export function createSandboxPhase<Context extends OnboardFlowContext>(
  runSandbox: SandboxPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return {
    state: "sandbox",
    async run(context) {
      const result = await runSandbox(context);
      return onboardFlowPhaseResult(
        mergeOnboardFlowContext(context, result.context),
        result.result,
      );
    },
  };
}
