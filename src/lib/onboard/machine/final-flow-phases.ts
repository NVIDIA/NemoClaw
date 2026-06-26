// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import { assertSandboxCreatedContext, type OnboardFlowContext } from "./flow-context";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
} from "./flow-phases/agent-policy-finalization";
import { runFinalOnboardFlowSequence } from "./flow-slices";
import { type AgentSetupStateOptions, handleAgentSetupState } from "./handlers/agent-setup";
import { type FinalizationStateOptions, handleFinalizationState } from "./handlers/finalization";
import { handlePoliciesState, type PoliciesStateOptions } from "./handlers/policies";
import { runLiveOnboardFlowSlice } from "./live-flow-slice";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

export interface FinalOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult = unknown,
> {
  branchState: "agent_setup" | "openclaw";
  agentSetupDeps: AgentSetupStateOptions<Context["agent"]>["deps"];
  policiesDeps: PoliciesStateOptions<Context["agent"], WebSearchConfig>["deps"];
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
    assertSandboxCreatedContext(context, "agent setup");
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
    assertSandboxCreatedContext(context, "policies");
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
    return {
      context: {
        session: policiesResult.session,
        selectedMessagingChannels: policiesResult.selectedMessagingChannels,
      } as Partial<Context>,
      result: policiesResult.stateResult,
    };
  });

  const finalizationPhase = createFinalizationPhase<Context>(async (context) => {
    assertSandboxCreatedContext(context, "finalization");
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

function isPoliciesAppliedResult(result: OnboardStateResult): boolean {
  return (
    result.type === "transition" &&
    result.next === "finalizing" &&
    result.metadata?.state === "policies"
  );
}

function withAfterPoliciesResultApplied(
  runtime: OnboardMachineRunnerRuntime,
  afterPoliciesResultApplied: (() => void) | undefined,
): OnboardMachineRunnerRuntime {
  if (!afterPoliciesResultApplied) return runtime;
  return {
    session: runtime.session.bind(runtime),
    async applyResult(result) {
      const session = await runtime.applyResult(result);
      if (isPoliciesAppliedResult(result)) afterPoliciesResultApplied();
      return session;
    },
  };
}

function withContextObserver<Context extends OnboardFlowContext>(
  phases: readonly OnboardSequencePhase<Context>[],
  onContextUpdated: ((context: Context) => void) | undefined,
): readonly OnboardSequencePhase<Context>[] {
  if (!onContextUpdated) return phases;
  return phases.map((phase) => ({
    ...phase,
    async run(context) {
      const result = await phase.run(context);
      onContextUpdated(result.context);
      return result;
    },
  }));
}

export async function runFinalOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
  afterPoliciesResultApplied?(): void;
  onContextUpdated?(context: Context): void;
}): Promise<void> {
  // Compatibility bridge for live resume repair when durable machine snapshots
  // are already downstream of this slice even though branch setup/readiness,
  // policy reconciliation, and final verification must still re-run. Those
  // ahead-state snapshots can come from legacy/test step mutation that
  // explicitly opts into `updateMachine === true` or from repaired-resume replay
  // of persisted sessions. This slice cannot eliminate that source locally
  // because final-phase repair checks are still modeled as imperative resume
  // work rather than strict FSM recovery states. The tolerated downstream states
  // are "policies", "finalizing", and "post_verify". Phase tests cover
  // ahead-state resume and terminal-state rejection; remove this fallback once
  // final-phase repair checks are first-class FSM recovery states and legacy
  // machine step mutation is gone.
  await runLiveOnboardFlowSlice({
    context: options.context,
    runtime: withAfterPoliciesResultApplied(options.runtime, options.afterPoliciesResultApplied),
    phases: withContextObserver(options.phases, options.onContextUpdated),
    runWhenState: ["openclaw", "agent_setup"],
    compatibilityWhenState: options.resume
      ? ["openclaw", "agent_setup", "policies", "finalizing", "post_verify"]
      : ["policies", "finalizing", "post_verify"],
    runSlice: runFinalOnboardFlowSequence,
    applyCompatibleResult: async (stateResult) => {
      await options.recordStateResult(stateResult);
      if (isPoliciesAppliedResult(stateResult)) options.afterPoliciesResultApplied?.();
    },
  });
}
