// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeDeps, unexpected } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim } from "./setup-nim-flow";
import { prepareProviderDiscovery } from "./setup-nim-provider-discovery";

const interactiveDeps = {
  remoteProviderConfig: {},
  isNonInteractive: () => false,
  getNonInteractiveProvider: () => null,
  getNonInteractiveModel: () => null,
  readRecordedProvider: () => null,
  readRecordedNimContainer: () => null,
  readRecordedManagedLlamaCpp: () => false,
  readRecordedManagedLlamaCppRecipeId: () => null,
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

async function discoverPendingNvidiaModel(
  pendingNvidiaModel: { model: string } | null,
  deps: Parameters<typeof prepareProviderDiscovery>[0]["deps"],
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pending-nvidia-"));
  const { onTestFinished } = await import("vitest");
  onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  const session = await import("../state/onboard-session");
  const { prepareProviderDiscovery: discover } = await import("./setup-nim-provider-discovery");
  const sandboxName = "fresh-sandbox";
  session.saveSession(session.createSession({ sandboxName, pendingNvidiaModel }));
  const { sessionId } = session.markStepStarted("provider_selection");
  const result = discover({
    deps,
    sandboxName,
    recoverProvider: false,
    rebuildRegistryInferenceRoute: null,
    recoverySessionId: sessionId,
  });
  return { result, session };
}

describe("prepareProviderDiscovery", () => {
  it.each(["nvidia-router", "routed", "NVIDIA_ROUTER"])(
    "rejects recovered retired provider %s before host probing or selection",
    async (provider) => {
      const detectInferenceProviderHostState = vi.fn(() => unexpected("host probe"));
      const handleRemoteProviderSelection = vi.fn(async () => unexpected("provider selection"));
      const setupNim = createSetupNim(
        makeDeps({
          isNonInteractive: () => true,
          readRecordedProvider: () => provider,
          detectInferenceProviderHostState,
          handleRemoteProviderSelection,
        }),
      );
      await expect(setupNim(null, "legacy")).rejects.toThrow("Model Router has been removed");
      expect(detectInferenceProviderHostState).not.toHaveBeenCalled();
      expect(handleRemoteProviderSelection).not.toHaveBeenCalled();
    },
  );

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

  it("resumes a gateway-constrained NVIDIA model without an explicit model request", async () => {
    const { result } = await discoverPendingNvidiaModel(
      { model: "nvidia/constrained" },
      {
        ...interactiveDeps,
        isNonInteractive: () => true,
      },
    );
    expect(result.requestedModel).toBeNull();
    expect(result.resumedNvidiaModel).toEqual({ model: "nvidia/constrained" });
  });

  it.each([
    { nonInteractive: false, explicitModel: undefined },
    { nonInteractive: true, explicitModel: undefined },
    { nonInteractive: true, explicitModel: "openai/explicit" },
  ])(
    "ignores the pending NVIDIA choice while discovering a different provider (non-interactive $nonInteractive, explicit model $explicitModel)",
    async ({ nonInteractive, explicitModel }) => {
      vi.stubEnv("NEMOCLAW_MODEL", explicitModel);
      vi.stubEnv("NEMOCLAW_PROVIDER_MODEL", "nvidia/stale");
      const { getNonInteractiveModel } = require("./providers");
      const { result, session } = await discoverPendingNvidiaModel(null, {
        ...interactiveDeps,
        isNonInteractive: () => nonInteractive,
        getNonInteractiveProvider: () => "openai",
        getNonInteractiveModel,
      });

      expect(result.requestedProvider).toBe("openai");
      expect(result.requestedModel).toBe(explicitModel ?? null);
      expect(result.resumedNvidiaModel).toBeUndefined();
      expect(session.loadSession()?.pendingNvidiaModel).toBeNull();
    },
  );

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
