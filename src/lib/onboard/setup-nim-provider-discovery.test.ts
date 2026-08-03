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

describe("prepareProviderDiscovery", () => {
  it("loads the reviewed model when an interactive draft pins the provider (#6005)", () => {
    const getReviewedModel = vi.fn(() => "reviewed-model");
    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        getNonInteractiveProvider: () => "openrouter",
        getReviewedModel,
      },
      sandboxName: null,
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      canProbeRoute: () => true,
      recoverySessionId: null,
    });

    expect(result.requestedModel).toBe("reviewed-model");
    expect(getReviewedModel).toHaveBeenCalledWith("openrouter");
  });

  it("does not validate an ambient model before an interactive provider menu", () => {
    const getNonInteractiveModel = vi.fn(() => {
      throw new Error("ambient model must not be read");
    });
    const result = prepareProviderDiscovery({
      deps: {
        ...interactiveDeps,
        getNonInteractiveProvider: () => "openrouter",
        getNonInteractiveModel,
      },
      sandboxName: null,
      recoverProvider: false,
      rebuildRegistryInferenceRoute: null,
      canProbeRoute: () => true,
      recoverySessionId: null,
    });

    expect(result.requestedModel).toBeNull();
    expect(getNonInteractiveModel).not.toHaveBeenCalled();
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
