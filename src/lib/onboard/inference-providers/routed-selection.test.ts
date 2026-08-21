// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SetupNimSelectionState } from "../setup-nim-selection";
import { createRoutedSelectionHandler, type RoutedSelectionDeps } from "./routed-selection";

function state(): SetupNimSelectionState {
  return {
    model: null,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
  } as SetupNimSelectionState;
}

function deps(overrides: Partial<RoutedSelectionDeps> = {}): RoutedSelectionDeps {
  return {
    loadBlueprintProfile: () => ({
      provider_name: "nvidia-router",
      model: "router/model",
      endpoint: "http://127.0.0.1:4000/v1",
      credential_default: "nvapi-test",
      router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
    }),
    getHostGatewayUrl: () => "http://host.openshell.internal",
    defaultCredentialEnv: "NVIDIA_API_KEY",
    isNonInteractive: () => true,
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    hydrateCredentialEnv: () => null,
    normalizeCredentialValue: (value) => String(value),
    saveCredential: vi.fn(),
    stageRouterProviderKeyBridge: vi.fn(),
    resolveProviderCredential: () => "nvapi-test",
    ensureNamedCredential: vi.fn(async () => undefined),
    returningToProviderSelection: () => false,
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe("routed provider policy authority", () => {
  it("stops before the first routed credential mutation when authority changes (#9833)", async () => {
    const saveCredential = vi.fn();
    const stageRouterProviderKeyBridge = vi.fn();
    const ensureNamedCredential = vi.fn(async () => undefined);
    const selection = state();
    selection.revalidatePolicyRequirements = () => {
      throw new Error("external policy authority must supply the routed provider entry");
    };
    const handle = createRoutedSelectionHandler(
      deps({ saveCredential, stageRouterProviderKeyBridge, ensureNamedCredential }),
    );

    await expect(handle(selection)).rejects.toThrow(/external policy authority must supply/u);

    expect(saveCredential).not.toHaveBeenCalled();
    expect(stageRouterProviderKeyBridge).not.toHaveBeenCalled();
    expect(ensureNamedCredential).not.toHaveBeenCalled();
  });

  it("carries the exact route check through the interactive credential prompt (#9833)", async () => {
    const revalidatePolicyRequirements = vi.fn();
    const ensureNamedCredential = vi.fn(
      async (
        _name: string | null,
        _label: string,
        _helpUrl?: string | null,
        _validator?: ((value: string) => string | null) | null,
        _allowEmpty?: boolean,
        revalidate?: (operation: string) => void,
      ) => {
        await Promise.resolve();
        revalidate?.("save Model Router API key");
      },
    );
    const selection = state();
    selection.revalidatePolicyRequirements = revalidatePolicyRequirements;
    const handle = createRoutedSelectionHandler(
      deps({
        isNonInteractive: () => false,
        loadBlueprintProfile: () => ({
          provider_name: "nvidia-router",
          model: "router/model",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
        normalizeCredentialValue: () => "",
        resolveProviderCredential: () => null,
        ensureNamedCredential,
      }),
    );

    await expect(handle(selection)).resolves.toBe("selected");

    expect(ensureNamedCredential).toHaveBeenCalledWith(
      "NVIDIA_API_KEY",
      "Model Router API key",
      null,
      null,
      false,
      revalidatePolicyRequirements,
    );
    expect(revalidatePolicyRequirements).toHaveBeenCalledWith("save Model Router API key");
  });
});
