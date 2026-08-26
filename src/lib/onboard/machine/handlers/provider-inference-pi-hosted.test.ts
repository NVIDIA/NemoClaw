// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("Pi hosted inference selection", () => {
  it("keeps Pi on NVIDIA hosted inference without extending host-local support", async () => {
    const resolver = vi.fn(() => null);
    const { deps, calls } = createDeps({
      resolveHostLocalInferenceStartupSelection: resolver,
    });
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: { name: "pi" },
    });

    expect(resolver).not.toHaveBeenCalled();
    const setupCall = calls.setupInference.mock.calls[0] as unknown as readonly unknown[];
    expect(setupCall[7]).not.toHaveProperty("hostLocalInference");
    expect(result.hostLocalInferenceRouteOnly).toBe(false);
  });

  it("keeps Pi host-local inference outside the accepted application boundary", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "vllm-local",
      model: "pi-local-model",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const resolver = vi.fn(() => null);
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: resolver,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        agent: { name: "pi" },
      }),
    ).rejects.toThrow("Unsupported host-local inference application 'pi'.");

    expect(resolver).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
