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
    resolveRouterProviderKeyBridge: () => null,
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
  it.each([
    [
      "localhost without an explicit port",
      "http://localhost/v1/models?region=us-west#ready",
      "http://host.openshell.internal/v1/models?region=us-west#ready",
    ],
    [
      "localhost with every URL component",
      "https://localhost:443/v1/models?region=us-west#ready",
      "https://host.openshell.internal:443/v1/models?region=us-west#ready",
    ],
    [
      "IPv4 loopback with an explicit default port",
      "http://127.0.0.1:80/v1?mode=fast#models",
      "http://host.openshell.internal:80/v1?mode=fast#models",
    ],
    [
      "IPv6 loopback",
      "http://[::1]:4000/v1/chat/completions?stream=true#result",
      "http://host.openshell.internal:4000/v1/chat/completions?stream=true#result",
    ],
    [
      "a loopback-looking hostname",
      "https://localhost.example.com:444/v1?target=127.0.0.1#localhost",
      "https://localhost.example.com:444/v1?target=127.0.0.1#localhost",
    ],
    ["a noncanonical IPv4 spelling", "http://127.1:4000/v1", "http://127.1:4000/v1"],
  ])(
    "rewrites only %s while preserving the complete routed URL",
    async (_label, endpoint, expected) => {
      const selection = state();
      const handle = createRoutedSelectionHandler(
        deps({
          loadBlueprintProfile: () => ({
            provider_name: "nvidia-router",
            model: "router/model",
            endpoint,
            credential_default: "nvapi-test",
            router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
          }),
        }),
      );

      await expect(handle(selection)).resolves.toBe("selected");

      expect(selection.endpointUrl).toBe(expected);
    },
  );

  it("leaves an invalid routed endpoint for route validation (#9833)", async () => {
    const endpoint = "http://[::1";
    const selection = state();
    selection.assertRouteCompatible = vi.fn(() => {
      expect(selection.endpointUrl).toBe(endpoint);
      throw new Error("invalid routed endpoint");
    });
    const handle = createRoutedSelectionHandler(
      deps({
        loadBlueprintProfile: () => ({
          provider_name: "nvidia-router",
          model: "router/model",
          endpoint,
          credential_default: "nvapi-test",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
      }),
    );

    await expect(handle(selection)).rejects.toThrow("invalid routed endpoint");
    expect(selection.assertRouteCompatible).toHaveBeenCalledOnce();
  });

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
        return "nvapi-new";
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
        normalizeCredentialValue: (value) => String(value),
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

  it("does not stage routed credentials when non-interactive resolution fails (#9833)", async () => {
    const saveCredential = vi.fn();
    const stageRouterProviderKeyBridge = vi.fn();
    const revalidatePolicyRequirements = vi.fn();
    const selection = state();
    selection.revalidatePolicyRequirements = revalidatePolicyRequirements;
    const handle = createRoutedSelectionHandler(
      deps({
        loadBlueprintProfile: () => ({
          model: "router/model",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
        normalizeCredentialValue: () => "",
        resolveProviderCredential: () => null,
        saveCredential,
        stageRouterProviderKeyBridge,
      }),
    );

    await expect(handle(selection)).rejects.toThrow("exit 1");

    expect(saveCredential).not.toHaveBeenCalled();
    expect(stageRouterProviderKeyBridge).not.toHaveBeenCalled();
    expect(revalidatePolicyRequirements).not.toHaveBeenCalled();
  });

  it("does not stage routed credentials when the interactive prompt goes back (#9833)", async () => {
    const saveCredential = vi.fn();
    const stageRouterProviderKeyBridge = vi.fn();
    const selection = state();
    const handle = createRoutedSelectionHandler(
      deps({
        isNonInteractive: () => false,
        loadBlueprintProfile: () => ({
          model: "router/model",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
        normalizeCredentialValue: () => "",
        resolveProviderCredential: () => null,
        ensureNamedCredential: vi.fn(async () => ({ kind: "back" })),
        returningToProviderSelection: () => true,
        saveCredential,
        stageRouterProviderKeyBridge,
      }),
    );

    await expect(handle(selection)).resolves.toBe("retry-selection");

    expect(saveCredential).not.toHaveBeenCalled();
    expect(stageRouterProviderKeyBridge).not.toHaveBeenCalled();
  });

  it("revalidates before staging a resolved provider-key bridge (#9833)", async () => {
    const stageRouterProviderKeyBridge = vi.fn();
    const selection = state();
    selection.revalidatePolicyRequirements = () => {
      throw new Error("policy authority changed");
    };
    const handle = createRoutedSelectionHandler(
      deps({
        loadBlueprintProfile: () => ({
          model: "router/model",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
        normalizeCredentialValue: () => "",
        resolveProviderCredential: () => null,
        resolveRouterProviderKeyBridge: () => "nvapi-bridge",
        stageRouterProviderKeyBridge,
      }),
    );

    await expect(handle(selection)).rejects.toThrow("policy authority changed");

    expect(stageRouterProviderKeyBridge).not.toHaveBeenCalled();
  });

  it("stages the exact resolved provider-key bridge only after revalidation (#9833)", async () => {
    const events: string[] = [];
    const stageRouterProviderKeyBridge = vi.fn((_name, value) => {
      events.push(`stage:${value}`);
    });
    const selection = state();
    selection.revalidatePolicyRequirements = () => events.push("revalidate");
    const handle = createRoutedSelectionHandler(
      deps({
        loadBlueprintProfile: () => ({
          model: "router/model",
          router: { enabled: true, credential_env: "NVIDIA_API_KEY" },
        }),
        normalizeCredentialValue: () => "",
        resolveProviderCredential: () => null,
        resolveRouterProviderKeyBridge: () => {
          events.push("resolve:bridge");
          return "nvapi-bridge";
        },
        stageRouterProviderKeyBridge,
      }),
    );

    await expect(handle(selection)).resolves.toBe("selected");

    expect(events).toEqual(["resolve:bridge", "revalidate", "stage:nvapi-bridge"]);
    expect(stageRouterProviderKeyBridge).toHaveBeenCalledWith("NVIDIA_API_KEY", "nvapi-bridge");
  });
});
