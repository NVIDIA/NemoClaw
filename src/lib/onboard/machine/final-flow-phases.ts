// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig, WebSearchProvider } from "../../inference/web-search";
import { assertSandboxCreatedContext, type OnboardFlowContext } from "./flow-context";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
  createPostVerifyPhase,
} from "./flow-phases/agent-policy-finalization";
import { UnexpectedOnboardFlowSliceStateError } from "./flow-slice-error";
import { runFinalOnboardFlowSequence } from "./flow-slices";
import { type AgentSetupStateOptions, handleAgentSetupState } from "./handlers/agent-setup";
import {
  type FinalizationStateOptions,
  handleFinalizationState,
  handlePostVerifyState,
} from "./handlers/finalization";
import { handlePoliciesState, type PoliciesStateOptions } from "./handlers/policies";
import { createPhaseProgressReporter } from "./phase-progress";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime, OnboardStateHandlerResult } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import type { OnboardMachineEventType, OnboardMachineState } from "./types";

export interface FinalOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult = unknown,
> {
  branchState: "agent_setup" | "openclaw";
  authoritativePolicyTier?: string | null;
  revalidatePolicyRequirements?(context: Context, operation: string): void;
  agentSetupDeps: AgentSetupStateOptions<Context["agent"]>["deps"];
  policiesDeps: PoliciesStateOptions<Context["agent"], WebSearchConfig>["deps"];
  finalization: {
    stagedLegacyKeys: readonly string[];
    migratedLegacyKeys: ReadonlySet<string>;
    webSearchEnabled(webSearchConfig: WebSearchConfig | null): boolean;
    webSearchProvider(webSearchConfig: WebSearchConfig): WebSearchProvider;
  };
  finalizationDeps: Omit<
    FinalizationStateOptions<Context["agent"], VerifyChain, VerificationResult>["deps"],
    "persistDashboardPort"
  >;
}

export function createFinalOnboardFlowPhases<
  Context extends OnboardFlowContext,
  VerifyChain = unknown,
  VerificationResult = unknown,
>(
  options: FinalOnboardFlowPhaseOptions<Context, VerifyChain, VerificationResult>,
): [
  OnboardSequencePhase<Context>,
  OnboardSequencePhase<Context>,
  OnboardSequencePhase<Context>,
  OnboardSequencePhase<Context>,
] {
  const finalizationDeps = {
    ...options.finalizationDeps,
    persistDashboardPort: options.agentSetupDeps.persistDashboardPort,
  };
  const revalidationFor = (context: Context) =>
    options.revalidatePolicyRequirements?.bind(null, context) ??
    finalizationDeps.revalidatePolicyRequirements;
  const createBranchPhase =
    options.branchState === "agent_setup" ? createAgentSetupPhase : createOpenclawSetupPhase;
  const branchSetupPhase = createBranchPhase<Context>(async (context) => {
    assertSandboxCreatedContext(context, "agent setup");
    const agentSetupResult = await handleAgentSetupState({
      agent: context.agent,
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      webSearchConfig: context.webSearchConfig,
      resume: context.resume,
      session: context.session,
      hermesAuthMethod: context.hermesAuthMethod,
      hermesToolGateways: context.hermesToolGateways,
      revalidatePolicyRequirements: revalidationFor(context),
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
      authoritativePolicyTier: options.authoritativePolicyTier,
      sandboxName: context.sandboxName,
      provider: context.provider,
      hostLocalInferenceRouteOnly: context.hostLocalInferenceRouteOnly === true,
      hostLocalInferenceSandboxProofAuthority:
        context.hostLocalInferenceSandboxProofAuthority ?? null,
      model: context.model,
      endpointUrl: context.endpointUrl,
      credentialEnv: context.credentialEnv,
      selectedMessagingChannels: context.selectedMessagingChannels,
      webSearchConfig: context.webSearchConfig,
      webSearchConfigChanged: context.webSearchConfigChanged === true,
      webSearchSupported: context.webSearchSupported,
      hermesToolGateways: context.hermesToolGateways,
      agent: context.agent,
      revalidatePolicyRequirements: revalidationFor(context),
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
    const webSearchEnabled = options.finalization.webSearchEnabled(context.webSearchConfig);
    const revalidatePolicyRequirements = revalidationFor(context);
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
      webSearchEnabled,
      webSearchProvider:
        webSearchEnabled && context.webSearchConfig
          ? options.finalization.webSearchProvider(context.webSearchConfig)
          : null,
      portableProfileSelected: context.session?.checkpoint?.profile.value === "portable",
      recreateJournalHandoff: context.recreateJournalHandoff,
      deps: { ...finalizationDeps, revalidatePolicyRequirements },
    });
    return { result: finalizationResult.stateResult };
  });

  const postVerifyPhase = createPostVerifyPhase<Context>(async (context) => {
    assertSandboxCreatedContext(context, "post verification");
    const webSearchEnabled = options.finalization.webSearchEnabled(context.webSearchConfig);
    const postVerifyResult = await handlePostVerifyState({
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      nimContainer: context.nimContainer,
      agent: context.agent,
      hermesAuthMethod: context.hermesAuthMethod,
      hermesToolGateways: context.hermesToolGateways,
      stagedLegacyKeys: options.finalization.stagedLegacyKeys,
      migratedLegacyKeys: options.finalization.migratedLegacyKeys,
      webSearchEnabled,
      webSearchProvider:
        webSearchEnabled && context.webSearchConfig
          ? options.finalization.webSearchProvider(context.webSearchConfig)
          : null,
      portableProfileSelected: context.session?.checkpoint?.profile.value === "portable",
      recreateJournalHandoff: context.recreateJournalHandoff,
      deps: {
        ...finalizationDeps,
        revalidatePolicyRequirements: revalidationFor(context),
      },
    });
    return { result: postVerifyResult.stateResult };
  });

  return [branchSetupPhase, policiesPhase, finalizationPhase, postVerifyPhase];
}

