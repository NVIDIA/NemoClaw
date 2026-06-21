// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OnboardFlowContext,
  OnboardFlowPhaseResult,
  ProviderModelSelectedContextUpdate,
  ProviderModelSelectedOnboardFlowContext,
  SandboxCreatedContextUpdate,
} from "../flow-context";
import {
  assertProviderSelectedContext,
  mergeProviderModelSelectedContext,
  mergeSandboxCreatedContext,
  onboardFlowPhaseResult,
} from "../flow-context";
import type { OnboardSequencePhase } from "../sequence-runner";

type ProviderInferencePhaseHandler<Context extends OnboardFlowContext> = (
  context: Context,
) => Promise<{
  context: ProviderModelSelectedContextUpdate;
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

type SandboxPhaseHandler<Context extends OnboardFlowContext> = (
  context: ProviderModelSelectedOnboardFlowContext<Context>,
) => Promise<{
  context: SandboxCreatedContextUpdate;
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
        mergeProviderModelSelectedContext(context, result.context),
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
      assertProviderSelectedContext(context, "sandbox setup");
      const result = await runSandbox(context);
      return onboardFlowPhaseResult(
        mergeSandboxCreatedContext(context, result.context),
        result.result,
      );
    },
  };
}
