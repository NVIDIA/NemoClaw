// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Recreating a published native NVIDIA sandbox with another model keeps the
// source registry row until backup. Setup must hand that reservation to the
// sandbox phase, which then checks only peers instead of the source (#13810).

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { createPhases, context } from "./machine/core-flow-phases-test-fixtures";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

const RECEIPT = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1" as const,
  providerName: "nemoclaw-nvidia-prod-v1" as const,
  providerId: "provider-id",
};

function harness(source: Record<string, unknown>) {
  const updateSandbox = vi.fn(() => true);
  const revalidateSandboxIdentity = vi.fn();
  const setupInference = createSetupInference({
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step: vi.fn(),
    getGatewayName: () => "nemoclaw",
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    updateSandbox,
    getSandbox: () => source,
    getNativeNvidiaProviderAuthority: () => RECEIPT,
    upsertProvider: vi.fn(async () => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
    isNonInteractive: () => true,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    providerAdapter: {
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      importProviderProfile: vi.fn(async () => ({ ok: true as const })),
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
        ok: true,
        value: {
          name: "nemoclaw-nvidia-prod-v1",
          type: "nemoclaw-nvidia-inference-v1",
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          revision: { id: "provider-id", resourceVersion: 4 },
        },
      })),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
    } as unknown as OpenShellProviderAdapter,
    hydrateCredentialEnv: vi.fn(() => null),
    localInference: {},
    redact: (value: string) => value,
    compactText: (value: string) => value,
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as unknown as SetupInferenceDeps);
  const run = () =>
    setupInference(
      "journal-replace",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia-prod",
      "https://integrate.api.nvidia.com/v1",
      "NVIDIA_INFERENCE_API_KEY",
      null,
      [],
      {
        revalidateSandboxIdentity,
        reuseGatewayCredentialWithoutLocalKey: true,
        deferPublishedRouteReservation: true,
      },
    );
  return { setupInference, run, updateSandbox, revalidateSandboxIdentity };
}

const PUBLISHED_SOURCE = {
  name: "journal-replace",
  provider: "nvidia-prod",
  model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  gatewayName: "nemoclaw",
  createdAt: "2026-10-27T00:00:00.000Z",
  nativeNvidiaProviderAttachment: RECEIPT,
};

describe("native NVIDIA recreate route reservation (#13810)", () => {
  it("defers the published source reservation to the sandbox phase", async () => {
    const { run, updateSandbox, revalidateSandboxIdentity } = harness(PUBLISHED_SOURCE);

    const result = await run();

    expect(result).toEqual({ ok: true, deferredInferenceRoute: expect.any(Function) });
    expect(updateSandbox).not.toHaveBeenCalled();
    const reserve = vi.fn();
    await (
      result as { deferredInferenceRoute: (reserve: () => void) => Promise<void> }
    ).deferredInferenceRoute(reserve);
    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "reserve the backed-up sandbox inference route",
    );
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ nativeNvidiaProviderAttachment: RECEIPT }),
    );
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("carries a newly prepared NVIDIA attachment across the backup boundary", async () => {
    const { nativeNvidiaProviderAttachment: _oldAttachment, ...sourceWithoutAttachment } =
      PUBLISHED_SOURCE;
    const { run, updateSandbox } = harness({
      ...sourceWithoutAttachment,
      provider: "openai",
    });

    const result = await run();

    expect(result).toEqual({ ok: true, deferredInferenceRoute: expect.any(Function) });
    expect(updateSandbox).not.toHaveBeenCalled();
    const reserve = vi.fn();
    await (
      result as {
        deferredInferenceRoute: (reserve: (route?: unknown) => void) => Promise<void>;
      }
    ).deferredInferenceRoute(reserve);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ nativeNvidiaProviderAttachment: RECEIPT }),
    );
  });

  it("still reserves directly when the target row is already a pending reservation", async () => {
    const { run, updateSandbox } = harness({
      ...PUBLISHED_SOURCE,
      pendingRouteReservation: true,
    });

    await expect(run()).resolves.toEqual({ ok: true });
    expect(updateSandbox).toHaveBeenCalledWith(
      "journal-replace",
      expect.objectContaining({ model: "nvidia/nemotron-3-ultra-550b-a55b" }),
    );
  });

  it("carries the real deferred route through the provider and sandbox phases", async () => {
    const events: string[] = [];
    const { setupInference, updateSandbox } = harness(PUBLISHED_SOURCE);
    const checkGatewayRouteCompatibility = vi.fn(() => ({ ok: true as const }));
    const reserveSandboxInferenceRoute = vi.fn(() => {
      events.push("reserve");
      return true;
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const intent = args[15] as { reservePublishedRouteAfterBackup?: () => Promise<void> };
      events.push("backup");
      await intent.reservePublishedRouteAfterBackup?.();
      return "journal-replace";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          provider: "nvidia-prod",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        })),
        setupInference,
      },
      sandboxDeps: {
        createSandbox,
        getSandboxRegistryEntry: () => PUBLISHED_SOURCE as never,
        checkGatewayRouteCompatibility,
        reserveSandboxInferenceRoute,
      },
    });

    const providerResult = await providerPhase.run(
      context({ fresh: true, sandboxName: "journal-replace" }),
    );
    expect(updateSandbox).not.toHaveBeenCalled();
    await sandboxPhase.run(providerResult.context);

    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "journal-replace" }),
    );
    expect(events).toEqual(["backup", "reserve"]);
    expect(reserveSandboxInferenceRoute).toHaveBeenCalledWith(
      "journal-replace",
      expect.objectContaining({
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        nativeNvidiaProviderAttachment: RECEIPT,
        reservationSessionId: providerResult.context.session?.sessionId,
      }),
    );
  });
});
