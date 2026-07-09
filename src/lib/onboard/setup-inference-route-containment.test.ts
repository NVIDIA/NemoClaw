// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { checkGatewayRouteCompatibility } from "../inference/gateway-route-compatibility";
import type { SandboxEntry } from "../state/registry";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

describe("onboard shared gateway route containment", () => {
  it("preflights a resumed custom endpoint and pins the final host smoke (#6293)", async () => {
    let lookupCount = 0;
    const resolveEndpointHost = vi.fn(async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "10.0.0.8", family: 4 }];
    });
    const verifyOnboardInferenceSmoke = vi.fn();
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox: vi.fn(() => true),
      upsertProvider: vi.fn(() => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke,
      resolveEndpointHost,
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      REMOTE_PROVIDER_CONFIG: {
        custom: {
          label: "Other OpenAI-compatible endpoint",
          providerName: "compatible-endpoint",
          providerType: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          endpointUrl: "https://public-name.example/v1",
          helpUrl: null,
          modelMode: "input",
          defaultModel: "model-a",
        },
      },
      hydrateCredentialEnv: vi.fn(() => "secret"),
      promptValidationRecovery: vi.fn(),
      classifyApplyFailure: vi.fn(),
      localInferenceTimeoutSecs: 60,
      bedrockRuntimeOnboard: {
        setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://public-name.example/v1",
        "COMPATIBLE_API_KEY",
      ),
    ).resolves.toEqual({ ok: true });

    expect(resolveEndpointHost).toHaveBeenCalledOnce();
    expect(verifyOnboardInferenceSmoke).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedAddresses: ["93.184.216.34"] }),
    );
    expect(JSON.stringify(verifyOnboardInferenceSmoke.mock.calls)).not.toContain("10.0.0.8");
  });

  it("rejects a conflict before selecting the gateway or mutating provider state (#6315)", async () => {
    const events: string[] = [];
    const runOpenshell = vi.fn(() => {
      events.push("openshell");
      return { status: 0 };
    });
    const updateSandbox = vi.fn(() => true);
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const getGatewayName = vi.fn(() => "nemoclaw-9090");
    const error = vi.fn((message: string) => events.push(`error:${message}`));
    const exitProcess = vi.fn((code: number): never => {
      events.push(`exit:${code}`);
      throw new Error(`exit ${code}`);
    });
    const checkGatewayRouteCompatibility = vi.fn(() => {
      events.push("guard");
      return {
        ok: false as const,
        gatewayName: "nemoclaw-9090",
        sandboxName: "new-sandbox",
        route: { provider: "anthropic-prod", model: "claude-new" },
        conflicts: [{ sandboxName: "stopped-sandbox", reason: "provider-model" as const }],
      };
    });
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility,
      withSandboxMutationLock: async <T>(_sandboxName: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => {
        events.push("lock");
        return await operation();
      },
      step: () => events.push("step"),
      getGatewayName,
      runOpenshell,
      updateSandbox,
      upsertProvider,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      error,
      exitProcess,
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "new-sandbox",
        "claude-new",
        "anthropic-prod",
        "https://api.anthropic.com",
        "ANTHROPIC_API_KEY",
      ),
    ).rejects.toThrow("exit 1");

    expect(events.slice(0, 2)).toEqual(["lock", "guard"]);
    expect(getGatewayName).toHaveBeenCalledOnce();
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw-9090" }),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stopped-sandbox"));
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("reserves a fresh route before smoke failure lets another setup mutate it (#6315)", async () => {
    const reservations: SandboxEntry[] = [];
    let lockTail = Promise.resolve();
    const withGatewayRouteMutationLock = async <T>(
      _gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const updateSandbox = vi.fn(
      (name: string, route: Parameters<SetupInferenceDeps["updateSandbox"]>[1]) => {
        reservations.push({ name, ...route });
        return true;
      },
    );
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: (
        request: Parameters<SetupInferenceDeps["checkGatewayRouteCompatibility"]>[0],
      ) => checkGatewayRouteCompatibility({ ...request, sandboxes: reservations }),
      withSandboxMutationLock: async <T>(_sandboxName: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock,
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      runOpenshell,
      updateSandbox,
      upsertProvider: vi.fn(() => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(() => {
        throw new Error("smoke failed");
      }),
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      isRoutedInferenceProvider: () => true,
      reconcileModelRouter: vi.fn(async () => undefined),
      routedInference: {
        upsertRoutedProvider: vi.fn(() => ({
          ok: true,
          endpointUrl: "http://router.test/v1",
          result: { ok: true },
        })),
      },
      hydrateCredentialEnv: vi.fn(() => "secret"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess,
    } as unknown as SetupInferenceDeps);

    const results = await Promise.allSettled([
      setupInference("alpha", "model-a", "router-a", "http://router-a.test/v1", "ROUTER_KEY"),
      setupInference("beta", "model-b", "router-b", "http://router-b.test/v1", "ROUTER_KEY"),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "smoke failed" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "exit 1" }) },
    ]);
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      provider: "router-a",
      model: "model-a",
      endpointUrl: "http://router-a.test/v1",
      credentialEnv: "ROUTER_KEY",
      preferredInferenceApi: null,
      gatewayName: "nemoclaw",
    });
    expect(reservations).toHaveLength(1);
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});
