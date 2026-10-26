// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registration proof for the compatible-endpoint reasoning effort (#12744).
 *
 * The provider and sandbox phases forward the effort into sandbox creation.
 * This test starts from the verified create reservation and runs the real
 * completion and registration code, so a later finalization or registration
 * change that drops the effort fails here. Only the final registry write is
 * intercepted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { getEffectiveReasoningEffort } from "../inference/selection";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import type { QualifiedSandboxInferenceRouteReservation } from "../state/registry/route-reservation";
import { createCreatedSandboxCompletionActions } from "./created-sandbox-finalization";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { CreatedSandboxRegistrationInput } from "./sandbox-registration";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("created sandbox reasoning-effort registration (#12744)", () => {
  it("registers the reserved compatible-endpoint reasoning effort through the real registration path", async () => {
    const written: SandboxEntry[] = [];
    vi.spyOn(registry, "registerSandbox").mockImplementation((entry) => {
      written.push(structuredClone(entry));
      return entry;
    });
    const selection = {
      provider: "compatible-endpoint",
      model: "demo",
      endpointUrl: "https://inference.example.com/v1",
      endpointSource: "onboard" as const,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: "high" as const,
      nimContainer: null,
    };
    const boundary = {
      sandboxName: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      route: "compatibility" as const,
    };
    const reservation = {
      authority: {
        sandboxName: "openclaw",
        gatewayName: "nemoclaw",
        sessionId: "session-1",
        selection,
      },
      entry: { name: "openclaw" },
    } satisfies QualifiedSandboxInferenceRouteReservation;
    const verifiedCreate = {
      reservation,
      checkpoint: {
        ...pendingSandboxCreateIdentityForBoundary(boundary),
        exactFinalHandoffCommitStarted: true as const,
        exactFinalHandoffRuntimeId: "b".repeat(64),
        exactFinalHandoffAcknowledged: true as const,
      },
    } as NonNullable<CreatedSandboxRegistrationInput["verifiedCreate"]>;
    const identity = {
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
    };
    const gpuConfig: SandboxGpuConfig = {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: "linux",
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    };
    const completion = createCreatedSandboxCompletionActions(
      {
        finalization: {
          sandboxName: "openclaw",
          restoreBackupPath: null,
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          validateManagedDcode: false,
          provider: selection.provider,
          model: selection.model,
          preferredInferenceApi: selection.preferredInferenceApi,
        },
        registration: {
          sandboxName: "openclaw",
          // The session-derived seed carries no effort; registration must use
          // the verified reservation authority instead.
          inferenceSelection: { ...selection, compatibleEndpointReasoningEffort: null },
          runtimeFields: {
            gpuEnabled: false,
            hostGpuDetected: false,
            sandboxGpuEnabled: false,
            sandboxGpuMode: "0",
            sandboxGpuDevice: null,
            sandboxGpuProof: null,
            openshellDriver: "docker",
            openshellVersion: "0.0.106",
          },
          agent: null,
          agentVersionKnown: true,
          plannedMessagingState: undefined,
          hermesToolGateways: [],
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        },
        policy: {
          initialPolicyPath: "/private/initial-policy.yaml",
          compatibilityPolicyPath: "/private/compatibility-policy.yaml",
          getVerifiedCreateBoundary: () => boundary,
          getVerifiedCreateRegistrationAuthority: () => verifiedCreate,
        },
        gpu: {
          commandExecutor: { runBuffered: vi.fn() },
          config: gpuConfig,
          provider: selection.provider,
          dockerDriverGateway: true,
          verifyDirectSandboxGpu: vi.fn(),
          resolveOpenShellGpuDiagnostics: () => ({ collect: vi.fn(() => []) }),
          runCaptureOpenshell: vi.fn(),
          persistFinalHandoffAcknowledgement: vi.fn(),
          persistFinalHandoffCommitStarted: vi.fn(),
        },
        dashboard: {
          chatUiUrl: "http://127.0.0.1:18789",
          initialHermesState: { config: null, enabled: false },
          releasePort: async () => undefined,
          getForwardPort: () => "18789",
          resolveHermesState: () => ({ config: null, enabled: false }),
        },
        workload: {
          runtime: {
            runtimeProvider: null,
            ensurePreparedWorkload: vi.fn(),
            ensurePreparedProfile: vi.fn(),
          },
          workload: {
            source: {
              kind: "legacy-dockerfile",
              dockerfilePath: "/workspace/Dockerfile",
              reason: "agent-not-managed",
            },
            release: null,
            fallbackDiagnostic: null,
          },
          prebuildImageRef: null,
          buildId: "build-1",
          extractBuiltImageRef: () => "openclaw:test",
          resolveSandboxImageTagFromCreateOutput: vi.fn(),
        },
      },
      {
        restoreRecreatedSandboxState: vi.fn(),
        getDcodeSelectionDrift: vi.fn(),
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code): never => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
    );

    await completion.complete(
      {
        createResult: { status: 0, output: "", sawProgress: true },
        route: "compatibility",
        firstCreateOutput: "",
        registryImageRef: null,
        lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
      } as SandboxGpuCreateFlowResult,
      null,
      "disabled",
      false,
      () => ({ lifecycleGeneration: "generation-1" }),
      {
        generation: "generation-1",
        recordExactIdentity: () => identity,
        capture: () => identity,
        revalidate: (registration: typeof identity) => registration,
      },
    );

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      name: "openclaw",
      provider: "compatible-endpoint",
      compatibleEndpointReasoningEffort: "high",
    });
    expect(getEffectiveReasoningEffort(written[0])).toBe("high");
  });
});