function isPoliciesAppliedResult(result: OnboardStateResult): boolean {
  return (
    result.type === "transition" &&
    result.next === "finalizing" &&
    result.metadata?.state === "policies"
  );
}

function withAfterPoliciesReady(
  runtime: OnboardMachineRunnerRuntime,
  afterPoliciesReady: (() => void) | undefined,
): OnboardMachineRunnerRuntime {
  if (!afterPoliciesReady) return runtime;
  return {
    session: runtime.session.bind(runtime),
    async applyResult(result) {
      const session = await runtime.applyResult(result);
      if (isPoliciesAppliedResult(result)) afterPoliciesReady();
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

type FinalFlowRepairEventType = Extract<
  OnboardMachineEventType,
  "state.repair.started" | "state.repair.completed" | "state.repair.failed"
>;

type FinalFlowRepairEventRecorder = (
  type: FinalFlowRepairEventType,
  options: {
    state?: OnboardMachineState | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) => Promise<unknown>;

const FINAL_FLOW_DOWNSTREAM_STATES = ["policies", "finalizing", "post_verify"] as const;

function canonicalFinalFlowPhases<Context extends OnboardFlowContext>(
  phases: readonly OnboardSequencePhase<Context>[],
): {
  branchState: "agent_setup" | "openclaw";
  phases: readonly OnboardSequencePhase<Context>[];
} {
  const branchPhases = phases.filter(
    (phase) => phase.state === "openclaw" || phase.state === "agent_setup",
  );
  if (branchPhases.length !== 1) {
    throw new Error(
      `Expected exactly one final onboarding branch phase, got ${branchPhases.length}`,
    );
  }
  if (phases.length !== 4) {
    throw new Error(`Expected exactly four final onboarding phases, got ${phases.length}`);
  }
  const branchState = branchPhases[0].state as "agent_setup" | "openclaw";
  const expectedStates = [branchState, ...FINAL_FLOW_DOWNSTREAM_STATES] as const;
  const canonicalPhases = expectedStates.map((state) => {
    const matches = phases.filter((phase) => phase.state === state);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one final onboarding phase for state '${state}', got ${matches.length}`,
      );
    }
    return matches[0];
  });
  return { branchState, phases: canonicalPhases };
}

function singleRepairResult(
  handlerResult: OnboardStateHandlerResult,
  state: OnboardSequencePhase<unknown>["state"],
): OnboardStateResult {
  const results = Array.isArray(handlerResult)
    ? (handlerResult as readonly OnboardStateResult[])
    : [handlerResult as OnboardStateResult];
  if (results.length !== 1) {
    throw new Error(
      `Final onboarding prerequisite repair for '${state}' returned ${results.length} results; expected exactly one`,
    );
  }
  return results[0];
}

function assertValidRepairResult(
  result: OnboardStateResult,
  state: OnboardSequencePhase<unknown>["state"],
  nextState: OnboardSequencePhase<unknown>["state"],
): void {
  if (
    result.type !== "transition" ||
    result.metadata?.state !== state ||
    result.next !== nextState ||
    result.transitionKind !== "advance" ||
    result.updates !== undefined
  ) {
    throw new Error(
      `Invalid final onboarding prerequisite repair result for '${state}'; expected an update-free advance to '${nextState}'`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runFinalFlowPrerequisiteRepairs<Context extends OnboardFlowContext>(options: {
  context: Context;
  entryState: (typeof FINAL_FLOW_DOWNSTREAM_STATES)[number];
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  recordRepairEvent: FinalFlowRepairEventRecorder;
  afterPoliciesReady?(): void;
  onContextUpdated?(context: Context): void;
}): Promise<Context> {
  const entryIndex = options.phases.findIndex((phase) => phase.state === options.entryState);
  const repairPhases = options.phases.slice(0, entryIndex);
  const phaseProgress = createPhaseProgressReporter();
  let nextContext = options.context;

  for (let index = 0; index < repairPhases.length; index += 1) {
    const phase = phaseProgress.wrap(repairPhases[index]);
    const nextState = options.phases[index + 1].state;
    const metadata = {
      repair: "final-flow-prerequisite",
      entryState: options.entryState,
    };

    try {
      await options.recordRepairEvent("state.repair.started", {
        state: phase.state,
        metadata,
      });
      const phaseResult = await phase.run(nextContext);
      const result = singleRepairResult(phaseResult.result, phase.state);
      assertValidRepairResult(result, phase.state, nextState);
      const current = await options.runtime.session();
      if (current.machine.state !== options.entryState) {
        throw new Error(
          `Final onboarding prerequisite repair for '${phase.state}' changed durable entry state from '${options.entryState}' to '${current.machine.state}'`,
        );
      }
      await options.recordRepairEvent("state.repair.completed", {
        state: phase.state,
        metadata,
      });
      if (phase.state === "policies") options.afterPoliciesReady?.();
      nextContext = phaseResult.context;
      options.onContextUpdated?.(nextContext);
    } catch (error) {
      await options.recordRepairEvent("state.repair.failed", {
        state: phase.state,
        error: errorMessage(error),
        metadata,
      });
      throw error;
    }
  }

  return nextContext;
}

export async function runFinalOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  recordRepairEvent: FinalFlowRepairEventRecorder;
  afterPoliciesReady?(): void;
  onContextUpdated?(context: Context): void;
}) {
  const canonicalFlow = canonicalFinalFlowPhases(options.phases);
  const { branchState, phases } = canonicalFlow;
  const durableEntry = await options.runtime.session();
  const allowedStates = [branchState, ...FINAL_FLOW_DOWNSTREAM_STATES] as const;
  if (!allowedStates.includes(durableEntry.machine.state as (typeof allowedStates)[number])) {
    throw new UnexpectedOnboardFlowSliceStateError(
      durableEntry.machine.state,
      [branchState],
      FINAL_FLOW_DOWNSTREAM_STATES,
    );
  }

  const context = FINAL_FLOW_DOWNSTREAM_STATES.includes(
    durableEntry.machine.state as (typeof FINAL_FLOW_DOWNSTREAM_STATES)[number],
  )
    ? await runFinalFlowPrerequisiteRepairs({
        context: options.context,
        entryState: durableEntry.machine.state as (typeof FINAL_FLOW_DOWNSTREAM_STATES)[number],
        runtime: options.runtime,
        phases,
        recordRepairEvent: options.recordRepairEvent,
        afterPoliciesReady: options.afterPoliciesReady,
        onContextUpdated: options.onContextUpdated,
      })
    : options.context;

  return runFinalOnboardFlowSequence({
    context,
    runtime: withAfterPoliciesReady(options.runtime, options.afterPoliciesReady),
    phases: withContextObserver(phases, options.onContextUpdated),
  });
}
