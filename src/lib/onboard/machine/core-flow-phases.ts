// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import type { OnboardFlowContext } from "./flow-context";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./handlers/provider-inference";
import { handleSandboxState, type SandboxStateOptions } from "./handlers/sandbox";
import type { OnboardStateResult } from "./result";
import type {
  OnboardMachineRunnerResult,
  OnboardMachineRunnerRuntime,
  OnboardStateHandlerResult,
} from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import { runCoreOnboardFlowSequence } from "./flow-slices";

export interface CoreOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
> {
  forceProviderSelection: boolean;
  env: NodeJS.ProcessEnv;
  constants: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["constants"];
  providerDeps: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["deps"];
  sandbox: {
    resumeAgentChanged: boolean;
    controlUiPort: number | null;
    rootDir: string;
  };
  sandboxDeps: SandboxStateOptions<
    Context["gpu"],
    Context["agent"],
    WebSearchConfig,
    MessagingChannelConfig,
    NonNullable<Context["sandboxGpuConfig"]>,
    ResourceProfile
  >["deps"];
}

export function createCoreOnboardFlowPhases<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
>(
  options: CoreOnboardFlowPhaseOptions<Context, Host, MessagingChannelConfig, ResourceProfile>,
): [OnboardSequencePhase<Context>, OnboardSequencePhase<Context>] {
  const providerInferencePhase: OnboardSequencePhase<Context> = {
    state: "provider_selection",
    async run(context) {
      const providerInferenceResult = await handleProviderInferenceState({
        resume: context.resume,
        session: context.session,
        gpu: context.gpu,
        sandboxName: context.sandboxName,
        agent: context.agent,
        forceProviderSelection: options.forceProviderSelection,
        initial: {
          model: context.session?.model || null,
          provider: context.session?.provider || null,
          endpointUrl: context.session?.endpointUrl || null,
          credentialEnv: context.session?.credentialEnv || null,
          hermesAuthMethod: context.session?.hermesAuthMethod || null,
          hermesToolGateways: context.session?.hermesToolGateways ?? [],
          preferredInferenceApi: context.session?.preferredInferenceApi || null,
          nimContainer: context.session?.nimContainer || null,
          webSearchConfig: context.session?.webSearchConfig || null,
        },
        selectedMessagingChannels: context.selectedMessagingChannels,
        env: options.env,
        constants: options.constants,
        deps: options.providerDeps,
      });

      return {
        context: {
          ...context,
          session: providerInferenceResult.session,
          sandboxName: providerInferenceResult.sandboxName,
          model: providerInferenceResult.model,
          provider: providerInferenceResult.provider,
          endpointUrl: providerInferenceResult.endpointUrl,
          credentialEnv: providerInferenceResult.credentialEnv,
          hermesAuthMethod: providerInferenceResult.hermesAuthMethod,
          hermesToolGateways: providerInferenceResult.hermesToolGateways,
          preferredInferenceApi: providerInferenceResult.preferredInferenceApi,
          nimContainer: providerInferenceResult.nimContainer,
          webSearchConfig: providerInferenceResult.webSearchConfig,
        },
        result: providerInferenceResult.stateResults,
      };
    },
  };

  const sandboxPhase: OnboardSequencePhase<Context> = {
    state: "sandbox",
    async run(context) {
      if (!context.model || !context.provider || !context.sandboxGpuConfig) {
        throw new Error("Onboarding state is incomplete before sandbox setup.");
      }
      const sandboxStateResult = await handleSandboxState({
        resume: context.resume,
        fresh: context.fresh,
        resumeAgentChanged: options.sandbox.resumeAgentChanged,
        session: context.session,
        sandboxName: context.sandboxName,
        model: context.model,
        provider: context.provider,
        nimContainer: context.nimContainer,
        webSearchConfig: context.webSearchConfig,
        selectedMessagingChannels: context.selectedMessagingChannels,
        fromDockerfile: context.fromDockerfile,
        agent: context.agent,
        gpu: context.gpu,
        preferredInferenceApi: context.preferredInferenceApi,
        sandboxGpuConfig: context.sandboxGpuConfig,
        hermesToolGateways: context.hermesToolGateways,
        controlUiPort: options.sandbox.controlUiPort,
        rootDir: options.sandbox.rootDir,
        deps: options.sandboxDeps,
      });

      return {
        context: {
          ...context,
          session: sandboxStateResult.session,
          sandboxName: sandboxStateResult.sandboxName,
          webSearchConfig: sandboxStateResult.webSearchConfig ?? null,
          selectedMessagingChannels: sandboxStateResult.selectedMessagingChannels,
          webSearchSupported: sandboxStateResult.webSearchSupported,
        },
        result: sandboxStateResult.stateResult,
      };
    },
  };

  return [providerInferencePhase, sandboxPhase];
}

function stateResults(result: OnboardStateHandlerResult): readonly OnboardStateResult[] {
  if (Array.isArray(result)) return result as readonly OnboardStateResult[];
  return [result as OnboardStateResult];
}

export async function runCoreOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
}): Promise<OnboardMachineRunnerResult<Context>> {
  const coreRuntimeSession = await options.runtime.session();
  // Keep resume on the compatibility path for now: resume can intentionally
  // re-run provider/sandbox repair checks even when saved machine state is ahead.
  if (!options.resume && coreRuntimeSession.machine.state === "provider_selection") {
    return runCoreOnboardFlowSequence({
      context: options.context,
      runtime: options.runtime,
      phases: options.phases,
    });
  }

  let context = options.context;
  for (const phase of options.phases) {
    const phaseResult = await phase.run(context);
    for (const stateResult of stateResults(phaseResult.result)) {
      await options.recordStateResult(stateResult);
    }
    context = phaseResult.context;
  }
  return { context, session: await options.runtime.session() };
}
