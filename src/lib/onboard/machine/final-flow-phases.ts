// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import type { OnboardFlowContext } from "./flow-context";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
} from "./flow-phases/agent-policy-finalization";
import { handleAgentSetupState, type AgentSetupStateOptions } from "./handlers/agent-setup";
import { handleFinalizationState, type FinalizationStateOptions } from "./handlers/finalization";
import { handlePoliciesState, type PoliciesStateOptions } from "./handlers/policies";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime, OnboardStateHandlerResult } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import { runFinalOnboardFlowSequence } from "./flow-slices";

export interface FinalOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult = unknown,
> {
  branchState: "agent_setup" | "openclaw";
  agentSetupDeps: AgentSetupStateOptions<Context["agent"]>["deps"];
  policiesDeps: PoliciesStateOptions<Context["agent"], WebSearchConfig>["deps"];
  afterPolicies?(): void;
  finalization: {
    stagedLegacyKeys: readonly string[];
    migratedLegacyKeys: ReadonlySet<string>;
    webSearchEnabled(webSearchConfig: WebSearchConfig | null): boolean;
  };
  finalizationDeps: FinalizationStateOptions<
    Context["agent"],
    VerifyChain,
    VerificationResult
  >["deps"];
}

function requireFinalContext<Context extends OnboardFlowContext>(
  context: Context,
  stepName: string,
): asserts context is Context & { sandboxName: string; model: string; provider: string } {
  if (!context.sandboxName || !context.model || !context.provider) {
    throw new Error(`Onboarding state is incomplete before ${stepName}.`);
  }
}

export function createFinalOnboardFlowPhases<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult = unknown,
>(
  options: FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>,
): [OnboardSequencePhase<Context>, OnboardSequencePhase<Context>, OnboardSequencePhase<Context>] {
  const createBranchPhase =
    options.branchState === "agent_setup" ? createAgentSetupPhase : createOpenclawSetupPhase;
  const branchSetupPhase = createBranchPhase<Context>(async (context) => {
    requireFinalContext(context, "agent setup");
    const agentSetupResult = await handleAgentSetupState({
      agent: context.agent,
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      resume: context.resume,
      session: context.session,
      hermesAuthMethod: context.hermesAuthMethod,
      hermesToolGateways: context.hermesToolGateways,
      deps: options.agentSetupDeps,
    });
    return {
      context: { session: agentSetupResult.session } as Partial<Context>,
      result: agentSetupResult.stateResult,
    };
  });

  const policiesPhase = createPoliciesPhase<Context>(async (context) => {
    requireFinalContext(context, "policies");
    const policiesResult = await handlePoliciesState({
      resume: context.resume,
      sandboxName: context.sandboxName,
      provider: context.provider,
      model: context.model,
      endpointUrl: context.endpointUrl,
      credentialEnv: context.credentialEnv,
      selectedMessagingChannels: context.selectedMessagingChannels,
      webSearchConfig: context.webSearchConfig,
      webSearchSupported: context.webSearchSupported,
      hermesToolGateways: context.hermesToolGateways,
      agent: context.agent,
      deps: options.policiesDeps,
    });
    options.afterPolicies?.();
    return {
      context: { session: policiesResult.session } as Partial<Context>,
      result: policiesResult.stateResult,
    };
  });

  const finalizationPhase = createFinalizationPhase<Context>(async (context) => {
    requireFinalContext(context, "finalization");
    const finalizationResult = await handleFinalizationState({
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      nimContainer: context.nimContainer,
      agent: context.agent,
      hermesAuthMethod: context.hermesAuthMethod,
      hermesToolGateways: context.hermesToolGateways,
      stagedLegacyKeys: options.finalization.stagedLegacyKeys,
      migratedLegacyKeys: options.finalization.migratedLegacyKeys,
      webSearchEnabled: options.finalization.webSearchEnabled(context.webSearchConfig),
      deps: options.finalizationDeps,
    });
    return { result: finalizationResult.stateResult };
  });

  return [branchSetupPhase, policiesPhase, finalizationPhase];
}

function stateResults(result: OnboardStateHandlerResult): readonly OnboardStateResult[] {
  if (Array.isArray(result)) return result as readonly OnboardStateResult[];
  return [result as OnboardStateResult];
}

export async function runFinalOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
}): Promise<void> {
  const finalRuntimeSession = await options.runtime.session();
  // Keep resume on the compatibility path for now: persisted sessions may
  // still need to re-run agent setup, policy reconciliation, or final
  // verification even when the saved machine state is ahead. Remove this
  // fallback once those repair checks are first-class resumable FSM states.
  if (
    !options.resume &&
    (finalRuntimeSession.machine.state === "openclaw" ||
      finalRuntimeSession.machine.state === "agent_setup")
  ) {
    await runFinalOnboardFlowSequence({
      context: options.context,
      runtime: options.runtime,
      phases: options.phases,
    });
    return;
  }

  let context = options.context;
  for (const phase of options.phases) {
    const phaseResult = await phase.run(context);
    for (const stateResult of stateResults(phaseResult.result)) {
      await options.recordStateResult(stateResult);
    }
    context = phaseResult.context;
  }
}
