// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import {
  assertProviderSelectedContext,
  mergeProviderModelSelectedContext,
  mergeSandboxCreatedContext,
  type OnboardFlowContext,
} from "./flow-context";
import { runCoreOnboardFlowSequence } from "./flow-slices";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./handlers/provider-inference";
import { handleSandboxState, type SandboxStateOptions } from "./handlers/sandbox";
import { runLiveOnboardFlowSlice } from "./live-flow-slice";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerResult, OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

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
          model: context.model,
          provider: context.provider,
          endpointUrl: context.endpointUrl,
          credentialEnv: context.credentialEnv,
          hermesAuthMethod: context.hermesAuthMethod,
          hermesToolGateways: context.hermesToolGateways,
          preferredInferenceApi: context.preferredInferenceApi,
          nimContainer: context.nimContainer,
          webSearchConfig: context.webSearchConfig,
        },
        selectedMessagingChannels: context.selectedMessagingChannels,
        env: options.env,
        constants: options.constants,
        deps: options.providerDeps,
      });

      return {
        context: mergeProviderModelSelectedContext(context, {
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
        }),
        result: providerInferenceResult.stateResults,
      };
    },
  };

  const sandboxPhase: OnboardSequencePhase<Context> = {
    state: "sandbox",
    async run(context) {
      assertProviderSelectedContext(context, "sandbox setup");
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
        context: mergeSandboxCreatedContext(context, {
          session: sandboxStateResult.session,
          sandboxName: sandboxStateResult.sandboxName,
          webSearchConfig: sandboxStateResult.webSearchConfig,
          selectedMessagingChannels: sandboxStateResult.selectedMessagingChannels,
          webSearchSupported: sandboxStateResult.webSearchSupported,
        }),
        result: sandboxStateResult.stateResult,
      };
    },
  };

  return [providerInferencePhase, sandboxPhase];
}

export async function runCoreOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
}): Promise<OnboardMachineRunnerResult<Context>> {
  // Compatibility bridge for live resume repair when durable machine snapshots
  // are already downstream of this slice even though provider/sandbox
  // repair/backstop checks must still re-run. Those ahead-state snapshots can
  // come from legacy/test step mutation that explicitly opts into
  // `updateMachine === true` or from repaired-resume replay of persisted
  // sessions. This slice cannot eliminate that source locally because the
  // repair/backstop checks are still modeled as imperative resume work rather
  // than strict FSM recovery states. The tolerated downstream family includes
  // sandbox branch states and the final slice handoff states: openclaw,
  // agent_setup, policies, finalizing, and post_verify. Phase tests cover
  // ahead-state resume and terminal-state rejection; remove this fallback once
  // those checks are strict FSM recovery states and legacy machine step mutation
  // is gone.
  return runLiveOnboardFlowSlice({
    context: options.context,
    runtime: options.runtime,
    phases: options.phases,
    runWhenState: ["provider_selection"],
    compatibilityWhenState: options.resume
      ? [
          "provider_selection",
          "inference",
          "sandbox",
          "openclaw",
          "agent_setup",
          "policies",
          "finalizing",
          "post_verify",
        ]
      : ["inference", "sandbox", "openclaw", "agent_setup"],
    runSlice: runCoreOnboardFlowSequence,
    applyCompatibleResult: options.recordStateResult,
  });
}
