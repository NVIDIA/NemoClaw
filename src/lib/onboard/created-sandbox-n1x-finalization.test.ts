// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import { createOnboardCreatedSandboxCompletion } from "./created-sandbox-finalization";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import { buildCreatedSandboxRegistryEntry } from "./sandbox-registration";

it("persists admitted N1x preview intent through final registration (#10959)", async () => {
  const sandboxName = "n1x-preview";
  const lifecycleGeneration = "generation-1";
  const lifecycleLiveIdentityFingerprint = "a".repeat(64);
  const inferenceSelection = {
    provider: "vllm-local",
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    endpointUrl: null,
    endpointSource: null,
    credentialEnv: null,
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  } as const;
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
  const completion = createOnboardCreatedSandboxCompletion(
    sandboxName,
    null,
    null,
    null,
    null,
    { customOpenClawImage: false, isManagedDcodeAgent: false },
    { ...inferenceSelection, preferredInferenceApi: "openai-completions" },
    {
      createIntent: {
        endpointSource: null,
        deferredN1xManagedVllmPreviewIntent: true,
        observabilityEnabled: false,
      },
      resolvedCreateIntent: { policy: { options: {} } },
    },
    {
      gpuEnabled: true,
      hostGpuDetected: true,
      sandboxGpuEnabled: true,
      sandboxGpuMode: "1",
      sandboxGpuDevice: null,
      sandboxGpuProof: null,
      openshellDriver: "docker",
      openshellVersion: "0.0.106",
    },
    false,
    { toolDisclosure: undefined, dcodeAutoApprovalMode: "disabled" },
    { webSearchConfig: null, hermesAuthMethod: null },
    { plannedMessagingState: undefined, preservedMcpState: undefined, hermesToolGateways: [] },
    null,
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    {
      initialSandboxPolicy: { appliedPresets: [], policyPath: "/tmp/policy.yaml" },
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
    {
      hostGpuPlatform: "n1x",
      sandboxGpuEnabled: true,
      sandboxGpuDevice: null,
    },
    true,
    vi.fn(),
    vi.fn(),
    "http://127.0.0.1:8643",
    { config: null, enabled: false },
    vi.fn(),
    () => "8643",
    () => ({ config: null, enabled: false }),
    { runtimeProvider: null, ensurePreparedWorkload: vi.fn(), ensurePreparedProfile: vi.fn() },
    {
      source: {
        kind: "legacy-dockerfile",
        dockerfilePath: "/workspace/Dockerfile",
        reason: "agent-not-managed",
      },
      release: null,
      fallbackDiagnostic: null,
    },
    vi.fn(),
    { registerCreatedSandbox: (input) => buildCreatedSandboxRegistryEntry(input) },
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

  expect(registered.deferredN1xManagedVllmAccepted).toBe(true);
});
