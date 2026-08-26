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
import { UnexpectedOnboardFlowSliceStateError } from "./flow-slice-error";
import { runCoreOnboardFlowSequence } from "./flow-slices";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
} from "./handlers/provider-inference";
import { handleSandboxState, type SandboxStateOptions } from "./handlers/sandbox";
import {
  type OnboardPrerequisiteRepairEventRecorder,
  runOnboardPrerequisiteRepair,
} from "./prerequisite-repair";
import type { OnboardMachineRunnerResult, OnboardMachineRunnerRuntime } from "./runner";
import { type OnboardSequencePhase, runOnboardSequenceWithRunner } from "./sequence-runner";
import type { OnboardMachineState } from "./types";

export { prepareCoreOnboardFlowContext, prepareFinalOnboardFlowContext } from "./flow-handoff";

export interface EndpointProvenanceOptions {
  endpointSource?: InferenceEndpointSource | null;
  endpointSourceProvider?: string | null;
  endpointSourceEndpointUrl?: string | null;
  getSandboxRegistryEntry: (name: string) => {
    provider?: unknown;
    endpointUrl?: unknown;
    endpointSource?: unknown;
  } | null;
}

export interface ProviderInferenceOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  Host = unknown,
> {
  gatewayName: string;
  forceProviderSelection: boolean;
  forceInferenceSetup?: boolean;
  authoritativeResumeConfig?: boolean;
  providerRecoveryReceipt?: ProviderRecoveryReceipt | null;
  providerRecoveryReceiptLedger?: ReturnType<typeof createProviderRecoveryReceiptLedger>;
  endpointProvenance: EndpointProvenanceOptions;
  env: NodeJS.ProcessEnv;
  constants: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["constants"];
  deps: ProviderInferenceStateOptions<Context["gpu"], Context["agent"], Host>["deps"];
}

export interface SandboxOnboardFlowPhaseOptions<
  Context extends OnboardFlowContext,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
> {
  gatewayName: string;
  /** Internal schema-5 lifecycle selection from the locked portable runtime. */
  hermesPortableLifecycle?: boolean;
  authoritativeResumeConfig?: boolean;
  authoritativePolicyTier?: string | null;

  recreateJournalTargetIntentFingerprint?: string | null;
  resumeAgentChanged: boolean;
  requestedObservabilityEnabled?: boolean | null;
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
  rebuildPreservedEnv?: readonly import("../../state/preserved-env").PreservedEnvFile[];
  rebuildPolicyPresets?: readonly string[];
  hostMounts?: readonly import("../../state/registry/types").SandboxHostMount[];
  endpointProvenance: EndpointProvenanceOptions;
  recreateSandbox: (requested?: boolean) => boolean;
  controlUiPort: number | null;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  deps: SandboxStateOptions<
    Context["gpu"],
    Context["agent"],
    WebSearchConfig,
    MessagingChannelConfig,
    NonNullable<Context["sandboxGpuConfig"]>,
    ResourceProfile
  >["deps"];
}

export interface CoreOnboardFlowPhases<Context extends OnboardFlowContext> {
  readonly providerInference: OnboardSequencePhase<Context>;
  readonly sandbox: OnboardSequencePhase<Context>;
}

interface EndpointProvenance {
  endpointSource: InferenceEndpointSource | null;
  onboardEndpointUrl: string | null;
}

function endpointProvenanceForPhase(
  context: Pick<OnboardFlowContext, "fresh" | "sandboxName" | "provider" | "endpointUrl">,
  options: EndpointProvenanceOptions,
): EndpointProvenance {
  if (context.fresh) {
    return { endpointSource: "onboard", onboardEndpointUrl: context.endpointUrl };
  }
  if (options.endpointSource !== undefined) {
    const endpointSource = normalizeInferenceEndpointSource(options.endpointSource);
    if (
      endpointSource === "onboard" &&
      (options.endpointSourceProvider !== context.provider ||
        options.endpointSourceEndpointUrl !== context.endpointUrl)
    ) {
      return { endpointSource: null, onboardEndpointUrl: null };
    }
    return {
      endpointSource,
      onboardEndpointUrl:
        endpointSource === "onboard" ? (options.endpointSourceEndpointUrl ?? null) : null,
    };
  }
  const entry = context.sandboxName ? options.getSandboxRegistryEntry(context.sandboxName) : null;
  const endpointSource = normalizeInferenceEndpointSource(entry?.endpointSource);
  if (endpointSource !== "onboard") {
    return { endpointSource, onboardEndpointUrl: null };
  }
  if (entry?.provider !== context.provider || entry.endpointUrl !== context.endpointUrl) {
    return { endpointSource: null, onboardEndpointUrl: null };
  }
  return { endpointSource, onboardEndpointUrl: context.endpointUrl };
}

