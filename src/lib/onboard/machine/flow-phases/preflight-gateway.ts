// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardFlowContext, OnboardFlowPhaseResult } from "../flow-context";
import { mergeOnboardFlowContext, onboardFlowPhaseResult } from "../flow-context";
import type { OnboardSequencePhase } from "../sequence-runner";

type PreflightPhaseHandler<Context extends OnboardFlowContext> = (context: Context) => Promise<{
  session: Context["session"];
  gpu: Context["gpu"];
  sandboxGpuConfig: NonNullable<Context["sandboxGpuConfig"]>;
  gpuPassthrough: boolean;
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

type GatewayPhaseHandler<Context extends OnboardFlowContext> = (context: Context) => Promise<{
  session: Context["session"];
  result: OnboardFlowPhaseResult<Context>["result"];
}>;

export function createPreflightPhase<Context extends OnboardFlowContext>(
  runPreflight: PreflightPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return {
    state: "preflight",
    async run(context) {
      const result = await runPreflight(context);
      return onboardFlowPhaseResult(
        mergeOnboardFlowContext(context, {
          session: result.session,
          gpu: result.gpu,
          sandboxGpuConfig: result.sandboxGpuConfig,
          gpuPassthrough: result.gpuPassthrough,
        } as Partial<Context>),
        result.result,
      );
    },
  };
}

export function createGatewayPhase<Context extends OnboardFlowContext>(
  runGateway: GatewayPhaseHandler<Context>,
): OnboardSequencePhase<Context> {
  return {
    state: "gateway",
    async run(context) {
      const result = await runGateway(context);
      return onboardFlowPhaseResult(
        mergeOnboardFlowContext(context, { session: result.session } as Partial<Context>),
        result.result,
      );
    },
  };
}
