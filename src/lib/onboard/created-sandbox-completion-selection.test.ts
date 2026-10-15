// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLocalIdentity } from "../inference/native-local/contract";
import { createOnboardCreatedSandboxCompletion } from "./created-sandbox-finalization";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("created sandbox completion inference selection", () => {
  it.each([
    {
      label: "mismatched hosted identity",
      provider: "compatible-endpoint",
      endpointUrl: "https://openrouter.ai/api/v1",
      attached: false,
      liveEndpoint: "https://inference.local/v1",
      reachesRegistration: false,
    },
    {
      label: "authenticated local receipt",
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      attached: true,
      liveEndpoint: "http://host.openshell.internal:8000/v1",
      reachesRegistration: true,
    },
    {
      label: "credentialless local receipt",
      provider: "vllm-local",
      endpointUrl: null,
      attached: true,
      liveEndpoint: "http://host.openshell.internal:8000/v1",
      reachesRegistration: true,
    },
    {
      label: "local receipt over a stale endpoint",
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:11436/v1",
      attached: true,
      liveEndpoint: "http://host.openshell.internal:8000/v1",
      reachesRegistration: true,
    },
    {
      label: "shared route without a local receipt",
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      attached: false,
      liveEndpoint: "https://inference.local/v1",
      reachesRegistration: true,
    },
    {
      label: "direct route without a local receipt",
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      attached: false,
      liveEndpoint: "http://host.openshell.internal:8000/v1",
      reachesRegistration: false,
    },
    {
      label: "shared route with a local receipt",
      provider: "compatible-endpoint",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      attached: true,
      liveEndpoint: "https://inference.local/v1",
      reachesRegistration: false,
    },
  ])(
    "validates $label through the production completion constructor (#12975)",
    async ({ provider, endpointUrl, attached, liveEndpoint, reachesRegistration }) => {
      const model = "nvidia/nemotron-3-ultra-550b-a55b";
      const verifiedCreateBoundary = {
        sandboxName: "dcode",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "native" as const,
      };
      const getVerifiedCreateRegistrationAuthority = vi.fn(() => {
        // Stop at the publication boundary after the real identity reader accepts the route.
        throw new Error("registration reached");
      });
      const localBinding = {
        provider: provider as "compatible-endpoint" | "vllm-local",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        authMode: provider === "vllm-local" ? ("sentinel" as const) : ("authenticated" as const),
        gatewayName: "nemoclaw",
        sandboxName: "dcode",
      };
      const nativeLocalProviderAttachment = attached
        ? {
            ...localBinding,
            ...nativeLocalIdentity(localBinding),
            schemaVersion: 1 as const,
            providerId: "selected-provider-id",
          }
        : undefined;
      const runCaptureOpenshell = vi.fn(() =>
        [
          "Sandbox:  dcode",
          "Route:    inference",
          `Provider: ${provider}`,
          `Model:    openai:${model}`,
          `Endpoint: ${liveEndpoint}`,
          "Runtime:  Deep Agents Code (terminal)",
        ].join("\n"),
      );
      const runBuffered = vi.fn(async () => ({
        outcome: { kind: "completed" as const, exitCode: 0 },
        stdout: runCaptureOpenshell(),
        stderr: "",
      }));
      vi.spyOn(process, "exit").mockImplementation((code): never => {
        throw new Error(`exit ${code}`);
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const completionArgs = [
        "dcode",
        null,
        null,
        null,
        null,
        { customOpenClawImage: false, isManagedDcodeAgent: true },
        {
          provider,
          model,
          preferredInferenceApi: "openai-completions",
          endpointUrl,
        },
        {
          createIntent: {
            endpointUrl,
            endpointSource: null,
            observabilityEnabled: false,
          },
          resolvedCreateIntent: {
            policy: { options: {} },
            hostMounts: undefined,
            nativeLocalProviderAttachment,
          },
        },
        {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "none",
          sandboxGpuDevice: null,
          sandboxGpuProof: null,
          openshellDriver: "docker",
          openshellVersion: "0.0.101",
        },
        false,
        { toolDisclosure: undefined, dcodeAutoApprovalMode: "disabled" },
        { webSearchConfig: null, hermesAuthMethod: null },
        {
          plannedMessagingState: undefined,
          preservedMcpState: undefined,
          hermesToolGateways: [],
        },
        null,
        { gatewayName: "nemoclaw", gatewayPort: 8080 },
        {
          initialSandboxPolicy: {
            appliedPresets: ["personal-open-internet"],
            policyPath: "/private/initial-policy.yaml",
          },
          compatibilityPolicyPath: null,
          dashboardRemoteBindPrepared: false,
          getVerifiedCreateBoundary: () => verifiedCreateBoundary,
          getVerifiedCreateRegistrationAuthority,
          revalidateSandboxIdentity: vi.fn(),
        },
        null,
        "build-1",
        {
          mode: "none",
          hostGpuDetected: false,
          hostGpuPlatform: "linux",
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        false,
        vi.fn(),
        runCaptureOpenshell,
        "http://127.0.0.1:8643",
        { config: null, enabled: false },
        vi.fn(),
        vi.fn(),
        vi.fn(),
        {
          runtimeProvider: null,
          ensurePreparedWorkload: vi.fn(),
          ensurePreparedProfile: vi.fn(),
        },
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
        { runBuffered },
      ] as unknown as Parameters<typeof createOnboardCreatedSandboxCompletion>;
      const completion = createOnboardCreatedSandboxCompletion(...completionArgs);
      const created = {
        createResult: { status: 0, output: "", sawProgress: true },
        route: "native",
        firstCreateOutput: "",
        registryImageRef: null,
        lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
      } as SandboxGpuCreateFlowResult;
      const lifecycleLiveIdentityFingerprint = "a".repeat(64);
      const lifecycle = {
        generation: "generation-1",
        recordExactIdentity: () => ({
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint,
        }),
        capture: () => ({
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint,
        }),
        revalidate: (registration: {
          lifecycleGeneration: string;
          lifecycleLiveIdentityFingerprint: string;
        }) => registration,
      };

      await expect(
        completion.complete(
          created,
          null,
          "disabled",
          false,
          () => ({ lifecycleGeneration: "generation-1" }),
          lifecycle,
        ),
      ).rejects.toThrow(reachesRegistration ? "registration reached" : "exit 1");
      expect(getVerifiedCreateRegistrationAuthority).toHaveBeenCalledTimes(
        reachesRegistration ? 1 : 0,
      );
      expect(runBuffered).toHaveBeenCalledOnce();
    },
  );
});