export function createProviderInferenceOnboardFlowPhase<
  Context extends OnboardFlowContext,
  Host = unknown,
>(options: ProviderInferenceOnboardFlowPhaseOptions<Context, Host>): OnboardSequencePhase<Context> {
  return createProviderInferencePhase<Context>(async (context) => {
    const endpointProvenance = endpointProvenanceForPhase(context, options.endpointProvenance);
    const providerInferenceResult = await handleProviderInferenceState({
      gatewayName: options.gatewayName,
      resume: context.resume,
      fresh: context.fresh,
      session: context.session,
      gpu: context.gpu,
      gpuPassthrough: context.gpuPassthrough,
      sandboxName: context.sandboxName,
      requestedSandboxName: context.requestedSandboxName,
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

        compatibleEndpointReasoningEffort: context.compatibleEndpointReasoningEffort,
        nimContainer: context.nimContainer,
        webSearchConfig: context.webSearchConfig,
      },
      selectedMessagingChannels: context.selectedMessagingChannels,
      env: options.env,
      constants: options.constants,
      deps: options.deps,
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

        compatibleEndpointReasoningEffort:
          providerInferenceResult.compatibleEndpointReasoningEffort,
        nimContainer: providerInferenceResult.nimContainer,
        webSearchConfig: providerInferenceResult.webSearchConfig,
        hostLocalInferenceRouteOnly: providerInferenceResult.hostLocalInferenceRouteOnly,
        hostLocalInferenceSandboxProofAuthority:
          providerInferenceResult.hostLocalInferenceSandboxProofAuthority,
      }),
      result: providerInferenceResult.stateResults,
    };
  });
}

export function createSandboxOnboardFlowPhase<
  Context extends OnboardFlowContext,
  MessagingChannelConfig = unknown,
  ResourceProfile = unknown,
>(
  options: SandboxOnboardFlowPhaseOptions<Context, MessagingChannelConfig, ResourceProfile>,
): OnboardSequencePhase<Context> {
  return createSandboxPhase<Context>(async (context) => {
    const endpointProvenance =
      context.endpointSource !== undefined
        ? {
            endpointSource: context.endpointSource,
            onboardEndpointUrl: context.onboardEndpointUrl ?? null,
          }
        : endpointProvenanceForPhase(context, options.endpointProvenance);
    const sandboxStateResult = await handleSandboxState({
      resume: context.resume,
      fresh: context.fresh,
      gatewayName: options.gatewayName,
      hermesPortableLifecycle: options.hermesPortableLifecycle === true,
      authoritativeResumeConfig: options.authoritativeResumeConfig,
      authoritativePolicyTier: options.authoritativePolicyTier,
      deferSandboxEffectsUntilPolicyVerification: true,

      recreateJournalTargetIntentFingerprint: options.recreateJournalTargetIntentFingerprint,
      endpointSource: endpointProvenance.endpointSource,
      resumeAgentChanged: options.resumeAgentChanged,
      requestedObservabilityEnabled: options.requestedObservabilityEnabled,
      requestedDcodeAutoApprovalMode: options.requestedDcodeAutoApprovalMode,
      rebuildPreservedEnv: options.rebuildPreservedEnv,
      rebuildPolicyPresets: options.rebuildPolicyPresets,
      hostMounts: options.hostMounts,
      recreateSandbox: options.recreateSandbox,
      session: context.session,
      sandboxName: context.sandboxName,
      model: context.model,
      provider: context.provider,
      endpointUrl: context.endpointUrl,
      compatibleEndpointReasoning: context.compatibleEndpointReasoning,
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
      hostLocalInferenceRouteOnly: context.hostLocalInferenceRouteOnly === true,
      controlUiPort: options.controlUiPort,
      rootDir: options.rootDir,
      env: options.env,
      deps: options.deps,
    });

    return {
      context: mergeSandboxCreatedContext(context, {
        session: sandboxStateResult.session,
        sandboxName: sandboxStateResult.sandboxName,
        recreateJournalHandoff: Boolean(options.recreateJournalTargetIntentFingerprint),
        webSearchConfig: sandboxStateResult.webSearchConfig,
        webSearchConfigChanged: sandboxStateResult.webSearchConfigChanged,
        hermesToolGateways: sandboxStateResult.hermesToolGateways,
        selectedMessagingChannels: sandboxStateResult.selectedMessagingChannels,
        webSearchSupported: sandboxStateResult.webSearchSupported,
      }),
      result: sandboxStateResult.stateResult,
    };
  });
}

