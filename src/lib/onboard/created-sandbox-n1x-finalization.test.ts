// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { createSession, type Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import { createOnboardCreatedSandboxCompletion } from "./created-sandbox-finalization";
import {
  createProviderInferenceOnboardFlowPhase,
  createSandboxOnboardFlowPhase,
} from "./machine/core-flow-phases";
import { prepareCoreOnboardFlowContext } from "./machine/flow-handoff";
import { createDeps as createProviderDeps } from "./machine/handlers/provider-inference.test-support";
import { createDeps as createSandboxDeps } from "./machine/handlers/sandbox-test-fixtures";
import {
  createInitialOnboardFlowPhases,
  type InitialOnboardFlowContext,
} from "./machine/initial-flow-phases";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import {
  buildCreatedSandboxRegistryEntry,
  type CreatedSandboxRegistrationInput,
} from "./sandbox-registration";

const sandboxName = "n1x-preview";
const model = "nvidia/Qwen3.6-35B-A3B-NVFP4";
const provider = "vllm-local";
const previewEnv = { NEMOCLAW_PROVIDER: "install-vllm" };
const inferenceSelection = {
  provider,
  model,
  endpointUrl: null,
  endpointSource: null,
  credentialEnv: null,
  hermesAuthMethod: null,
  preferredInferenceApi: "openai-completions",
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
} as const;

type Gpu = { type: "nvidia"; platform: "n1x" | "spark" };
type GpuConfig = {
  sandboxGpuEnabled: boolean;
  mode: string;
};
type FlowContext = InitialOnboardFlowContext<null, Gpu, GpuConfig>;
type CreateIntent = { deferredN1xManagedVllmPreviewIntent?: true };

function flowContext(session: Session, resume: boolean): FlowContext {
  return {
    resume,
    fresh: !resume,
    session,
    agent: null,
    recordedSandboxName: resume ? sandboxName : null,
    requestedSandboxName: sandboxName,
    sandboxName,
    fromDockerfile: null,
    model: resume ? model : null,
    provider: resume ? provider : null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
    resumeHasResolvedGpuIntent: false,
    requestedGpuPassthrough: true,
  };
}

