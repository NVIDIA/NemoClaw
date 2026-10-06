// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { VerifyDeploymentResult } from "../../verify-deployment";
import {
  isCoreFlowCompleteBeforeFinalization,
  type runCoreOnboardFlowSlice,
} from "./core-flow-phases";
import {
  createFinalOnboardFlowPhases as createFinalFlowPhases,
  type FinalOnboardFlowPhaseOptions,
  runFinalOnboardFlowSlice,
} from "./final-flow-phases";
import { finalizationHandlerDeps } from "./finalization-deps";
import type { OnboardFlowContext } from "./flow-context";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import {
  type CompletedOnboardTelemetry,
  sendCompletedOnboardConfigurationTelemetry,
} from "./telemetry-completion";

export { runFinalOnboardFlowSlice } from "./final-flow-phases";
export { finalizationHandlerDeps, restartNativeGatewayForInitialSetup } from "./finalization-deps";

type FinalizationHandlerDeps = typeof finalizationHandlerDeps;

/** Supersession must finish before a completed flow can report configuration. */
export async function completeSuccessfulOnboardFlow(
  completion: CompletedOnboardTelemetry,
  supersede: () => Promise<void>,
  send?: Parameters<typeof sendCompletedOnboardConfigurationTelemetry>[1],
): Promise<void> {
  const capturedCompletion: CompletedOnboardTelemetry = {
    ...completion,
    expectedSelection: {
      model: completion.expectedSelection.model,
      provider: completion.expectedSelection.provider,
      preferredInferenceApi: completion.expectedSelection.preferredInferenceApi,
    },
  };
  await supersede();
  await sendCompletedOnboardConfigurationTelemetry(capturedCompletion, send);
}

type CompletedFlowContext = Pick<
  OnboardFlowContext<{ name: string } | null>,
  | "agent"
  | "sandboxName"
  | "model"
  | "provider"
  | "preferredInferenceApi"
  | "revalidateSandboxIdentity"
  | "appliedPolicySelection"
>;

/** Keep completed-target capture and retirement ordering in the flow owner. */
export function createSuccessfulOnboardFlowCompletion(
  options: Pick<
    CompletedOnboardTelemetry,
    "getSandbox" | "withTargetLock" | "loadRegistrySnapshot" | "withSnapshotLock"
  > & {
    supersede: () => Promise<void>;
    disarmRollback: () => void;
    onCompleted: (completed: boolean) => void;
    send?: Parameters<typeof sendCompletedOnboardConfigurationTelemetry>[1];
  },
) {
  const { getSandbox, withTargetLock, supersede, disarmRollback, onCompleted, send } = options;
  const complete = (
    context: CompletedFlowContext,
    target: Pick<CompletedOnboardTelemetry, "sandboxName" | "finalizedAgent" | "sessionAgent">,
    cleanup: () => Promise<void>,
  ): Promise<void> =>
    completeSuccessfulOnboardFlow(
      {
        completed: true,
        ...target,
        contextSandboxName: context.sandboxName,
        appliedPolicySelection: context.appliedPolicySelection,
        expectedSelection: context,
        assertRegistration: context.revalidateSandboxIdentity?.assertRegistration,
        getSandbox,
        withTargetLock,
        loadRegistrySnapshot: options.loadRegistrySnapshot,
        withSnapshotLock: options.withSnapshotLock,
      },
      cleanup,
      send,
    );

  return {
    async tryCompleteCore<Context extends OnboardFlowContext<{ name: string } | null>>(
      result: Awaited<ReturnType<typeof runCoreOnboardFlowSlice<Context>>>,
    ): Promise<boolean> {
      if (!isCoreFlowCompleteBeforeFinalization(result)) return false;
      disarmRollback();
      await complete(
        result.context,
        // Providerless completion skipped agent setup, so it proves no agent.
        { sandboxName: result.context.sandboxName, finalizedAgent: undefined },
        async () => {
          await supersede();
          onCompleted(true);
        },
      );
      return true;
    },
    beginFinal<Context extends OnboardFlowContext<{ name: string } | null>>(
      initialContext: Context & { sandboxName: string },
    ) {
      let currentContext: Context = initialContext;
      return {
        initialSandboxName: initialContext.sandboxName,
        get context(): Context {
          return currentContext;
        },
        run(
          options: Omit<
            Parameters<typeof runFinalOnboardFlowSlice<Context>>[0],
            "context" | "onContextUpdated"
          >,
        ): ReturnType<typeof runFinalOnboardFlowSlice<Context>> {
          return runFinalOnboardFlowSlice({
            ...options,
            context: currentContext,
            onContextUpdated: (context) => {
              currentContext = context;
            },
          });
        },
        async complete(
          session: Pick<
            NonNullable<OnboardFlowContext["session"]>,
            "machine" | "sandboxName" | "agent"
          >,
        ): Promise<boolean> {
          const completed = session.machine.state === "complete";
          // Final flow records completion before retirement, as the entry did.
          onCompleted(completed);
          if (completed && session.sandboxName) {
            await complete(
              currentContext,
              {
                sandboxName: session.sandboxName,
                // This completed operation's canonical null sentinel means OpenClaw.
                finalizedAgent:
                  currentContext.agent === null ? "openclaw" : currentContext.agent.name,
                sessionAgent: session.agent,
              },
              supersede,
            );
          }
          return completed;
        },
      };
    },
  };
}

export type FinalOnboardFlowCompositionOptions<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult extends VerifyDeploymentResult = VerifyDeploymentResult,
> = Omit<
  FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>,
  "agentSetupDeps" | "finalizationDeps"
> & {
  readonly portableRuntimeContext?: PortableOnboardRuntimeContext | null;
  agentSetupDeps: Omit<
    FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>["agentSetupDeps"],
    | "waitForSandboxControlPlaneReady"
    | "waitForStartedOpenclawGatewayProcess"
    | "settleStartedOpenclawGatewayForConfiguration"
  >;
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
    agentSetupDeps: {
      ...options.agentSetupDeps,
      waitForSandboxControlPlaneReady: finalizationHandlerDeps.waitForSandboxControlPlaneReady,
      waitForStartedOpenclawGatewayProcess:
        finalizationHandlerDeps.waitForStartedOpenclawGatewayProcess,
      settleStartedOpenclawGatewayForConfiguration:
        finalizationHandlerDeps.settleStartedOpenclawGatewayForConfiguration,
    },
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