export async function runCoreOnboardFlowSlice<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: CoreOnboardFlowPhases<Context>;
  resume: boolean;
  recordRepairEvent: OnboardPrerequisiteRepairEventRecorder;
}): Promise<OnboardMachineRunnerResult<Context>> {
  const durableEntry = await options.runtime.session();
  const state = durableEntry.machine.state;
  const allowedStates: readonly OnboardMachineState[] = options.resume
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
    : ["provider_selection", "inference", "sandbox", "openclaw", "agent_setup"];
  if (!allowedStates.includes(state)) {
    throw new UnexpectedOnboardFlowSliceStateError(
      state,
      ["provider_selection", "inference", "sandbox"],
      allowedStates.filter(
        (candidate) =>
          candidate !== "provider_selection" &&
          candidate !== "inference" &&
          candidate !== "sandbox",
      ),
    );
  }
  if (state === "provider_selection") {
    return runCoreOnboardFlowSequence({
      context: options.context,
      runtime: options.runtime,
      phases: [options.phases.providerInference, options.phases.sandbox],
    });
  }

  const providerRepair = await runOnboardPrerequisiteRepair({
    context: options.context,
    durableEntryState: state,
    phase: options.phases.providerInference,
    expectedFinalStates: ["sandbox"],
    repair: "core-flow-prerequisite",
    runtime: options.runtime,
    recordRepairEvent: options.recordRepairEvent,
  });
  if (state === "inference") {
    const inferenceResult = [...providerRepair.results]
      .reverse()
      .find((result) => result.type === "transition" && result.metadata?.state === "inference");
    if (!inferenceResult) {
      throw new Error("Core onboarding inference repair returned no inference result");
    }
    const inferencePhase: OnboardSequencePhase<Context> = {
      state: "inference",
      run: () => ({ context: providerRepair.context, result: inferenceResult }),
    };
    return runOnboardSequenceWithRunner({
      context: providerRepair.context,
      runtime: options.runtime,
      phases: [inferencePhase, options.phases.sandbox],
      stopStates: ["openclaw", "agent_setup"],
    });
  }
  if (state === "sandbox") {
    return runOnboardSequenceWithRunner({
      context: providerRepair.context,
      runtime: options.runtime,
      phases: [options.phases.sandbox],
      stopStates: ["openclaw", "agent_setup"],
    });
  }

  const sandboxRepair = await runOnboardPrerequisiteRepair({
    context: providerRepair.context,
    durableEntryState: state,
    phase: options.phases.sandbox,
    expectedFinalStates: ["openclaw", "agent_setup"],
    repair: "core-flow-prerequisite",
    runtime: options.runtime,
    recordRepairEvent: options.recordRepairEvent,
  });
  if ((state === "openclaw" || state === "agent_setup") && sandboxRepair.finalState !== state) {
    throw new Error(
      `Core onboarding prerequisite repair selected '${sandboxRepair.finalState}' for durable entry '${state}'`,
    );
  }
  return { context: sandboxRepair.context, session: await options.runtime.session() };
}
