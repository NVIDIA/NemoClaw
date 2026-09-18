// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { VerifyDeploymentResult } from "../../verify-deployment";
import {
  createFinalOnboardFlowPhases as createFinalFlowPhases,
  type FinalOnboardFlowPhaseOptions,
} from "./final-flow-phases";
import { finalizationHandlerDeps } from "./finalization-deps";
import type { OnboardFlowContext } from "./flow-context";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";

export { runFinalOnboardFlowSlice } from "./final-flow-phases";
export { finalizationHandlerDeps, restartNativeGatewayForInitialSetup } from "./finalization-deps";

type FinalizationHandlerDeps = typeof finalizationHandlerDeps;

export type FinalOnboardFlowCompositionOptions<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult extends VerifyDeploymentResult = VerifyDeploymentResult,
> = Omit<
  FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>,
  "finalizationDeps"
> & {
  readonly portableRuntimeContext?: PortableOnboardRuntimeContext | null;
  finalizationDeps: Omit<
    FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>["finalizationDeps"],
    keyof FinalizationHandlerDeps
  >;
};

export function createFinalOnboardFlowPhases<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult extends VerifyDeploymentResult = VerifyDeploymentResult,
>(
  options: FinalOnboardFlowCompositionOptions<Context, VerifyChain, VerificationResult>,
): ReturnType<typeof createFinalFlowPhases<Context, VerifyChain, VerificationResult>> {
  const portableRuntime = options.portableRuntimeContext;
  return createFinalFlowPhases<Context, VerifyChain, VerificationResult>({
    ...options,
    finalizationDeps: {
      ...options.finalizationDeps,
      ...finalizationHandlerDeps,
      ...(portableRuntime
        ? {
            checkAndRecoverSandboxProcesses: (name: string, options: { quiet: boolean }) => {
              if (!portableRuntime.environmentScope) {
                throw new Error(
                  "Hermes portable finalization requires onboarding environment authority",
                );
              }
              return finalizationHandlerDeps.checkAndRecoverSandboxProcesses(
                name,
                options,
                portableRuntime.environmentScope.createHermesPortablePodmanSourceEnvironment(
                  portableRuntime.authority,
                ),
              );
            },
          }
        : {}),
    },
  });
}
