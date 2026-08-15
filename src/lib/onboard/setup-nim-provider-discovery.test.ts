// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { prepareProviderDiscovery } from "./setup-nim-provider-discovery";

const interactiveDeps = {
  remoteProviderConfig: {},
  isNonInteractive: () => false,
  getNonInteractiveProvider: () => null,
  getNonInteractiveModel: () => null,
  readRecordedProvider: () => null,
  readRecordedNimContainer: () => null,
  readRecordedModel: () => null,
};

const rebuildProviderSwitchRoute = {
  sandboxName: "existing-sandbox",
  route: {
    provider: "nvidia-prod",
    model: "recorded-model",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    preferredInferenceApi: "openai-completions",
    source: "registry",
  },
} as const;

const remoteProviderConfig = {
  build: { providerName: "nvidia-prod" },
  openai: { providerName: "openai-api" },
};

describe("prepareProviderDiscovery", () => {
  it("does not read recorded provider state when recovery is disabled (#8135)", () => {
    const readRecordedProvider = vi.fn(() => "vllm-local");
    const readRecordedNimContainer = vi.fn(() => "stale-nim-container");
    const readRecordedModel = vi.fn(() => "stale-recorded-model");
    const getNonInteractiveModel = vi.fn((_providerKey, options) =>
      options?.allowProviderModelFallback === false ? null : "fallback-model",
    );

    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "vllm",
        getNonInteractiveModel,
        readRecordedProvider,
        readRecordedNimContainer,
        readRecordedModel,
      },
      sandboxName: "fresh-sandbox",
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      recoverySessionId: "stale-recovery-session",
    });

    expect(result.requestedModel).toBe("fallback-model");
    expect(getNonInteractiveModel).toHaveBeenCalledWith("vllm", {
      allowProviderModelFallback: true,
    });
    expect(readRecordedProvider).not.toHaveBeenCalled();
    expect(readRecordedNimContainer).not.toHaveBeenCalled();
    expect(readRecordedModel).not.toHaveBeenCalled();
  });

  it("omits NEMOCLAW_PROVIDER_MODEL for a same-sandbox rebuild provider switch (#8135)", () => {
    const readRecordedProvider = vi.fn(() => "openai-api");
    const getNonInteractiveModel = vi.fn((_providerKey, options) =>
      options?.allowProviderModelFallback === false ? null : "fallback-model",
    );

    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        remoteProviderConfig,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "openai",
        getNonInteractiveModel,
        readRecordedProvider,
      },
      sandboxName: "existing-sandbox",
      recoverProvider: true,
      rebuildRegistryInferenceRoute: rebuildProviderSwitchRoute,
      recoverySessionId: "recovery-session",
    });

    expect(result.requestedModel).toBeNull();
    expect(getNonInteractiveModel).toHaveBeenCalledWith("openai", {
      allowProviderModelFallback: false,
    });
    expect(readRecordedProvider).not.toHaveBeenCalled();
  });

  it("preserves NEMOCLAW_MODEL for a same-sandbox rebuild provider switch (#8135)", () => {
    const readRecordedProvider = vi.fn(() => "openai-api");
    const getNonInteractiveModel = vi.fn(() => "explicit-model");

    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        remoteProviderConfig,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "openai",
        getNonInteractiveModel,
        readRecordedProvider,
      },
      sandboxName: "existing-sandbox",
      recoverProvider: true,
      rebuildRegistryInferenceRoute: rebuildProviderSwitchRoute,
      recoverySessionId: "recovery-session",
    });

    expect(result.requestedModel).toBe("explicit-model");
    expect(getNonInteractiveModel).toHaveBeenCalledWith("openai", {
      allowProviderModelFallback: false,
    });
    expect(readRecordedProvider).not.toHaveBeenCalled();
  });

  it("classifies recorded Local NIM before comparing the requested provider (#8135)", () => {
    const readRecordedNimContainer = vi.fn(() => "nim-container");
    const prepare = (requestedProvider: string) =>
      prepareProviderDiscovery({
        deps: {
          ...interactiveDeps,
          isNonInteractive: () => true,
          getNonInteractiveProvider: () => requestedProvider,
          getNonInteractiveModel: (_providerKey, options) =>
            options?.allowProviderModelFallback === false ? null : "fallback-model",
          readRecordedProvider: () => "vllm-local",
          readRecordedNimContainer,
        },
        sandboxName: "existing-sandbox",
        recoverProvider: true,
        rebuildRegistryInferenceRoute: null,
        recoverySessionId: "recovery-session",
      });

    expect(prepare("vllm").requestedModel).toBeNull();
    expect(prepare("nim-local").requestedModel).toBe("fallback-model");
    expect(readRecordedNimContainer).toHaveBeenCalledWith("existing-sandbox", "recovery-session");
  });

  it("classifies recorded standalone vLLM before comparing the requested provider (#8135)", () => {
    const prepare = (requestedProvider: string) =>
      prepareProviderDiscovery({
        deps: {
          ...interactiveDeps,
          isNonInteractive: () => true,
          getNonInteractiveProvider: () => requestedProvider,
          getNonInteractiveModel: (_providerKey, options) =>
            options?.allowProviderModelFallback === false ? null : "fallback-model",
          readRecordedProvider: () => "vllm-local",
        },
        sandboxName: "existing-sandbox",
        recoverProvider: true,
        rebuildRegistryInferenceRoute: null,
        recoverySessionId: "recovery-session",
      });

    expect(prepare("nim-local").requestedModel).toBeNull();
    expect(prepare("vllm").requestedModel).toBe("fallback-model");
  });

  it("keeps local daemon probes on for the interactive menu when the route preflight reports a conflict (#6750)", () => {
    const result = prepareProviderDiscovery({
      deps: interactiveDeps,
      sandboxName: null,
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      canProbeRoute: () => false,
      recoverySessionId: null,
    });
    expect(result.probeOllama).toBe(true);
    expect(result.probeVllm).toBe(true);
  });

  it("keeps the route-conflict probe gate for non-interactive runs targeting a local provider", () => {
    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
      },
      sandboxName: null,
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      canProbeRoute: () => false,
      recoverySessionId: null,
    });
    expect(result.probeOllama).toBe(false);
  });

  it("probes local daemons non-interactively when the route preflight allows them", () => {
    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
      },
      sandboxName: null,
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      canProbeRoute: () => true,
      recoverySessionId: null,
    });
    expect(result.probeOllama).toBe(true);
  });
});
