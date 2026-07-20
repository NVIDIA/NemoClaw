// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type InferenceEndpointSource,
  normalizeInferenceEndpointSource,
} from "../../inference/selection";
import type { WebSearchConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../dcode-auto-approval";
import type {
  createProviderRecoveryReceiptLedger,
  ProviderRecoveryReceipt,
} from "../rebuild-route-handoff";
import {
  mergeProviderModelSelectedContext,
  mergeSandboxCreatedContext,
  type OnboardFlowContext,
} from "./flow-context";
import { createProviderInferencePhase, createSandboxPhase } from "./flow-phases/provider-sandbox";
import { runCoreOnboardFlowSequence } from "./flow-slices";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./handlers/provider-inference";
import { handleSandboxState, type SandboxStateOptions } from "./handlers/sandbox";
import {
  type InvalidatedOnboardStateResultRecorder,
  runLiveOnboardFlowSlice,
} from "./live-flow-slice";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerResult, OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";

export interface CoreOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
> {
  gatewayName: string;
  forceProviderSelection: boolean;
  forceInferenceSetup?: boolean;
  authoritativeResumeConfig?: boolean;
  providerRecoveryReceipt?: ProviderRecoveryReceipt | null;
  providerRecoveryReceiptLedger?: ReturnType<typeof createProviderRecoveryReceiptLedger>;
  env: NodeJS.ProcessEnv;
  constants: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["constants"];
  providerDeps: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["deps"];
  sandbox: {
    resumeAgentChanged: boolean;
    requestedObservabilityEnabled?: boolean | null;
    requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
    authoritativePolicyTier?: string | null;
    endpointSource?: InferenceEndpointSource | null;
    endpointSourceProvider?: string | null;
    endpointSourceEndpointUrl?: string | null;
    recreateSandbox: (requested?: boolean) => boolean;
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

interface EndpointProvenance {
  endpointSource: InferenceEndpointSource | null;
  onboardEndpointUrl: string | null;
}

function endpointProvenanceForPhase(
  context: Pick<OnboardFlowContext, "fresh" | "sandboxName" | "provider" | "endpointUrl">,
  configuredSource: InferenceEndpointSource | null | undefined,
  configuredProvider: string | null | undefined,
  configuredEndpointUrl: string | null | undefined,
  getSandboxRegistryEntry: (name: string) => {
    provider?: unknown;
    endpointUrl?: unknown;
    endpointSource?: unknown;
  } | null,
): EndpointProvenance {
  if (context.fresh) {
    return { endpointSource: "onboard", onboardEndpointUrl: context.endpointUrl };
  }
  if (configuredSource !== undefined) {
    const endpointSource = normalizeInferenceEndpointSource(configuredSource);
    if (
      endpointSource === "onboard" &&
      (configuredProvider !== context.provider || configuredEndpointUrl !== context.endpointUrl)
    ) {
      return { endpointSource: null, onboardEndpointUrl: null };
    }
    return {
      endpointSource,
      onboardEndpointUrl: endpointSource === "onboard" ? (configuredEndpointUrl ?? null) : null,
    };
  }
  const entry = context.sandboxName ? getSandboxRegistryEntry(context.sandboxName) : null;
  const endpointSource = normalizeInferenceEndpointSource(entry?.endpointSource);
  if (endpointSource !== "onboard") {
    return { endpointSource, onboardEndpointUrl: null };
  }
  if (entry?.provider !== context.provider || entry.endpointUrl !== context.endpointUrl) {
    return { endpointSource: null, onboardEndpointUrl: null };
  }
  return { endpointSource, onboardEndpointUrl: context.endpointUrl };
}

export function createCoreOnboardFlowPhases<
  Context extends OnboardFlowContext,
  Host = unknown,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
>(
  options: CoreOnboardFlowPhaseOptions<Context, Host, MessagingChannelConfig, ResourceProfile>,
): [OnboardSequencePhase<Context>, OnboardSequencePhase<Context>] {
  const providerInferencePhase = createProviderInferencePhase<Context>(async (context) => {
    const endpointProvenance = endpointProvenanceForPhase(
      context,
      options.sandbox.endpointSource,
      options.sandbox.endpointSourceProvider,
      options.sandbox.endpointSourceEndpointUrl,
      options.sandboxDeps.getSandboxRegistryEntry,
    );
    const providerInferenceResult = await handleProviderInferenceState({
      gatewayName: options.gatewayName,
      resume: context.resume,
      fresh: context.fresh,
      session: context.session,
      gpu: context.gpu,
      sandboxName: context.sandboxName,
      agent: context.agent,
      forceProviderSelection: options.forceProviderSelection,
      forceInferenceSetup: options.forceInferenceSetup,
      authoritativeResumeConfig: options.authoritativeResumeConfig,
      providerRecoveryReceipt: options.providerRecoveryReceipt,
      providerRecoveryReceiptLedger: options.providerRecoveryReceiptLedger,
      initial: {
        model: context.model,
        provider: context.provider,
        endpointUrl: context.endpointUrl,
        endpointSource: endpointProvenance.endpointSource,
        onboardEndpointUrl: endpointProvenance.onboardEndpointUrl,
        credentialEnv: context.credentialEnv,
        hermesAuthMethod: context.hermesAuthMethod,
        hermesToolGateways: context.hermesToolGateways,
        preferredInferenceApi: context.preferredInferenceApi,
        compatibleEndpointReasoning: context.compatibleEndpointReasoning,
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
        endpointSource: providerInferenceResult.endpointSource,
        onboardEndpointUrl: providerInferenceResult.onboardEndpointUrl,
        credentialEnv: providerInferenceResult.credentialEnv,
        hermesAuthMethod: providerInferenceResult.hermesAuthMethod,
        hermesToolGateways: providerInferenceResult.hermesToolGateways,
        preferredInferenceApi: providerInferenceResult.preferredInferenceApi,
        compatibleEndpointReasoning: providerInferenceResult.compatibleEndpointReasoning,
        nimContainer: providerInferenceResult.nimContainer,
        webSearchConfig: providerInferenceResult.webSearchConfig,
      }),
      result: providerInferenceResult.stateResults,
    };
  });

  const sandboxPhase = createSandboxPhase<Context>(async (context) => {
    const endpointProvenance =
      context.endpointSource !== undefined
        ? {
            endpointSource: context.endpointSource,
            onboardEndpointUrl: context.onboardEndpointUrl ?? null,
          }
        : endpointProvenanceForPhase(
            context,
            options.sandbox.endpointSource,
            options.sandbox.endpointSourceProvider,
            options.sandbox.endpointSourceEndpointUrl,
            options.sandboxDeps.getSandboxRegistryEntry,
          );
    const sandboxStateResult = await handleSandboxState({
      resume: context.resume,
      fresh: context.fresh,
      gatewayName: options.gatewayName,
      authoritativeResumeConfig: options.authoritativeResumeConfig,
      authoritativePolicyTier: options.sandbox.authoritativePolicyTier,
      endpointSource: endpointProvenance.endpointSource,
      resumeAgentChanged: options.sandbox.resumeAgentChanged,
      requestedObservabilityEnabled: options.sandbox.requestedObservabilityEnabled,
      requestedDcodeAutoApprovalMode: options.sandbox.requestedDcodeAutoApprovalMode,
      recreateSandbox: options.sandbox.recreateSandbox,
      session: context.session,
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      endpointUrl: context.endpointUrl,
      credentialEnv: context.credentialEnv,
      nimContainer: context.nimContainer,
      webSearchConfig: context.webSearchConfig,
      selectedMessagingChannels: context.selectedMessagingChannels,
      fromDockerfile: context.fromDockerfile,
      agent: context.agent,
      gpu: context.gpu,
      preferredInferenceApi: context.preferredInferenceApi,
      sandboxGpuConfig: context.sandboxGpuConfig,
      hermesToolGateways: context.hermesToolGateways,
      hermesAuthMethod: context.hermesAuthMethod,
      controlUiPort: options.sandbox.controlUiPort,
      rootDir: options.sandbox.rootDir,
      env: options.env,
      deps: options.sandboxDeps,
    });

    return {
      context: mergeSandboxCreatedContext(context, {
        session: sandboxStateResult.session,
        sandboxName: sandboxStateResult.sandboxName,
        webSearchConfig: sandboxStateResult.webSearchConfig,
        webSearchConfigChanged: sandboxStateResult.webSearchConfigChanged,
        hermesToolGateways: sandboxStateResult.hermesToolGateways,
        selectedMessagingChannels: sandboxStateResult.selectedMessagingChannels,
        webSearchSupported: sandboxStateResult.webSearchSupported,
      }),
      result: sandboxStateResult.stateResult,
    };
  });

  return [providerInferencePhase, sandboxPhase];
}

export async function runCoreOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
  recordInvalidatedStateResult: InvalidatedOnboardStateResultRecorder;
}): Promise<OnboardMachineRunnerResult<Context>> {
  // Recompute plan for live resume repair when durable machine snapshots
  // are already downstream of this slice even though provider/sandbox
  // repair/backstop checks must still re-run. Those ahead-state snapshots can
  // come from legacy/test step mutation that explicitly opts into
  // `updateMachine === true` or from repaired-resume replay of persisted
  // sessions. Recomputed transition results are explicitly applied or
  // invalidated by runLiveOnboardFlowSlice, so stale phase output cannot update
  // context or silently advance state. This slice cannot eliminate that source
  // locally because the repair/backstop checks are still modeled as imperative
  // resume work rather than strict FSM recovery states. The tolerated downstream
  // family includes sandbox branch states and the final slice handoff states:
  // openclaw, agent_setup, policies, finalizing, and post_verify. Phase tests
  // cover ahead-state resume and terminal-state rejection; remove this fallback
  // once those checks are strict FSM recovery states and legacy machine step
  // mutation is gone.
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
    recordStateResult: options.recordStateResult,
    recordInvalidatedStateResult: options.recordInvalidatedStateResult,
  });
}
