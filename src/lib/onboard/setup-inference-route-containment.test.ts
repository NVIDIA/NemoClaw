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
      openrouterRuntimeOnboard: {
        setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
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

  it("warns once inside the gateway lock before applying a valid conflicting route (#6315)", async () => {
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
    const log = vi.fn((message: string) => events.push(`log:${message}`));
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
        route: { provider: "router-b", model: "model-b" },
        conflicts: [
          {
            sandboxName: "stopped-sandbox",
            reason: "provider-model" as const,
            recordedRoute: { provider: "router-a", model: "model-a" },
          },
        ],
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
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      isRoutedInferenceProvider: () => true,
      reconcileModelRouter: vi.fn(async () => undefined),
      routedInference: {
        upsertRoutedProvider: vi.fn(() => ({
          ok: true,
          endpointUrl: "http://router-b.test/v1",
          result: { ok: true },
        })),
      },
      hydrateCredentialEnv: vi.fn(() => "secret"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log,
      error,
      exitProcess,
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference("new-sandbox", "model-b", "router-b", "http://router-b.test/v1", "ROUTER_KEY"),
    ).resolves.toEqual({ ok: true });

    expect(events.slice(0, 4)).toEqual([
      "lock",
      "guard",
      expect.stringContaining("error:  Warning: Onboarding 'new-sandbox' will re-point"),
      "step",
    ]);
    expect(getGatewayName).toHaveBeenCalledOnce();
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw-9090" }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "set", "--provider", "router-b", "--model", "model-b"]),
      { ignoreError: true },
    );
    expect(verifyInferenceRoute).toHaveBeenCalledWith("nemoclaw-9090", "router-b", "model-b");
    expect(verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(updateSandbox).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stopped-sandbox"));
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("fails before provider mutation when endpoint or credential identity differs (#6315)", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const updateSandbox = vi.fn(() => true);
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const error = vi.fn();
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const peer: SandboxEntry = {
      name: "existing-custom",
      gatewayName: "nemoclaw",
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: "https://endpoint-a.example/v1",
      credentialEnv: "KEY_A",
      preferredInferenceApi: "openai-completions",
    };
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: (
        request: Parameters<SetupInferenceDeps["checkGatewayRouteCompatibility"]>[0],
      ) => checkGatewayRouteCompatibility({ ...request, sandboxes: [peer] }),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      getGatewayName: () => "nemoclaw",
      runOpenshell,
      updateSandbox,
      upsertProvider,
      error,
      exitProcess,
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "new-custom",
        "model-b",
        "compatible-endpoint",
        "https://endpoint-b.example/v1",
        "KEY_B",
        null,
        [],
        { preferredInferenceApi: "openai-completions" },
      ),
    ).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("provider-global configuration"));
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks recovered-route ownership inside both mutation locks before setup (#6630)", async () => {
    const events: string[] = [];
    const checkGatewayRouteCompatibility = vi.fn(() => ({ ok: true as const }));
    const updateSandbox = vi.fn(() => true);
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const exitProcess = vi.fn((code: number): never => {
      events.push(`exit:${code}`);
      throw new Error(`exit ${code}`);
    });
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility,
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        events.push("sandbox-lock");
        return await operation();
      },
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        events.push("gateway-lock");
        return await operation();
      },
      getGatewayName: () => "nemoclaw",
      error: (message: string) => events.push(`error:${message}`),
      exitProcess,
      updateSandbox,
      runOpenshell,
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "alpha",
        "model-a",
        "anthropic-prod",
        "https://api.anthropic.com",
        "ANTHROPIC_API_KEY",
        null,
        [],
        {
          reservationSessionId: "session-current",
          isRecordedProviderRecoveryAuthorized: () => {
            events.push("recovery-authority");
            return false;
          },
        },
      ),
    ).rejects.toThrow("exit 1");

    expect(events.slice(0, 3)).toEqual(["sandbox-lock", "gateway-lock", "recovery-authority"]);
    expect(events).toContainEqual(expect.stringContaining("lost reservation ownership"));
    expect(checkGatewayRouteCompatibility).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("serializes pending setup, then warns and applies the next valid route (#6315)", async () => {
    const reservations: SandboxEntry[] = [];
    let rejectSmoke!: (reason?: unknown) => void;
    const smokePending = new Promise<void>((_resolve, reject) => {
      rejectSmoke = reject;
    });
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
        reservations.push({ name, pendingRouteReservation: true, ...route });
        return true;
      },
    );
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const verifyOnboardInferenceSmoke = vi
      .fn()
      .mockImplementationOnce(() => smokePending)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const error = vi.fn();
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
      verifyOnboardInferenceSmoke,
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
      bedrockRuntimeOnboard: {
        setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      openrouterRuntimeOnboard: {
        setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log,
      error,
      exitProcess,
    } as unknown as SetupInferenceDeps);

    const firstSetup = setupInference(
      "alpha",
      "model-a",
      "router-a",
      "http://router-a.test/v1",
      "ROUTER_KEY",
    );
    await vi.waitFor(() => expect(verifyOnboardInferenceSmoke).toHaveBeenCalledOnce());
    expect(reservations).toEqual([
      expect.objectContaining({
        name: "alpha",
        pendingRouteReservation: true,
        provider: "router-a",
        model: "model-a",
      }),
    ]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));

    const secondSetup = setupInference(
      "beta",
      "model-b",
      "router-b",
      "http://router-b.test/v1",
      "ROUTER_KEY",
    );
    const resultsPending = Promise.allSettled([firstSetup, secondSetup]);
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    rejectSmoke(new Error("smoke failed"));
    const results = await resultsPending;

    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "smoke failed" }) },
      { status: "fulfilled", value: { ok: true } },
    ]);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      provider: "router-a",
      model: "model-a",
      endpointUrl: "http://router-a.test/v1",
      credentialEnv: "ROUTER_KEY",
      preferredInferenceApi: null,
      gatewayName: "nemoclaw",
    });
    expect(reservations).toHaveLength(2);
    expect(updateSandbox).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Affected registered sandboxes: 'alpha'"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Inference route set: router-b / model-b"),
    );
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("stamps the owning onboard session on the initial route reservation (#6562)", async () => {
    const reservations: SandboxEntry[] = [];
    const updateSandbox = vi.fn(
      (name: string, route: Parameters<SetupInferenceDeps["updateSandbox"]>[1]) => {
        reservations.push({ name, ...route });
        return true;
      },
    );
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      runOpenshell: vi.fn(() => ({ status: 0 })),
      updateSandbox,
      upsertProvider: vi.fn(() => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(),
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
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "gamma",
        "model-c",
        "router-c",
        "http://router-c.test/v1",
        "ROUTER_KEY",
        null,
        [],
        { skipHostInferenceSmoke: true, reservationSessionId: "session-gamma" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(reservations).toEqual([
      expect.objectContaining({ name: "gamma", reservationSessionId: "session-gamma" }),
    ]);
  });
});
