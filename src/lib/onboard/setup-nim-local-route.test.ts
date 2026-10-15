// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim } from "./setup-nim-flow";

it("marks Local NIM as shared before its container starts", async () => {
  const routeGuard = vi.fn(() => ({
    requiredModel: null,
    requiredEndpointUrl: null,
    requiredInferenceApi: null,
  }));
  const setupNim = createSetupNim(
    makeDeps({
      experimental: true,
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim-local",
      detectInferenceProviderHostState: () => makeHostState({ gpuNimCapable: true }),
      handleNimLocalSelection: async (_gpu, _args, state) => {
        state.provider = "vllm-local";
        state.model = "local/nim-model";
        state.assertRouteCompatible?.();
        state.nimContainer = "local-nim-container";
        return "selected";
      },
    }),
  );

  const result = await setupNim(
    { type: "nvidia", platform: "other", nimCapable: true } as never,
    "nim-sandbox",
    null,
    false,
    null,
    "nemoclaw",
    routeGuard,
  );

  expect(routeGuard).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "vllm-local", localNimSelected: true }),
  );
  expect(result.nimContainer).toBe("local-nim-container");
});