async function createIntentThroughOnboardFlow(input: {
  resume: boolean;
  platform: Gpu["platform"];
  allowDeferredN1xManagedVllm?: boolean;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ accepted: boolean; createIntent: CreateIntent }> {
  const environment = input.environment ?? previewEnv;
  const session = createSession({
    provider: input.resume ? provider : null,
    model: input.resume ? model : null,
  });
  session.steps.preflight.status = input.resume ? "complete" : session.steps.preflight.status;
  const gpu: Gpu = { type: "nvidia", platform: input.platform };
  const gpuConfig = (): GpuConfig => ({
    sandboxGpuEnabled: true,
    mode: "1",
  });
  const [preflightPhase] = createInitialOnboardFlowPhases({
    explicitSandboxGpuFlag: null,
    sandboxGpuDevice: null,
    gpuRequested: true,
    noGpu: false,
    allowDeferredN1xManagedVllm: input.allowDeferredN1xManagedVllm,
    env: environment,
    platform: "darwin",
    recordedGpuPassthroughBeforePreflight: false,
    ensureResumePreflightDashboardPortAvailable: vi.fn(),
    preflightDeps: {
      getSandbox: () => null,
      getResumeSandboxGpuOverrides: () => ({ flag: null, device: null }),
      detectGpuForReadiness: () => gpu,
      detectGpu: () => gpu,
      runPreflight: async () => gpu,
      assessHost: () => ({}),
      providerNameToOptionKey: () => null,
      assertOnboardHostReadiness: vi.fn(),
      resolveSandboxGpuConfig: gpuConfig,
      validateSandboxGpuPreflight: vi.fn(),
      skippedStepMessage: vi.fn(),
      recordStateSkipped: async () => session,
      startRecordedStep: vi.fn(),
      recordStepComplete: async () => session,
      updateSession: (mutator) => mutator(session) ?? session,
    },
    getInitialGatewayReuseState: () => "healthy",
    assertGatewayReadiness: vi.fn(),
    gatewayName: "nemoclaw",
    recreateSandbox: () => false,
    gatewayDeps: {} as never,
    note: vi.fn(),
  });
  const preflight = await preflightPhase.run(flowContext(session, input.resume));
  const coreContext = prepareCoreOnboardFlowContext({
    initial: { context: preflight.context, session: preflight.context.session ?? session },
    recordedSandboxName: input.resume ? sandboxName : null,
    requestedSandboxName: sandboxName,
    checkpointedSandboxName: null,
    selectedMessagingChannels: [],
    assertSandboxNameAllowed: vi.fn(),
  });
  const providerHarness = createProviderDeps({
    setupNim: vi.fn(async () => ({ ...inferenceSelection, hermesToolGateways: [] })),
  });
  const endpointProvenance = { getSandboxRegistryEntry: () => null };
  const providerPhase = createProviderInferenceOnboardFlowPhase<typeof coreContext, object>({
    gatewayName: "nemoclaw",
    forceProviderSelection: true,
    inspectSandboxForCreate: () => ({
      existingEntry: null,
      preservedMcpState: undefined,
      liveExists: false,
    }),
    endpointProvenance,
    env: environment,
    constants: {
      hermesProviderName: "hermes",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "HERMES_API_KEY",
    },
    deps: providerHarness.deps as never,
  });
  const providerResult = await providerPhase.run(coreContext);
  const sandboxHarness = createSandboxDeps({}, providerResult.context.session ?? session);
  const sandboxPhase = createSandboxOnboardFlowPhase<typeof providerResult.context>({
    gatewayName: "nemoclaw",
    resumeAgentChanged: false,
    endpointProvenance,
    recreateSandbox: () => false,
    controlUiPort: null,
    rootDir: "/repo",
    env: environment,
    deps: sandboxHarness.deps as never,
  });
  await sandboxPhase.run(providerResult.context);
  return {
    accepted: preflight.context.deferredN1xManagedVllmPreviewAccepted === true,
    createIntent: (
      sandboxHarness.calls.createSandbox.mock.calls[0] as unknown[]
    )[15] as CreateIntent,
  };
}

async function completeRegistration(createIntent: CreateIntent): Promise<{
  input: CreatedSandboxRegistrationInput;
  registered: SandboxEntry;
}> {
  const lifecycleGeneration = "generation-1";
  const lifecycleLiveIdentityFingerprint = "a".repeat(64);
  const verifiedCreateBoundary = {
    sandboxName,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint,
    route: "native" as const,
  };
  const reservation = {
    authority: {
      sandboxName,
      gatewayName: "nemoclaw",
      sessionId: "session-1",
      selection: inferenceSelection,
    },
    entry: { name: sandboxName },
  } as never;
  let registrationInput: CreatedSandboxRegistrationInput | undefined;
  const completion = createOnboardCreatedSandboxCompletion(
    sandboxName,
    null,
    null,
    null,
    null,
    { customOpenClawImage: false, isManagedDcodeAgent: false },
    { ...inferenceSelection, preferredInferenceApi: "openai-completions" },
    {
      createIntent: { endpointSource: null, ...createIntent, observabilityEnabled: false },
      resolvedCreateIntent: { policy: { options: {} } },
    },
    { openshellDriver: "docker" } as never,
    false,
    {} as never,
    { webSearchConfig: null, hermesAuthMethod: null },
    { plannedMessagingState: undefined, preservedMcpState: undefined, hermesToolGateways: [] },
    null,
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    {
      initialSandboxPolicy: { policyPath: "/tmp/policy.yaml" } as never,
      compatibilityPolicyPath: null,
      dashboardRemoteBindPrepared: false,
      getVerifiedCreateBoundary: () => verifiedCreateBoundary,
      getVerifiedCreateRegistrationAuthority: () => ({
        reservation,
        checkpoint: pendingSandboxCreateIdentityForBoundary(verifiedCreateBoundary),
      }),
      revalidateSandboxIdentity: vi.fn(),
    },
    null,
    "build-1",
    { sandboxGpuEnabled: false },
    true,
    vi.fn(),
    vi.fn(),
    "http://127.0.0.1:8643",
    { config: null, enabled: false },
    vi.fn(),
    () => "8643",
    () => ({ config: null, enabled: false }),
    {} as never,
    { source: { kind: "legacy-dockerfile" } } as never,
    vi.fn(),
    {
      registerCreatedSandbox: (input) => {
        registrationInput = input;
        return buildCreatedSandboxRegistryEntry(input);
      },
    },
  );
  const created = {
    origin: "created",
    createResult: { status: 0, output: "Built image n1x:test", sawProgress: true },
    route: "native",
    firstCreateOutput: "",
    registryImageRef: null,
    lifecycleRegistrationFields: { lifecycleGeneration },
    runtimePatch: {},
  } as SandboxGpuCreateFlowResult;
  const lifecycle = {
    generation: lifecycleGeneration,
    recordExactIdentity: () => ({ lifecycleGeneration, lifecycleLiveIdentityFingerprint }),
    capture: () => ({ lifecycleGeneration, lifecycleLiveIdentityFingerprint }),
    revalidate: (registration: {
      lifecycleGeneration: string;
      lifecycleLiveIdentityFingerprint: string;
    }) => registration,
  };
  const registered = (await completion.complete(
    created,
    null,
    "disabled",
    false,
    () => ({ lifecycleGeneration }),
    lifecycle,
  )) as SandboxEntry;
  return { input: registrationInput as unknown as CreatedSandboxRegistrationInput, registered };
}

it.each([
  ["fresh N1x", false, "n1x", undefined, previewEnv, true],
  ["resumed N1x", true, "n1x", true, {}, true],
  ["DGX Spark", false, "spark", undefined, previewEnv, false],
  ["explicit rebuild denial", false, "n1x", false, previewEnv, false],
  ["ordinary N1x opt-out", false, "n1x", undefined, { NEMOCLAW_NO_EXPRESS: "1" }, false],
] as const)(
  "carries %s preview acceptance through final registration (#10959)",
  async (_case, resume, platform, allow, environment, expected) => {
    const flow = await createIntentThroughOnboardFlow({
      resume,
      platform,
      environment,
      ...(allow === undefined ? {} : { allowDeferredN1xManagedVllm: allow }),
    });
    const registration = await completeRegistration(flow.createIntent);

    expect([
      flow.accepted,
      flow.createIntent.deferredN1xManagedVllmPreviewIntent,
      registration.input.deferredN1xManagedVllmPreviewIntent,
      registration.registered.deferredN1xManagedVllmAccepted,
    ]).toEqual(expected ? [true, true, true, true] : [false, undefined, undefined, undefined]);
  },
);
