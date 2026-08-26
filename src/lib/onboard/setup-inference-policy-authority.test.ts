// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

const refuseAuthorityChange = (): never => {
  throw new Error("authority changed");
};

function createSetupDeps(): SetupInferenceDeps {
  return {
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step: vi.fn(),
    getGatewayName: () => "nemoclaw",
    runOpenshell: vi.fn((args: string[]) =>
      args.includes("export")
        ? {
            status: 1,
            stdout: "",
            stderr: "Error: status: 'NotFound', message: \"provider profile not found\"",
          }
        : { status: 0, stdout: "", stderr: "" },
    ),
    updateSandbox: vi.fn(() => true),
    upsertProvider: vi.fn(() => ({ ok: true as const })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    resolveEndpointHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    isNonInteractive: () => true,
    isRoutedInferenceProvider: () => false,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    REMOTE_PROVIDER_CONFIG: {
      custom: {
        label: "Compatible endpoint",
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://endpoint.example/v1",
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
      throw new Error(`exit ${String(code)}`);
    }),
  } as unknown as SetupInferenceDeps;
}

describe("onboard inference policy authority mutation edges", () => {
  it("rejects sandbox-bound setup without an authority revalidation callback (#9833)", async () => {
    const deps = createSetupDeps();

    await expect(
      createSetupInference(deps)(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
      ),
    ).rejects.toThrow("Sandbox inference setup requires policy authority revalidation.");

    expect(deps.checkGatewayRouteCompatibility).not.toHaveBeenCalled();
    expect(deps.upsertProvider).not.toHaveBeenCalled();
  });

  it("withholds success when authority changes after inference smoke (#9833)", async () => {
    const deps = createSetupDeps();

    await expect(
      createSetupInference(deps)(
        "sandbox-a",
        "model-a",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation === "report successful inference provider setup"
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(deps.verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));
  });

  it("withholds success when authority changes before superseded Ollama cleanup (#9833)", async () => {
    const deps = createSetupDeps();
    deps.getSandbox = vi.fn(() => ({
      name: "sandbox-a",
      provider: "ollama-local",
      model: "old-model",
    })) as SetupInferenceDeps["getSandbox"];
    deps.listSandboxes = vi.fn(() => ({
      defaultSandbox: "sandbox-a",
      sandboxes: [{ name: "sandbox-a", provider: "ollama-local", model: "old-model" }],
    })) as unknown as SetupInferenceDeps["listSandboxes"];
    deps.withOllamaModelOwnershipLock = (operation) => operation();
    deps.unloadOllamaModels = vi.fn();

    await expect(
      createSetupInference(deps)(
        "sandbox-a",
        "new-model",
        "compatible-endpoint",
        "https://endpoint.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        {
          endpointPinnedAddresses: ["93.184.216.34"],
          revalidatePolicyRequirements: (operation) =>
            operation === "release the superseded Ollama model"
              ? refuseAuthorityChange()
              : undefined,
        },
      ),
    ).rejects.toThrow("authority changed");

    expect(deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Inference route set"));
  });
});
